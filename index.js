/**
 * ============================================================================
 *  MCRP — All-in-one Discord management bot
 * ============================================================================
 *
 *  SETUP (this is the ONLY thing you ever need to touch):
 *    1. npm install
 *    2. Create a file named ".env" (use .env.example as a template) with:
 *         BOT_TOKEN=your_bot_token
 *         CLIENT_ID=your_application_client_id
 *    3. node index.js
 *
 *  Everything else (guild ID, panel channel, staff roles, ticket category,
 *  log channels, application questions, etc.) is either hardcoded below
 *  (per your spec) or configurable in-Discord with the /config command —
 *  you never have to open this file again after first run.
 *
 *  Data is persisted to ./mcrp-database.json (auto-created). Delete it to
 *  reset the bot's memory. Do not edit it by hand while the bot is running.
 * ============================================================================
 */

'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');

// ============================================================================
// 0. HARDCODED SERVER CONSTANTS (as specified — never needs to be edited)
// ============================================================================

const GUILD_ID = '1551304865232191498';
const PANEL_CHANNEL_ID = '1551304865798688871'; // where panels auto-spawn
const BRAND_COLOR = 0x5865f2;
const BRAND_FOOTER = 'MCRP System';

// ============================================================================
// 1. TINY JSON DATABASE (no external DB needed — fine for a single guild)
// ============================================================================

const DB_PATH = path.join(__dirname, 'mcrp-database.json');

function defaultDB() {
  return {
    panels: { ticket: null, applications: {} }, // message IDs so we never duplicate
    config: {
      ticketCategoryId: null,
      ticketLogChannelId: null,
      modLogChannelId: null,
      staffRoleId: null,
      giveawayLogChannelId: null,
    },
    ticketCounter: 0,
    tickets: {}, // channelId -> {userId, claimedBy, status, createdAt, number}
    automod: {
      enabled: true,
      words: [],
      timeoutMinutes: 10,
      whitelistRoleIds: [],
      offenses: {}, // userId -> count
    },
    giveaways: {}, // messageId -> {channelId, prize, endsAt, winnersCount, entries:[], ended}
    applications: {
      tracks: {}, // trackName -> {questions:[], reviewChannelId, roleId, closed, cooldownDays}
      submissions: {}, // id -> {...}
      submissionCounter: 0,
      cooldowns: {}, // `${track}:${userId}` -> timestamp
      pending: {}, // `${track}:${userId}` -> true while mid-questionnaire
    },
    staff: {
      history: {}, // userId -> [{type, role, reason, by, at}]
    },
    infractions: {
      byUser: {}, // userId -> [{id, reason, severity, by, at}]
      counter: 0,
    },
    feedback: {}, // staffId -> [{rating, comment, anon, submitterId, at}]
  };
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = defaultDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // shallow-merge so new fields added in future updates don't crash old DBs
  return { ...defaultDB(), ...raw };
}

let db = loadDB();
function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ============================================================================
// 2. CLIENT
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ============================================================================
// 3. SMALL HELPERS
// ============================================================================

function brandEmbed() {
  return new EmbedBuilder().setColor(BRAND_COLOR).setFooter({ text: BRAND_FOOTER });
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const staffRoleId = db.config.staffRoleId;
  return staffRoleId ? member.roles.cache.has(staffRoleId) : false;
}

function parseDuration(str) {
  // supports 30s, 10m, 2h, 1d
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(str.trim());
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

function normalizeForFilter(str) {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, ''); // strips spaces/punctuation to catch "b a d w o r d"
}

async function logToChannel(channelId, embed) {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch) await ch.send({ embeds: [embed] });
  } catch {
    /* channel missing/no perms — ignore */
  }
}

function randomWinners(pool, count) {
  const copy = [...pool];
  const picked = [];
  while (copy.length && picked.length < count) {
    const i = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(i, 1)[0]);
  }
  return picked;
}

// ============================================================================
// 4. TICKET SYSTEM
// ============================================================================
//
//  Flow:
//   1. /ticket panel posts an embed with an "Open Ticket" button in the
//      current channel (also auto-spawned on startup in PANEL_CHANNEL_ID).
//   2. Clicking it creates a private channel: only the member + staff role
//      (db.config.staffRoleId, if set) can see it.
//   3. The channel name always carries a status ball:
//        🔴 ticket-username   = not yet claimed
//        🟢 ticket-username   = claimed by a staff member
//      This is your suggestion — implemented exactly as described.
//   4. Claim / Close / Transcript buttons live inside the ticket channel.
//   5. Closing DMs a full transcript to the opener and posts it to the
//      ticket log channel if one is configured.
// ============================================================================

function ticketPanelEmbed() {
  return brandEmbed()
    .setTitle('🎫 Support Tickets')
    .setDescription(
      'Need help, want to report something, or have a question for staff?\n' +
        'Click **Open Ticket** below and a private channel will be created just for you and the staff team.'
    );
}

function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mcrp_open_ticket').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
  );
}

function ticketChannelName(username, claimed) {
  const ball = claimed ? '🟢' : '🔴';
  return `ticket-${ball}-${username}`.toLowerCase().slice(0, 90);
}

function ticketControlRow(claimed) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mcrp_ticket_claim')
      .setLabel(claimed ? 'Claimed' : 'Claim')
      .setEmoji('✋')
      .setStyle(ButtonStyle.Success)
      .setDisabled(claimed),
    new ButtonBuilder().setCustomId('mcrp_ticket_close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('mcrp_ticket_transcript').setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary)
  );
}

async function createTicket(interaction, reasonTag = null) {
  const guild = interaction.guild;
  const member = interaction.member;

  const existing = Object.entries(db.tickets).find(
    ([, t]) => t.userId === member.id && t.status === 'open'
  );
  if (existing) {
    return interaction.reply({ content: `You already have an open ticket: <#${existing[0]}>`, ephemeral: true });
  }

  db.ticketCounter += 1;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (db.config.staffRoleId) {
    overwrites.push({
      id: db.config.staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: ticketChannelName(member.user.username, false),
    type: ChannelType.GuildText,
    parent: db.config.ticketCategoryId || undefined,
    permissionOverwrites: overwrites,
    topic: `Ticket #${db.ticketCounter} • opened by ${member.user.tag}${reasonTag ? ` • ${reasonTag}` : ''}`,
  });

  db.tickets[channel.id] = {
    userId: member.id,
    claimedBy: null,
    status: 'open',
    number: db.ticketCounter,
    createdAt: Date.now(),
  };
  saveDB();

  const welcome = brandEmbed()
    .setTitle(`Ticket #${db.ticketCounter}`)
    .setDescription(`Hey ${member}, welcome to your ticket! A staff member will be with you shortly.\n\n**Status:** 🔴 Not claimed`)
    .setTimestamp();

  await channel.send({ content: `${member} ${db.config.staffRoleId ? `<@&${db.config.staffRoleId}>` : ''}`, embeds: [welcome], components: [ticketControlRow(false)] });

  return interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
}

async function claimTicket(interaction) {
  const ticket = db.tickets[interaction.channel.id];
  if (!ticket) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
  if (ticket.claimedBy) return interaction.reply({ content: 'This ticket is already claimed.', ephemeral: true });

  ticket.claimedBy = interaction.user.id;
  saveDB();

  const opener = await client.users.fetch(ticket.userId).catch(() => null);
  await interaction.channel.setName(ticketChannelName(opener?.username || 'user', true)).catch(() => {});

  const updated = brandEmbed()
    .setTitle(`Ticket #${ticket.number}`)
    .setDescription(`**Status:** 🟢 Claimed by ${interaction.user}`)
    .setTimestamp();

  await interaction.update({ embeds: [updated], components: [ticketControlRow(true)] });
}

async function buildTranscript(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const sorted = [...messages.values()].reverse();
  const lines = sorted.map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || '[embed/attachment]'}`);
  return Buffer.from(lines.join('\n') || 'No messages.', 'utf8');
}

async function closeTicket(interaction) {
  const ticket = db.tickets[interaction.channel.id];
  if (!ticket) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });

  await interaction.reply({ content: 'Closing ticket and generating transcript…', ephemeral: true });

  const buffer = await buildTranscript(interaction.channel);
  const file = new AttachmentBuilder(buffer, { name: `ticket-${ticket.number}-transcript.txt` });

  const opener = await client.users.fetch(ticket.userId).catch(() => null);
  if (opener) {
    await opener
      .send({ content: `Your ticket #${ticket.number} was closed. Here is the transcript:`, files: [file] })
      .catch(() => {});
  }
  if (db.config.ticketLogChannelId) {
    await logToChannel(db.config.ticketLogChannelId, brandEmbed().setTitle(`Ticket #${ticket.number} closed`).setDescription(`Opened by <@${ticket.userId}>\nClosed by <@${interaction.user.id}>`));
    try {
      const logCh = await client.channels.fetch(db.config.ticketLogChannelId);
      await logCh.send({ files: [new AttachmentBuilder(buffer, { name: `ticket-${ticket.number}-transcript.txt` })] });
    } catch {}
  }

  ticket.status = 'closed';
  saveDB();
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ============================================================================
// 5. AUTOMOD (bad word system)
// ============================================================================
//
//  Flow: message scanned (fuzzy, ignoring spaces/punctuation/case) against
//  db.automod.words -> deleted -> offender timed out (duration scales with
//  offense count) -> DM explaining what happened -> logged to modLogChannel.
// ============================================================================

function punishmentMinutesFor(offenseCount, base) {
  if (offenseCount <= 1) return 0; // 1st offense = warning only, no timeout
  if (offenseCount === 2) return base;
  if (offenseCount === 3) return base * 6;
  return Math.min(base * 24, 40320); // cap at 28 days (Discord's max timeout)
}

async function handleAutomod(message) {
  if (!db.automod.enabled) return;
  if (message.author.bot || !message.guild) return;
  const member = message.member;
  if (!member) return;
  if (isStaff(member)) return;
  if (db.automod.whitelistRoleIds.some((r) => member.roles.cache.has(r))) return;

  const normalizedMsg = normalizeForFilter(message.content);
  const hit = db.automod.words.find((w) => normalizedMsg.includes(normalizeForFilter(w)));
  if (!hit) return;

  await message.delete().catch(() => {});

  const count = (db.automod.offenses[member.id] || 0) + 1;
  db.automod.offenses[member.id] = count;
  const minutes = punishmentMinutesFor(count, db.automod.timeoutMinutes);
  saveDB();

  if (minutes > 0) {
    await member.timeout(minutes * 60 * 1000, 'Automod: blacklisted word').catch(() => {});
  }

  const dm = brandEmbed()
    .setTitle('⚠️ Message Removed')
    .setDescription(
      `Your message in **${message.guild.name}** was removed for containing a blocked word or phrase.\n\n` +
        (minutes > 0
          ? `You have been timed out for **${minutes} minute(s)**.`
          : `This is a warning — repeated violations will result in a timeout.`) +
        `\n\nThink this was a mistake? Open a ticket in the server to appeal.`
    );
  await member.send({ embeds: [dm] }).catch(() => {});

  await logToChannel(
    db.config.modLogChannelId,
    brandEmbed()
      .setTitle('Automod Action')
      .setDescription(`**User:** ${member} (${member.id})\n**Offense #:** ${count}\n**Timeout:** ${minutes > 0 ? `${minutes}m` : 'none (warning)'}\n**Channel:** ${message.channel}`)
      .setTimestamp()
  );
}

// ============================================================================
// 6. GIVEAWAYS
// ============================================================================

function giveawayEmbed(g, ended = false, winners = []) {
  const e = brandEmbed()
    .setTitle(ended ? '🎉 Giveaway Ended' : '🎉 Giveaway')
    .addFields(
      { name: 'Prize', value: g.prize, inline: true },
      { name: 'Winners', value: String(g.winnersCount), inline: true },
      { name: 'Entries', value: String(g.entries.length), inline: true }
    );
  if (!ended) {
    e.setDescription(`Click 🎉 below to enter!\nEnds <t:${Math.floor(g.endsAt / 1000)}:R>`);
  } else {
    e.setDescription(winners.length ? `Winner(s): ${winners.map((w) => `<@${w}>`).join(', ')}` : 'No valid entries — no winner.');
  }
  return e;
}

function giveawayRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mcrp_giveaway_enter').setLabel('Enter Giveaway').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(disabled)
  );
}

async function endGiveaway(messageId, isReroll = false) {
  const g = db.giveaways[messageId];
  if (!g) return null;
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;

  const pool = isReroll ? g.entries.filter((id) => !(g.lastWinners || []).includes(id)) : g.entries;
  const winners = randomWinners(pool, g.winnersCount);

  g.ended = true;
  g.lastWinners = winners;
  saveDB();

  if (message) {
    await message.edit({ embeds: [giveawayEmbed(g, true, winners)], components: [giveawayRow(true)] }).catch(() => {});
  }

  for (const winnerId of winners) {
    const user = await client.users.fetch(winnerId).catch(() => null);
    if (!user) continue;
    const dm = brandEmbed()
      .setTitle('🎉 You Won!')
      .setDescription(`Congratulations! You won **${g.prize}**.\nClick below to claim your prize — this will open a private ticket with staff.`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mcrp_giveaway_claim').setLabel('Claim Prize').setEmoji('🏆').setStyle(ButtonStyle.Success)
    );
    await user.send({ embeds: [dm], components: [row] }).catch(() => {});
  }

  await logToChannel(
    db.config.giveawayLogChannelId,
    brandEmbed().setTitle('Giveaway Ended').setDescription(`**Prize:** ${g.prize}\n**Winners:** ${winners.map((w) => `<@${w}>`).join(', ') || 'none'}`)
  );

  return winners;
}

// background loop: auto-end giveaways whose timer has passed
setInterval(async () => {
  const now = Date.now();
  for (const [id, g] of Object.entries(db.giveaways)) {
    if (!g.ended && g.endsAt <= now) {
      await endGiveaway(id).catch(() => {});
    }
  }
}, 15000);

// ============================================================================
// 7. APPLICATION SYSTEM (interactive DM questionnaire)
// ============================================================================
//
//  Flow:
//   1. Staff configures a "track" with /application setup (name, review
//      channel, optional auto-accept role) then a modal to paste questions,
//      one per line.
//   2. /application panel <track> posts an embed with an Apply button.
//   3. Click -> bot DMs "Ready?" button.
//   4. Click Ready -> bot sends question 1. User must reply with a message
//      (not a button) for the bot to send question 2, and so on.
//   5. All answers compiled into an embed posted to the review channel with
//      Accept / Deny / Interview buttons.
//   6. Applicant is DMed the outcome. Accept can auto-assign a role.
// ============================================================================

function applicationPanelEmbed(track) {
  return brandEmbed()
    .setTitle(`📋 ${track} Applications`)
    .setDescription(`Interested in becoming ${/^[aeiou]/i.test(track) ? 'an' : 'a'} **${track}**?\nClick **Apply Now** below to start your application in DMs.`);
}

function applicationPanelRow(track) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mcrp_apply_${track}`).setLabel('Apply Now').setEmoji('📋').setStyle(ButtonStyle.Primary)
  );
}

async function runQuestionnaire(user, track, questions) {
  const dm = await user.createDM();
  const answers = [];

  for (let i = 0; i < questions.length; i++) {
    await dm.send({ content: `**Question ${i + 1} of ${questions.length}:**\n${questions[i]}` });
    try {
      const collected = await dm.awaitMessages({
        filter: (m) => m.author.id === user.id,
        max: 1,
        time: 10 * 60 * 1000, // 10 minutes per question
        errors: ['time'],
      });
      answers.push(collected.first().content);
    } catch {
      await dm.send('⌛ You took too long to respond. Your application has been cancelled — feel free to start again anytime.');
      return null;
    }
  }
  return answers;
}

async function reviewDecisionRow(submissionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mcrp_appdecision_accept_${submissionId}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mcrp_appdecision_deny_${submissionId}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mcrp_appdecision_interview_${submissionId}`).setLabel('Interview').setEmoji('🗣️').setStyle(ButtonStyle.Secondary)
  );
}

// ============================================================================
// 8. SLASH COMMAND DEFINITIONS
// ============================================================================

const commands = [
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system')
    .addSubcommand((s) => s.setName('panel').setDescription('Post the ticket panel in this channel'))
    .addSubcommand((s) => s.setName('close').setDescription('Close the current ticket'))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim the current ticket'))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a user to this ticket').addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a user from this ticket').addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('rename').setDescription('Rename this ticket').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Bad word / auto-moderation system')
    .addSubcommand((s) => s.setName('addword').setDescription('Blacklist a word').addStringOption((o) => o.setName('word').setDescription('Word/phrase').setRequired(true)))
    .addSubcommand((s) => s.setName('removeword').setDescription('Remove a blacklisted word').addStringOption((o) => o.setName('word').setDescription('Word/phrase').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List blacklisted words'))
    .addSubcommand((s) => s.setName('setduration').setDescription('Set base timeout (minutes)').addIntegerOption((o) => o.setName('minutes').setDescription('Minutes').setRequired(true)))
    .addSubcommand((s) => s.setName('toggle').setDescription('Enable/disable automod'))
    .addSubcommand((s) => s.setName('whitelist').setDescription('Whitelist a role from filtering').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaway system')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('Prize').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners').setRequired(true))
    )
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway early').addStringOption((o) => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Reroll winners').addStringOption((o) => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List active giveaways')),

  new SlashCommandBuilder()
    .setName('application')
    .setDescription('Application system')
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Create/update an application track (opens a modal for questions)')
        .addStringOption((o) => o.setName('track').setDescription('Track name, e.g. Staff').setRequired(true))
        .addChannelOption((o) => o.setName('review_channel').setDescription('Where submissions are reviewed').setRequired(true))
        .addRoleOption((o) => o.setName('accept_role').setDescription('Role to auto-assign on accept').setRequired(false))
    )
    .addSubcommand((s) => s.setName('panel').setDescription('Post the apply panel for a track').addStringOption((o) => o.setName('track').setDescription('Track name').setRequired(true)))
    .addSubcommand((s) => s.setName('review').setDescription('View a submitted application').addStringOption((o) => o.setName('id').setDescription('Submission ID').setRequired(true)))
    .addSubcommand((s) => s.setName('close').setDescription('Close/open a track').addStringOption((o) => o.setName('track').setDescription('Track name').setRequired(true))),

  new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Staff promotion system')
    .addSubcommand((s) =>
      s
        .setName('promote')
        .setDescription('Promote a staff member')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addRoleOption((o) => o.setName('new_rank').setDescription('New rank role').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('demote')
        .setDescription('Demote a staff member')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addRoleOption((o) => o.setName('new_rank').setDescription('New rank role').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true))
    )
    .addSubcommand((s) => s.setName('history').setDescription('View promotion history').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))),

  new SlashCommandBuilder()
    .setName('infraction')
    .setDescription('Infraction system')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Issue an infraction')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true))
        .addStringOption((o) =>
          o.setName('severity').setDescription('Severity').setRequired(true).addChoices({ name: 'Low', value: 'Low' }, { name: 'Medium', value: 'Medium' }, { name: 'High', value: 'High' })
        )
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove an infraction')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption((o) => o.setName('id').setDescription('Infraction ID').setRequired(true))
    )
    .addSubcommand((s) => s.setName('history').setDescription('View infraction history').addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))),

  new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Staff feedback')
    .addSubcommand((s) =>
      s
        .setName('submit')
        .setDescription('Submit feedback about a staff member')
        .addUserOption((o) => o.setName('staff').setDescription('Staff member').setRequired(true))
        .addIntegerOption((o) => o.setName('rating').setDescription('1-5').setRequired(true).setMinValue(1).setMaxValue(5))
        .addStringOption((o) => o.setName('comment').setDescription('Comment').setRequired(true))
    )
    .addSubcommand((s) => s.setName('view').setDescription('View feedback for a staff member').addUserOption((o) => o.setName('staff').setDescription('Staff member').setRequired(true)))
    .addSubcommand((s) => s.setName('leaderboard').setDescription('Top-rated staff')),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure MCRP (no code editing needed)')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set server configuration values')
        .addChannelOption((o) => o.setName('ticket_category').setDescription('Category for new tickets').setRequired(false))
        .addChannelOption((o) => o.setName('ticket_log').setDescription('Channel for ticket transcripts').setRequired(false))
        .addChannelOption((o) => o.setName('mod_log').setDescription('Channel for automod/infraction logs').setRequired(false))
        .addChannelOption((o) => o.setName('giveaway_log').setDescription('Channel for giveaway results').setRequired(false))
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role considered "staff"').setRequired(false))
    ),

  new SlashCommandBuilder().setName('help').setDescription('Show all MCRP commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show server info'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show user info').addUserOption((o) => o.setName('user').setDescription('User').setRequired(false)),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`✅ Registered ${commands.length} slash commands.`);
}

// ============================================================================
// 9. AUTO-SPAWN PANELS ON STARTUP (never duplicates)
// ============================================================================

async function ensureTicketPanel() {
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) return console.warn('⚠️ PANEL_CHANNEL_ID not found — cannot spawn ticket panel.');

  if (db.panels.ticket) {
    const existing = await channel.messages.fetch(db.panels.ticket).catch(() => null);
    if (existing) return; // already there — do nothing
  }
  const msg = await channel.send({ embeds: [ticketPanelEmbed()], components: [ticketPanelRow()] });
  db.panels.ticket = msg.id;
  saveDB();
  console.log('🎫 Ticket panel spawned.');
}

async function ensureApplicationPanels() {
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  for (const [track, cfg] of Object.entries(db.applications.tracks)) {
    const existingId = db.panels.applications[track];
    if (existingId) {
      const existing = await channel.messages.fetch(existingId).catch(() => null);
      if (existing) continue;
    }
    const msg = await channel.send({ embeds: [applicationPanelEmbed(track)], components: [applicationPanelRow(track)] });
    db.panels.applications[track] = msg.id;
    saveDB();
    console.log(`📋 Application panel spawned for track "${track}".`);
  }
}

// ============================================================================
// 10. READY EVENT
// ============================================================================

client.once(Events.ClientReady, async () => {
  console.log(`✅ MCRP is now online as ${client.user.tag}`);
  await registerCommands();
  await ensureTicketPanel();
  await ensureApplicationPanels();
});

// ============================================================================
// 11. MESSAGE HANDLER (automod)
// ============================================================================

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleAutomod(message);
  } catch (err) {
    console.error('Automod error:', err);
  }
});

// ============================================================================
// 12. INTERACTION HANDLER
// ============================================================================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---------- SLASH COMMANDS ----------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // ===== /ticket =====
      if (commandName === 'ticket') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'panel') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          await interaction.channel.send({ embeds: [ticketPanelEmbed()], components: [ticketPanelRow()] });
          return interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
        }
        if (sub === 'claim') return claimTicket(interaction);
        if (sub === 'close') return closeTicket(interaction);
        if (sub === 'add' || sub === 'remove') {
          const ticket = db.tickets[interaction.channel.id];
          if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const user = interaction.options.getUser('user');
          if (sub === 'add') {
            await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true });
            return interaction.reply({ content: `${user} added to the ticket.` });
          } else {
            await interaction.channel.permissionOverwrites.delete(user.id);
            return interaction.reply({ content: `${user} removed from the ticket.` });
          }
        }
        if (sub === 'rename') {
          const ticket = db.tickets[interaction.channel.id];
          if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const ball = ticket.claimedBy ? '🟢' : '🔴';
          const name = interaction.options.getString('name');
          await interaction.channel.setName(`ticket-${ball}-${name}`.toLowerCase());
          return interaction.reply({ content: 'Renamed.', ephemeral: true });
        }
      }

      // ===== /automod =====
      if (commandName === 'automod') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'addword') {
          const word = interaction.options.getString('word');
          db.automod.words.push(word);
          saveDB();
          return interaction.reply({ content: `Added \`${word}\` to the blacklist.`, ephemeral: true });
        }
        if (sub === 'removeword') {
          const word = interaction.options.getString('word');
          db.automod.words = db.automod.words.filter((w) => w.toLowerCase() !== word.toLowerCase());
          saveDB();
          return interaction.reply({ content: `Removed \`${word}\`.`, ephemeral: true });
        }
        if (sub === 'list') {
          return interaction.reply({ content: db.automod.words.length ? db.automod.words.map((w) => `\`${w}\``).join(', ') : 'No words blacklisted.', ephemeral: true });
        }
        if (sub === 'setduration') {
          db.automod.timeoutMinutes = interaction.options.getInteger('minutes');
          saveDB();
          return interaction.reply({ content: `Base timeout set to ${db.automod.timeoutMinutes} minute(s).`, ephemeral: true });
        }
        if (sub === 'toggle') {
          db.automod.enabled = !db.automod.enabled;
          saveDB();
          return interaction.reply({ content: `Automod is now **${db.automod.enabled ? 'ON' : 'OFF'}**.`, ephemeral: true });
        }
        if (sub === 'whitelist') {
          const role = interaction.options.getRole('role');
          db.automod.whitelistRoleIds.push(role.id);
          saveDB();
          return interaction.reply({ content: `${role} whitelisted from automod.`, ephemeral: true });
        }
      }

      // ===== /giveaway =====
      if (commandName === 'giveaway') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'create') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const prize = interaction.options.getString('prize');
          const durationStr = interaction.options.getString('duration');
          const winnersCount = interaction.options.getInteger('winners');
          const ms = parseDuration(durationStr);
          if (!ms) return interaction.reply({ content: 'Invalid duration. Use formats like 10m, 1h, 1d.', ephemeral: true });

          const g = { channelId: interaction.channel.id, prize, endsAt: Date.now() + ms, winnersCount, entries: [], ended: false };
          const msg = await interaction.channel.send({ embeds: [giveawayEmbed(g)], components: [giveawayRow()] });
          db.giveaways[msg.id] = g;
          saveDB();
          return interaction.reply({ content: `Giveaway started: ${msg.url}`, ephemeral: true });
        }
        if (sub === 'end') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const id = interaction.options.getString('message_id');
          if (!db.giveaways[id]) return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
          await endGiveaway(id);
          return interaction.reply({ content: 'Giveaway ended.', ephemeral: true });
        }
        if (sub === 'reroll') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const id = interaction.options.getString('message_id');
          if (!db.giveaways[id]) return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
          const winners = await endGiveaway(id, true);
          return interaction.reply({ content: `New winner(s): ${winners.map((w) => `<@${w}>`).join(', ') || 'none'}`, ephemeral: true });
        }
        if (sub === 'list') {
          const active = Object.entries(db.giveaways).filter(([, g]) => !g.ended);
          if (!active.length) return interaction.reply({ content: 'No active giveaways.', ephemeral: true });
          const desc = active.map(([id, g]) => `**${g.prize}** — ends <t:${Math.floor(g.endsAt / 1000)}:R> — ID: \`${id}\``).join('\n');
          return interaction.reply({ embeds: [brandEmbed().setTitle('Active Giveaways').setDescription(desc)], ephemeral: true });
        }
      }

      // ===== /application =====
      if (commandName === 'application') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'setup') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const track = interaction.options.getString('track');
          const reviewChannel = interaction.options.getChannel('review_channel');
          const acceptRole = interaction.options.getRole('accept_role');

          db.applications.tracks[track] = db.applications.tracks[track] || { questions: [], closed: false, cooldownDays: 7 };
          db.applications.tracks[track].reviewChannelId = reviewChannel.id;
          if (acceptRole) db.applications.tracks[track].roleId = acceptRole.id;
          saveDB();

          const modal = new ModalBuilder().setCustomId(`mcrp_appquestions_${track}`).setTitle(`Questions for ${track}`);
          const input = new TextInputBuilder()
            .setCustomId('questions')
            .setLabel('One question per line')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setValue((db.applications.tracks[track].questions || []).join('\n'));
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }
        if (sub === 'panel') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const track = interaction.options.getString('track');
          if (!db.applications.tracks[track]) return interaction.reply({ content: `Track "${track}" doesn't exist yet — use /application setup first.`, ephemeral: true });
          const msg = await interaction.channel.send({ embeds: [applicationPanelEmbed(track)], components: [applicationPanelRow(track)] });
          db.panels.applications[track] = msg.id;
          saveDB();
          return interaction.reply({ content: 'Application panel posted.', ephemeral: true });
        }
        if (sub === 'review') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const id = interaction.options.getString('id');
          const sub2 = db.applications.submissions[id];
          if (!sub2) return interaction.reply({ content: 'Submission not found.', ephemeral: true });
          const embed = brandEmbed()
            .setTitle(`Application #${id} — ${sub2.track}`)
            .setDescription(`Applicant: <@${sub2.userId}>\nStatus: ${sub2.status}`)
            .addFields(sub2.questions.map((q, i) => ({ name: q.slice(0, 256), value: sub2.answers[i]?.slice(0, 1024) || '-' })));
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        if (sub === 'close') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
          const track = interaction.options.getString('track');
          if (!db.applications.tracks[track]) return interaction.reply({ content: 'Track not found.', ephemeral: true });
          db.applications.tracks[track].closed = !db.applications.tracks[track].closed;
          saveDB();
          return interaction.reply({ content: `Track "${track}" is now ${db.applications.tracks[track].closed ? 'CLOSED' : 'OPEN'}.`, ephemeral: true });
        }
      }

      // ===== /staff =====
      if (commandName === 'staff') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'promote' || sub === 'demote') {
          const user = interaction.options.getUser('user');
          const role = interaction.options.getRole('new_rank');
          const reason = interaction.options.getString('reason');
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (!member) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });

          await member.roles.add(role).catch(() => {});
          db.staff.history[user.id] = db.staff.history[user.id] || [];
          db.staff.history[user.id].push({ type: sub, role: role.name, reason, by: interaction.user.id, at: Date.now() });
          saveDB();

          await user.send({ embeds: [brandEmbed().setTitle(sub === 'promote' ? '🎉 You have been promoted!' : 'Rank Update').setDescription(`New rank: **${role.name}**\nReason: ${reason}`)] }).catch(() => {});
          return interaction.reply({ content: `${user} ${sub === 'promote' ? 'promoted' : 'demoted'} to ${role}.` });
        }
        if (sub === 'history') {
          const user = interaction.options.getUser('user');
          const hist = db.staff.history[user.id] || [];
          if (!hist.length) return interaction.reply({ content: 'No history found.', ephemeral: true });
          const desc = hist.map((h) => `**${h.type.toUpperCase()}** → ${h.role} — ${h.reason} (<t:${Math.floor(h.at / 1000)}:d>)`).join('\n');
          return interaction.reply({ embeds: [brandEmbed().setTitle(`Staff History — ${user.tag}`).setDescription(desc)], ephemeral: true });
        }
      }

      // ===== /infraction =====
      if (commandName === 'infraction') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const user = interaction.options.getUser('user');
          const reason = interaction.options.getString('reason');
          const severity = interaction.options.getString('severity');
          db.infractions.counter += 1;
          const id = db.infractions.counter;
          db.infractions.byUser[user.id] = db.infractions.byUser[user.id] || [];
          db.infractions.byUser[user.id].push({ id, reason, severity, by: interaction.user.id, at: Date.now() });
          saveDB();

          await user.send({ embeds: [brandEmbed().setTitle('⚠️ Infraction Issued').setDescription(`**Reason:** ${reason}\n**Severity:** ${severity}`)] }).catch(() => {});

          const count = db.infractions.byUser[user.id].length;
          await logToChannel(db.config.modLogChannelId, brandEmbed().setTitle('Infraction Logged').setDescription(`${user} — ${reason} (${severity}) — total: ${count}`));
          if (count >= 3) {
            await logToChannel(db.config.modLogChannelId, brandEmbed().setTitle('🚨 Escalation Flag').setDescription(`${user} has reached **${count}** infractions — review for demotion/removal.`));
          }
          return interaction.reply({ content: `Infraction #${id} issued to ${user}.` });
        }
        if (sub === 'remove') {
          const user = interaction.options.getUser('user');
          const id = interaction.options.getInteger('id');
          const list = db.infractions.byUser[user.id] || [];
          db.infractions.byUser[user.id] = list.filter((i) => i.id !== id);
          saveDB();
          return interaction.reply({ content: `Infraction #${id} removed from ${user}.`, ephemeral: true });
        }
        if (sub === 'history') {
          const user = interaction.options.getUser('user');
          const list = db.infractions.byUser[user.id] || [];
          if (!list.length) return interaction.reply({ content: 'No infractions found.', ephemeral: true });
          const desc = list.map((i) => `#${i.id} — **${i.severity}** — ${i.reason} (<t:${Math.floor(i.at / 1000)}:d>)`).join('\n');
          return interaction.reply({ embeds: [brandEmbed().setTitle(`Infractions — ${user.tag}`).setDescription(desc)], ephemeral: true });
        }
      }

      // ===== /feedback =====
      if (commandName === 'feedback') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'submit') {
          const staffUser = interaction.options.getUser('staff');
          const rating = interaction.options.getInteger('rating');
          const comment = interaction.options.getString('comment');
          db.feedback[staffUser.id] = db.feedback[staffUser.id] || [];
          db.feedback[staffUser.id].push({ rating, comment, submitterId: interaction.user.id, at: Date.now() });
          saveDB();
          return interaction.reply({ content: 'Thanks — your feedback was submitted anonymously.', ephemeral: true });
        }
        if (sub === 'view') {
          const staffUser = interaction.options.getUser('staff');
          if (staffUser.id !== interaction.user.id && !isStaff(interaction.member)) {
            return interaction.reply({ content: 'You can only view your own feedback.', ephemeral: true });
          }
          const list = db.feedback[staffUser.id] || [];
          if (!list.length) return interaction.reply({ content: 'No feedback yet.', ephemeral: true });
          const avg = (list.reduce((a, b) => a + b.rating, 0) / list.length).toFixed(1);
          const recent = list.slice(-5).map((f) => `⭐ ${f.rating}/5 — ${f.comment}`).join('\n');
          return interaction.reply({ embeds: [brandEmbed().setTitle(`Feedback — ${staffUser.tag}`).setDescription(`**Average:** ${avg}/5 (${list.length} reviews)\n\n${recent}`)], ephemeral: true });
        }
        if (sub === 'leaderboard') {
          const rows = Object.entries(db.feedback)
            .map(([id, list]) => ({ id, avg: list.reduce((a, b) => a + b.rating, 0) / list.length, count: list.length }))
            .sort((a, b) => b.avg - a.avg)
            .slice(0, 5);
          if (!rows.length) return interaction.reply({ content: 'No feedback yet.', ephemeral: true });
          const desc = rows.map((r, i) => `**#${i + 1}** <@${r.id}> — ${r.avg.toFixed(1)}/5 (${r.count} reviews)`).join('\n');
          return interaction.reply({ embeds: [brandEmbed().setTitle('🏆 Staff Feedback Leaderboard').setDescription(desc)] });
        }
      }

      // ===== /config =====
      if (commandName === 'config') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const ticketCategory = interaction.options.getChannel('ticket_category');
        const ticketLog = interaction.options.getChannel('ticket_log');
        const modLog = interaction.options.getChannel('mod_log');
        const giveawayLog = interaction.options.getChannel('giveaway_log');
        const staffRole = interaction.options.getRole('staff_role');

        if (ticketCategory) db.config.ticketCategoryId = ticketCategory.id;
        if (ticketLog) db.config.ticketLogChannelId = ticketLog.id;
        if (modLog) db.config.modLogChannelId = modLog.id;
        if (giveawayLog) db.config.giveawayLogChannelId = giveawayLog.id;
        if (staffRole) db.config.staffRoleId = staffRole.id;
        saveDB();
        return interaction.reply({ content: 'Configuration updated.', ephemeral: true });
      }

      // ===== utility =====
      if (commandName === 'ping') return interaction.reply({ content: `🏓 Pong! ${client.ws.ping}ms` });

      if (commandName === 'serverinfo') {
        const g = interaction.guild;
        return interaction.reply({
          embeds: [brandEmbed().setTitle(g.name).setThumbnail(g.iconURL()).addFields({ name: 'Members', value: String(g.memberCount), inline: true }, { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:d>`, inline: true })],
        });
      }

      if (commandName === 'userinfo') {
        const user = interaction.options.getUser('user') || interaction.user;
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        return interaction.reply({
          embeds: [
            brandEmbed()
              .setTitle(user.tag)
              .setThumbnail(user.displayAvatarURL())
              .addFields(
                { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:d>` : 'Unknown', inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:d>`, inline: true }
              ),
          ],
        });
      }

      if (commandName === 'help') {
        return interaction.reply({
          embeds: [
            brandEmbed()
              .setTitle('📖 MCRP Commands')
              .addFields(
                { name: '🎫 Tickets', value: '/ticket panel, close, claim, add, remove, rename' },
                { name: '🚫 Automod', value: '/automod addword, removeword, list, setduration, toggle, whitelist' },
                { name: '🎉 Giveaways', value: '/giveaway create, end, reroll, list' },
                { name: '📋 Applications', value: '/application setup, panel, review, close' },
                { name: '🧑‍💼 Staff', value: '/staff promote, demote, history — /infraction add, remove, history' },
                { name: '⭐ Feedback', value: '/feedback submit, view, leaderboard' },
                { name: '⚙️ Config', value: '/config set' },
                { name: 'ℹ️ Utility', value: '/ping, /serverinfo, /userinfo' }
              ),
          ],
        });
      }
    }

    // ---------- MODAL SUBMITS ----------
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('mcrp_appquestions_')) {
        const track = interaction.customId.replace('mcrp_appquestions_', '');
        const raw = interaction.fields.getTextInputValue('questions');
        const questions = raw.split('\n').map((q) => q.trim()).filter(Boolean);
        db.applications.tracks[track].questions = questions;
        saveDB();
        return interaction.reply({ content: `Saved ${questions.length} question(s) for "${track}". Use /application panel to post it.`, ephemeral: true });
      }
    }

    // ---------- BUTTONS ----------
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'mcrp_open_ticket') return createTicket(interaction);
      if (id === 'mcrp_ticket_claim') return claimTicket(interaction);
      if (id === 'mcrp_ticket_close') return closeTicket(interaction);
      if (id === 'mcrp_ticket_transcript') {
        const ticket = db.tickets[interaction.channel.id];
        if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
        const buffer = await buildTranscript(interaction.channel);
        return interaction.reply({ files: [new AttachmentBuilder(buffer, { name: `ticket-${ticket.number}-transcript.txt` })], ephemeral: true });
      }

      if (id === 'mcrp_giveaway_enter') {
        const g = db.giveaways[interaction.message.id];
        if (!g || g.ended) return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
        if (g.entries.includes(interaction.user.id)) return interaction.reply({ content: 'You already entered!', ephemeral: true });
        g.entries.push(interaction.user.id);
        saveDB();
        await interaction.message.edit({ embeds: [giveawayEmbed(g)], components: [giveawayRow()] }).catch(() => {});
        return interaction.reply({ content: '🎉 You entered the giveaway! Good luck.', ephemeral: true });
      }

      if (id === 'mcrp_giveaway_claim') {
        return createTicket(interaction, 'Giveaway prize claim');
      }

      if (id.startsWith('mcrp_apply_')) {
        const track = id.replace('mcrp_apply_', '');
        const cfg = db.applications.tracks[track];
        if (!cfg) return interaction.reply({ content: 'This application track no longer exists.', ephemeral: true });
        if (cfg.closed) return interaction.reply({ content: 'Applications for this track are currently closed.', ephemeral: true });

        const key = `${track}:${interaction.user.id}`;
        const cooldownUntil = db.applications.cooldowns[key];
        if (cooldownUntil && cooldownUntil > Date.now()) {
          return interaction.reply({ content: `You can reapply <t:${Math.floor(cooldownUntil / 1000)}:R>.`, ephemeral: true });
        }
        if (db.applications.pending[key]) {
          return interaction.reply({ content: 'You already have an application in progress — check your DMs.', ephemeral: true });
        }

        await interaction.reply({ content: '📬 Check your DMs to start your application!', ephemeral: true });

        const dmEmbed = brandEmbed().setTitle(`Apply — ${track}`).setDescription(`You're about to apply for **${track}**.\nThis will ask you ${cfg.questions.length} question(s), one at a time — just reply with a message to move to the next question.\n\nClick **Ready** when you'd like to begin.`);
        const readyRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mcrp_ready_${track}`).setLabel("I'm Ready").setEmoji('✅').setStyle(ButtonStyle.Success));

        const dmUser = await client.users.fetch(interaction.user.id);
        await dmUser.send({ embeds: [dmEmbed], components: [readyRow] }).catch(() => {
          interaction.followUp({ content: "I couldn't DM you — please enable DMs from server members and try again.", ephemeral: true });
        });
      }

      if (id.startsWith('mcrp_ready_')) {
        const track = id.replace('mcrp_ready_', '');
        const cfg = db.applications.tracks[track];
        if (!cfg) return interaction.reply({ content: 'This application track no longer exists.', ephemeral: true });

        const key = `${track}:${interaction.user.id}`;
        db.applications.pending[key] = true;
        saveDB();

        await interaction.update({ components: [] }).catch(() => {});
        await interaction.channel.send("Let's go! I'll ask you each question — just reply with a normal message to continue.");

        const answers = await runQuestionnaire(interaction.user, track, cfg.questions);
        delete db.applications.pending[key];

        if (!answers) {
          saveDB();
          return; // timed out — already messaged
        }

        db.applications.submissionCounter += 1;
        const subId = String(db.applications.submissionCounter);
        db.applications.submissions[subId] = {
          track,
          userId: interaction.user.id,
          questions: cfg.questions,
          answers,
          status: 'pending',
          at: Date.now(),
        };
        saveDB();

        await interaction.channel.send('✅ Application submitted! You will be notified here once staff review it.');

        const reviewChannel = await client.channels.fetch(cfg.reviewChannelId).catch(() => null);
        if (reviewChannel) {
          const embed = brandEmbed()
            .setTitle(`New Application #${subId} — ${track}`)
            .setDescription(`Applicant: <@${interaction.user.id}> (${interaction.user.tag})`)
            .addFields(cfg.questions.map((q, i) => ({ name: q.slice(0, 256), value: (answers[i] || '-').slice(0, 1024) })))
            .setTimestamp();
          const row = await reviewDecisionRow(subId);
          await reviewChannel.send({ embeds: [embed], components: [row] });
        }
      }

      if (id.startsWith('mcrp_appdecision_')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
        const [, , decision, subId] = id.split('_'); // mcrp_appdecision_<decision>_<id>
        const submission = db.applications.submissions[subId];
        if (!submission) return interaction.reply({ content: 'Submission not found.', ephemeral: true });

        submission.status = decision;
        saveDB();

        const applicant = await client.users.fetch(submission.userId).catch(() => null);
        const cfg = db.applications.tracks[submission.track];

        if (decision === 'accept') {
          if (applicant) await applicant.send({ embeds: [brandEmbed().setTitle('🎉 Application Accepted').setDescription(`Congrats! Your application for **${submission.track}** was accepted.`)] }).catch(() => {});
          if (cfg?.roleId) {
            const member = await interaction.guild.members.fetch(submission.userId).catch(() => null);
            if (member) await member.roles.add(cfg.roleId).catch(() => {});
          }
        } else if (decision === 'deny') {
          if (applicant) await applicant.send({ embeds: [brandEmbed().setTitle('Application Update').setDescription(`Your application for **${submission.track}** was not accepted this time.`)] }).catch(() => {});
          db.applications.cooldowns[`${submission.track}:${submission.userId}`] = Date.now() + (cfg?.cooldownDays || 7) * 86400000;
          saveDB();
        } else if (decision === 'interview') {
          if (applicant) await applicant.send({ embeds: [brandEmbed().setTitle('Application Update').setDescription(`Staff would like to interview you about your **${submission.track}** application. Please open a ticket in the server so we can chat!`)] }).catch(() => {});
        }

        await interaction.update({ components: [] }).catch(() => {});
        return interaction.followUp({ content: `Marked as **${decision}**.`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong handling that — check the bot logs.', ephemeral: true }).catch(() => {});
    }
  }
});

// ============================================================================
// 13. LOGIN
// ============================================================================

client.login(process.env.BOT_TOKEN);
