const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { ticketConfig, getSupportRoleIds, tickets, ticketQuestions, strikeConfig, strikeDb } = require('./database');
const { success, error, warning, info, closeTicket } = require('./utils');
const embeds = { success, error, warning, info };
const panel       = require('./panel');
const embedBuilder = require('./embed');

// ─── /embed ───────────────────────────────────────────────────────────────────

const embed = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Build and post a custom embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the embed in.').addChannelTypes(ChannelType.GuildText).setRequired(true)),

  async execute(interaction) {
    await embedBuilder.start(interaction, interaction.options.getChannel('channel').id);
  },
};

// ─── /ticket ──────────────────────────────────────────────────────────────────

const PANEL_STYLE_MAP = { 1: 'blue', 2: 'grey', 3: 'green', 4: 'red' };

const ticket = {
  data: new SlashCommandBuilder()
    .setName('ticket').setDescription('Ticket management commands.')
    .addSubcommand(sc => sc.setName('edit').setDescription('Edit an existing bot message or ticket panel.')
      .addStringOption(o => o.setName('message_id').setDescription('The ID of the message to edit.').setRequired(true)))
    .addSubcommand(sc => sc.setName('panel').setDescription('Build and post a customizable ticket panel.')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post the panel in.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('close').setDescription('Close the current ticket.')
      .addStringOption(o => o.setName('reason').setDescription('Optional reason for closing.').setRequired(false)))
    .addSubcommand(sc => sc.setName('rename').setDescription('Rename this ticket channel.')
      .addStringOption(o => o.setName('name').setDescription('New name for the channel.').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'edit')   return handleTicketEdit(interaction);
    if (sub === 'panel')  return handleTicketPanel(interaction);
    if (sub === 'close')  return handleTicketClose(interaction);
    if (sub === 'rename') return handleTicketRename(interaction);
  },
};

async function handleTicketEdit(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only administrators can edit messages.')], ephemeral: true });

  const messageId = interaction.options.getString('message_id').trim();
  const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return interaction.reply({ embeds: [embeds.error('Not found', 'Could not find that message in this channel.')], ephemeral: true });
  if (msg.author.id !== interaction.client.user.id) return interaction.reply({ embeds: [embeds.error('Not my message', 'I can only edit messages sent by me.')], ephemeral: true });

  const isPanel = msg.components.some(row => row.components.some(c => c.customId?.startsWith('ticket_create:')));
  if (isPanel) {
    const embed   = msg.embeds[0];
    const cfg     = ticketConfig.get.get(interaction.guildId);
    const buttons = [];
    for (const row of msg.components) {
      for (const comp of row.components) {
        if (!comp.customId?.startsWith('ticket_create:')) continue;
        const prefix = comp.customId.split(':')[1] || 'ticket';
        const qRow   = ticketQuestions.get.get(interaction.guildId, prefix);
        const emojiStr = comp.emoji ? (comp.emoji.id ? `<${comp.emoji.animated ? 'a' : ''}:${comp.emoji.name}:${comp.emoji.id}>` : comp.emoji.name ?? '') : '';
        buttons.push({ label: comp.label ?? '', emoji: emojiStr, style: PANEL_STYLE_MAP[comp.style] ?? 'blue', prefix, questions: qRow ? JSON.parse(qRow.questions) : [] });
      }
    }
    return panel.openForEdit(interaction, { channelId: msg.channelId, editMessageId: msg.id, title: embed?.title ?? '', description: embed?.description ?? '', color: embed?.color ?? 0x3498DB, categoryId: cfg?.category_id ?? null, logChannelId: cfg?.log_channel_id ?? null, supportRoleIds: getSupportRoleIds(cfg), buttons });
  }

  const embed        = msg.embeds[0];
  const currentTitle = embed?.title ?? '';
  const currentDesc  = embed?.description ?? msg.content ?? '';
  const modal = new ModalBuilder().setCustomId(`ticket_edit_modal:${messageId}`).setTitle('Edit Message');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Embed Title').setStyle(TextInputStyle.Short).setValue(currentTitle).setMaxLength(256).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Embed Description / Message Content').setStyle(TextInputStyle.Paragraph).setValue(currentDesc.substring(0, 4000)).setMaxLength(4000).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function handleTicketPanel(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only administrators can create panels.')], ephemeral: true });
  const channelId = interaction.options.getChannel('channel').id;
  const modal = new ModalBuilder().setCustomId(`ticket_panel_modal:${channelId}`).setTitle('Ticket Panel Builder');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Support Tickets').setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. Click a button below to open a ticket.').setMaxLength(2000).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Embed Color (hex, e.g. 3498DB)').setStyle(TextInputStyle.Short).setPlaceholder('3498DB').setMaxLength(7).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function handleTicketClose(interaction) {
  const ticket = tickets.getByChannel.get(interaction.channelId);
  const cfg    = ticketConfig.get.get(interaction.guildId);
  if (!ticket || ticket.status !== 'open')
    return interaction.reply({ embeds: [embeds.error('Not a ticket', 'This command can only be used inside an open ticket channel.')], ephemeral: true });
  const closeRoles = getSupportRoleIds(cfg);
  const canClose   = interaction.user.id === ticket.owner_id || closeRoles.some(id => interaction.member?.roles.cache.has(id)) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
  if (!canClose) return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only the ticket owner or staff can close this ticket.')], ephemeral: true });
  await interaction.deferReply();
  await closeTicket(interaction, ticket, cfg);
}

async function handleTicketRename(interaction) {
  const ticket = tickets.getByChannel.get(interaction.channelId);
  if (!ticket) return interaction.reply({ embeds: [embeds.error('Not a ticket', 'This command can only be used inside a ticket channel.')], ephemeral: true });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only administrators can rename tickets.')], ephemeral: true });
  const newName = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  if (!newName) return interaction.reply({ embeds: [embeds.error('Invalid name', 'Channel name must contain at least one valid character.')], ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  await interaction.channel.setName(newName);
  await interaction.editReply({ embeds: [embeds.success('Renamed', `Channel renamed to **${newName}**.`)] });
}

// ─── /smp ─────────────────────────────────────────────────────────────────────

const LEADERBOARD_TYPES = [
  { name: 'Money',               value: 'money'       },
  { name: 'Shards',              value: 'shards'      },
  { name: 'Playtime',            value: 'playtime'    },
  { name: 'Kills',               value: 'kills'       },
  { name: 'Deaths',              value: 'deaths'      },
  { name: 'Mobs Killed',         value: 'mobskilled'  },
  { name: 'Placed Blocks',       value: 'placedblocks'},
  { name: 'Broken Blocks',       value: 'brokenblocks'},
  { name: 'Money from Selling',  value: 'sell'        },
  { name: 'Money Spent on Shop', value: 'shop'        },
];

function fmt(val) { const n = parseInt(val, 10); return isNaN(n) ? (val ?? '0') : n.toLocaleString('en-US'); }
function fmtMoney(val) { const n = parseInt(val, 10); return isNaN(n) ? val : `$${n.toLocaleString('en-US')}`; }
function fmtPlaytime(val) {
  const ms = parseInt(val, 10); if (isNaN(ms)) return val ?? '0';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = []; if (d > 0) parts.push(`${d}d`); if (h > 0) parts.push(`${h}h`); if (m > 0 || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}
async function apiFetch(path) {
  const res = await fetch(`https://api.donutsmp.net/v1${path}`, { headers: { Authorization: `Bearer ${process.env.DONUT_API_KEY}`, accept: 'application/json' } });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

const smp = {
  data: new SlashCommandBuilder()
    .setName('smp').setDescription('Look up DonutSMP player stats.')
    .addSubcommand(sc => sc.setName('stats').setDescription("View a player's DonutSMP stats.")
      .addStringOption(o => o.setName('username').setDescription('Minecraft username to look up.').setRequired(true)))
    .addSubcommand(sc => sc.setName('leaderboard').setDescription('View a DonutSMP server leaderboard.')
      .addStringOption(o => o.setName('type').setDescription('Which leaderboard to view.').setRequired(true).addChoices(...LEADERBOARD_TYPES))
      .addIntegerOption(o => o.setName('page').setDescription('Page number (default: 1).').setMinValue(1).setRequired(false))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'stats')       return handleSmpStats(interaction);
    if (sub === 'leaderboard') return handleSmpLeaderboard(interaction);
  },
};

async function handleSmpStats(interaction) {
  await interaction.deferReply();
  if (!process.env.DONUT_API_KEY) return interaction.editReply({ embeds: [embeds.error('Not configured', 'No DonutSMP API key set.')] });
  const username = interaction.options.getString('username').trim();
  const { ok, status, data } = await apiFetch(`/stats/${encodeURIComponent(username)}`);
  if (!ok) {
    if (status === 401) return interaction.editReply({ embeds: [embeds.error('Invalid API key', 'The DonutSMP API key is invalid or expired.')] });
    if (status === 500) return interaction.editReply({ embeds: [embeds.error('Player not found', `No DonutSMP data found for **${username}**.`)] });
    return interaction.editReply({ embeds: [embeds.error('API error', `Status ${status}`)] });
  }
  const r = data.result;
  const kdratio = r.deaths === '0' ? fmt(r.kills) : (parseInt(r.kills) / parseInt(r.deaths)).toFixed(2);
  await interaction.editReply({
    embeds: [
      new EmbedBuilder().setColor(0x3498DB).setTitle(`🍩 ${username} — DonutSMP Stats`)
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(username)}/64`)
        .setImage(`https://mc-heads.net/body/${encodeURIComponent(username)}/right`)
        .addFields(
          { name: '💰 Money',         value: fmtMoney(r.money),              inline: true },
          { name: '💎 Shards',        value: fmt(r.shards),                  inline: true },
          { name: '⏱️ Playtime',      value: fmtPlaytime(r.playtime),        inline: true },
          { name: '⚔️ Kills',         value: fmt(r.kills),                   inline: true },
          { name: '💀 Deaths',        value: fmt(r.deaths),                  inline: true },
          { name: '📊 K/D Ratio',     value: String(kdratio),                inline: true },
          { name: '🧟 Mobs Killed',   value: fmt(r.mobs_killed),             inline: true },
          { name: '🧱 Blocks Placed', value: fmt(r.placed_blocks),           inline: true },
          { name: '⛏️ Blocks Broken', value: fmt(r.broken_blocks),           inline: true },
          { name: '🛒 Spent on Shop', value: fmtMoney(r.money_spent_on_shop), inline: true },
        )
        .setFooter({ text: "Solucent's Helper • DonutSMP Stats" }).setTimestamp(),
    ],
  });
}

async function handleSmpLeaderboard(interaction) {
  await interaction.deferReply();
  if (!process.env.DONUT_API_KEY) return interaction.editReply({ embeds: [embeds.error('Not configured', 'No DonutSMP API key set.')] });
  const type = interaction.options.getString('type');
  const page = interaction.options.getInteger('page') ?? 1;
  const { ok, status, data } = await apiFetch(`/leaderboards/${type}/${page}`);
  if (!ok) {
    if (status === 401) return interaction.editReply({ embeds: [embeds.error('Invalid API key', 'The DonutSMP API key is invalid.')] });
    return interaction.editReply({ embeds: [embeds.error('API error', `Status ${status}`)] });
  }
  const entries = data.result ?? data;
  if (!Array.isArray(entries) || entries.length === 0) return interaction.editReply({ embeds: [embeds.info('No data', 'No leaderboard entries found.')] });
  const medals = ['🥇', '🥈', '🥉'];
  const start  = (page - 1) * entries.length;
  const lines  = entries.map((entry, i) => {
    const rank    = start + i + 1;
    const medal   = medals[rank - 1] ?? `**${rank}.**`;
    const name    = entry.username ?? entry.name ?? 'Unknown';
    const value   = entry.value ?? entry[type] ?? '?';
    const display = type === 'money' || type === 'sell' || type === 'shop' ? fmtMoney(value) : type === 'playtime' ? fmtPlaytime(value) : fmt(value);
    return `${medal} **${name}** — ${display}`;
  });
  const label = LEADERBOARD_TYPES.find(t => t.value === type)?.name ?? type;
  await interaction.editReply({
    embeds: [
      new EmbedBuilder().setColor(0x3498DB).setTitle(`🍩 DonutSMP Leaderboard — ${label}`)
        .setDescription(lines.join('\n')).setFooter({ text: `Solucent's Helper • Page ${page}` }).setTimestamp(),
    ],
  });
}

// ─── /strikerole ──────────────────────────────────────────────────────────────

const strikerole = {
  data: new SlashCommandBuilder()
    .setName('strikerole').setDescription('Create the three strike roles for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const existing = strikeConfig.get.get(interaction.guildId);
    if (existing) {
      const r1 = interaction.guild.roles.cache.get(existing.role1_id);
      const r2 = interaction.guild.roles.cache.get(existing.role2_id);
      const r3 = interaction.guild.roles.cache.get(existing.role3_id);
      if (r1 && r2 && r3) return interaction.editReply({ embeds: [embeds.warning('Already set up', `Strike roles already exist:\n${r1} · ${r2} · ${r3}`)] });
    }
    const colors = [0xFEE75C, 0xFF8C00, 0xED4245];
    const names  = ['⚠️ Strike 1', '⚠️⚠️ Strike 2', '⚠️⚠️⚠️ Strike 3'];
    const roles  = [];
    for (let i = 0; i < 3; i++) roles.push(await interaction.guild.roles.create({ name: names[i], color: colors[i], reason: 'Strike system setup by ' + interaction.user.tag }));
    strikeConfig.upsert.run({ '@guild_id': interaction.guildId, '@role1_id': roles[0].id, '@role2_id': roles[1].id, '@role3_id': roles[2].id });
    await interaction.editReply({ embeds: [embeds.success('Strike Roles Created', `${roles[0]} — first offense\n${roles[1]} — second offense\n${roles[2]} — third offense (triggers demotion)`)] });
  },
};

// ─── /nick ────────────────────────────────────────────────────────────────────

const nick = {
  data: new SlashCommandBuilder()
    .setName('nick').setDescription('Change a member\'s nickname.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The member to rename.').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('New nickname (leave empty to reset).').setMaxLength(32).setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    const name   = interaction.options.getString('name') ?? null;
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    if (!target.manageable) return interaction.reply({ embeds: [embeds.error('Cannot edit', 'I don\'t have permission to change that member\'s nickname (they may outrank me).')], ephemeral: true });
    await target.setNickname(name, `Changed by ${interaction.user.tag}`);
    await interaction.reply({ embeds: [embeds.success('Nickname Updated', name ? `${target}'s nickname has been set to **${name}**.` : `${target}'s nickname has been reset.`)] });
  },
};

// ─── /timeout + /untimeout ────────────────────────────────────────────────────

const DURATIONS = [
  { name: '60 seconds', value: 60 }, { name: '5 minutes',  value: 300 },  { name: '10 minutes', value: 600 },
  { name: '30 minutes', value: 1800 }, { name: '1 hour',   value: 3600 }, { name: '6 hours',    value: 21600 },
  { name: '12 hours',   value: 43200 }, { name: '1 day',   value: 86400 }, { name: '3 days',    value: 259200 },
  { name: '1 week',     value: 604800 },
];

const timeout = {
  data: new SlashCommandBuilder()
    .setName('timeout').setDescription('Timeout (mute) a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('The member to timeout.').setRequired(true))
    .addIntegerOption(o => { o.setName('duration').setDescription('How long to timeout the member.').setRequired(true); for (const d of DURATIONS) o.addChoices({ name: d.name, value: d.value }); return o; })
    .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout.').setMaxLength(512).setRequired(false)),

  async execute(interaction) {
    const target  = interaction.options.getMember('user');
    const seconds = interaction.options.getInteger('duration');
    const reason  = interaction.options.getString('reason') ?? 'No reason provided.';
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    if (!target.moderatable) return interaction.reply({ embeds: [embeds.error('Cannot timeout', 'I don\'t have permission to timeout that member (they may outrank me).')], ephemeral: true });
    await target.timeout(seconds * 1000, reason);
    const label = DURATIONS.find(d => d.value === seconds)?.name ?? `${seconds}s`;
    await interaction.reply({ embeds: [embeds.success('Member Timed Out', `**${target.user.tag}** has been timed out for **${label}**.\n**Reason:** ${reason}`)] });
  },
};

const untimeout = {
  data: new SlashCommandBuilder()
    .setName('untimeout').setDescription('Remove a timeout from a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to remove the timeout from.').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    if (!target.isCommunicationDisabled()) return interaction.reply({ embeds: [embeds.warning('Not timed out', 'That member is not currently timed out.')], ephemeral: true });
    if (!target.moderatable) return interaction.reply({ embeds: [embeds.error('Cannot untimeout', 'I don\'t have permission to modify that member (they may outrank me).')], ephemeral: true });
    await target.timeout(null, `Timeout removed by ${interaction.user.tag}`);
    await interaction.reply({ embeds: [embeds.success('Timeout Removed', `${target}'s timeout has been removed.`)] });
  },
};

// ─── /ban + /kick ─────────────────────────────────────────────────────────────

const ban = {
  data: new SlashCommandBuilder()
    .setName('ban').setDescription('Ban a member from the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The member to ban.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the ban.').setMaxLength(512).setRequired(false))
    .addIntegerOption(o => o.setName('delete_messages').setDescription('Delete messages from the past X days (0–7).').setMinValue(0).setMaxValue(7).setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    const user   = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided.';
    const days   = interaction.options.getInteger('delete_messages') ?? 0;
    if (target && !target.bannable) return interaction.reply({ embeds: [embeds.error('Cannot ban', 'I don\'t have permission to ban that member (they may outrank me).')], ephemeral: true });
    await interaction.guild.members.ban(user, { reason, deleteMessageDays: days });
    await interaction.reply({ embeds: [embeds.success('Member Banned', `**${user.tag}** has been banned.\n**Reason:** ${reason}`)] });
  },
};

const kick = {
  data: new SlashCommandBuilder()
    .setName('kick').setDescription('Kick a member from the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The member to kick.').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the kick.').setMaxLength(512).setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason') ?? 'No reason provided.';
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    if (!target.kickable) return interaction.reply({ embeds: [embeds.error('Cannot kick', 'I don\'t have permission to kick that member (they may outrank me).')], ephemeral: true });
    await target.kick(reason);
    await interaction.reply({ embeds: [embeds.success('Member Kicked', `**${target.user.tag}** has been kicked.\n**Reason:** ${reason}`)] });
  },
};

// ─── /lockdown ────────────────────────────────────────────────────────────────

const lockdown = {
  data: new SlashCommandBuilder()
    .setName('lockdown').setDescription('Lock or unlock a channel (toggles — run again to undo).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to lock/unlock (defaults to current channel).').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the lockdown.').setMaxLength(200).setRequired(false)),

  async execute(interaction) {
    const target   = interaction.options.getChannel('channel') ?? interaction.channel;
    const reason   = interaction.options.getString('reason') ?? 'No reason provided.';
    const isLocked = target.permissionOverwrites.cache.get(interaction.guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
    if (isLocked) {
      await target.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: null });
      await interaction.reply({ embeds: [embeds.success('Channel Unlocked', `${target} has been unlocked.\n**Reason:** ${reason}`)] });
    } else {
      await target.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: false });
      await target.send({ embeds: [embeds.error('🔒 Channel Locked', `This channel has been locked by ${interaction.user}.\n**Reason:** ${reason}`)] }).catch(() => {});
      await interaction.reply({ embeds: [embeds.success('Channel Locked', `${target} has been locked.\n**Reason:** ${reason}`)] });
    }
  },
};

// ─── /strike ──────────────────────────────────────────────────────────────────

const strike = {
  data: new SlashCommandBuilder()
    .setName('strike').setDescription('Manage user strikes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('give').setDescription('Give a user a strike.')
      .addUserOption(o => o.setName('user').setDescription('Member to strike.').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Reason for the strike.').setRequired(false)))
    .addSubcommand(sub => sub.setName('clear').setDescription('Clear all strikes from a user.')
      .addUserOption(o => o.setName('user').setDescription('Member to clear strikes for.').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (sub === 'clear') {
      const target = interaction.options.getMember('user');
      if (!target) return interaction.editReply({ embeds: [embeds.error('User not found', 'That member is not in this server.')] });
      const cfg      = strikeConfig.get.get(interaction.guildId);
      const row      = strikeDb.get.get(interaction.guildId, target.id);
      const prevCount = row?.count ?? 0;
      strikeDb.reset.run(interaction.guildId, target.id);
      if (cfg) {
        for (const roleId of [cfg.role1_id, cfg.role2_id, cfg.role3_id].filter(Boolean)) {
          if (target.roles.cache.has(roleId)) await target.roles.remove(roleId, 'Strikes cleared').catch(() => {});
        }
      }
      return interaction.editReply({ embeds: [embeds.success('Strikes Cleared', `Cleared **${prevCount}** strike(s) from ${target}.`)] });
    }

    // give
    const cfg = strikeConfig.get.get(interaction.guildId);
    if (!cfg?.role1_id) return interaction.editReply({ embeds: [embeds.error('Not set up', 'Run `/strikerole` first to create the strike roles.')] });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.editReply({ embeds: [embeds.error('User not found', 'That member is not in this server.')] });
    if (target.user.bot) return interaction.editReply({ embeds: [embeds.error('Cannot strike a bot', 'Bots cannot be struck.')] });

    const strikeRoleIds = [cfg.role1_id, cfg.role2_id, cfg.role3_id];
    const reason        = interaction.options.getString('reason') ?? 'No reason provided.';
    strikeDb.upsert.run(interaction.guildId, target.id);
    const row   = strikeDb.get.get(interaction.guildId, target.id);
    const count = row.count;

    for (const roleId of strikeRoleIds) {
      if (target.roles.cache.has(roleId)) await target.roles.remove(roleId, 'Strike system').catch(() => {});
    }

    if (count === 1) {
      await target.roles.add(cfg.role1_id, 'Strike 1').catch(() => {});
    } else if (count === 2) {
      await target.roles.add(cfg.role2_id, 'Strike 2').catch(() => {});
    } else {
      await target.roles.add(cfg.role3_id, 'Strike 3').catch(() => {});
      return handleThirdStrike(interaction, target, cfg, strikeRoleIds, reason);
    }

    const strikeEmojis = ['', '⚠️', '⚠️⚠️', '⚠️⚠️⚠️'];
    const strikeEmbed  = new EmbedBuilder()
      .setColor(count === 1 ? 0xFEE75C : 0xFF8C00)
      .setTitle(`${strikeEmojis[count]} Strike ${count} — ${target.user.username}`)
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Strikes', value: `${count}/3`, inline: true }, { name: 'Reason', value: reason })
      .setTimestamp();

    await interaction.editReply({ embeds: [strikeEmbed] });
    await interaction.channel.send({ content: `${target}`, embeds: [strikeEmbed] }).catch(() => {});

    try {
      await target.send({
        embeds: [
          new EmbedBuilder().setColor(count === 1 ? 0xFEE75C : 0xFF8C00)
            .setTitle(`${strikeEmojis[count]} You received Strike ${count} in ${interaction.guild.name}`)
            .addFields({ name: 'Strikes', value: `${count}/3`, inline: true }, { name: 'Reason', value: reason })
            .setDescription(count === 2 ? '⚠️ **One more strike will result in a demotion.**' : '').setTimestamp(),
        ],
      });
    } catch { /* DMs closed */ }
  },
};

async function handleThirdStrike(interaction, target, cfg, strikeRoleIds, reason) {
  const highestRole = target.roles.cache.filter(r => r.id !== interaction.guild.roles.everyone.id && !strikeRoleIds.includes(r.id) && !r.managed).sort((a, b) => b.position - a.position).first();
  let demotionText = 'You have no further roles to remove.', newHighest = null;
  strikeDb.reset.run(interaction.guildId, target.id);
  if (highestRole) {
    await target.roles.remove(highestRole, 'Strike 3 demotion').catch(() => {});
    newHighest = target.roles.cache.filter(r => r.id !== interaction.guild.roles.everyone.id && !strikeRoleIds.includes(r.id) && !r.managed && r.id !== highestRole.id).sort((a, b) => b.position - a.position).first();
    demotionText = newHighest ? `You have been demoted. Your new highest role is **${newHighest.name}**.` : 'You have been demoted and now have no remaining roles.';
  }
  try {
    await target.send({
      embeds: [
        new EmbedBuilder().setColor(0xED4245).setTitle(`⚠️⚠️⚠️ Strike 3 — You have been demoted in ${interaction.guild.name}`)
          .setDescription(demotionText)
          .addFields({ name: 'Role Removed', value: highestRole ? highestRole.name : 'None', inline: true }, { name: 'New Highest Role', value: newHighest ? newHighest.name : 'None', inline: true }, { name: 'Reason', value: reason })
          .setTimestamp(),
      ],
    });
  } catch { /* DMs closed */ }
  const embed = new EmbedBuilder().setColor(0xED4245).setTitle(`⚠️⚠️⚠️ Strike 3 — ${target.user.username} Demoted`)
    .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Role Removed', value: highestRole ? highestRole.name : 'None', inline: true }, { name: 'Now Highest', value: newHighest ? newHighest.name : 'None', inline: true }, { name: 'Reason', value: reason })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
  await interaction.channel.send({ content: `${target}`, embeds: [embed] }).catch(() => {});
}

// ─── /promote + /demote ───────────────────────────────────────────────────────

function ascRoles(guild) {
  const botTop = guild.members.me.roles.highest.position;
  return guild.roles.cache.filter(r => r.id !== guild.id && r.position < botTop).sort((a, b) => a.position - b.position).toJSON();
}

const promote = {
  data: new SlashCommandBuilder()
    .setName('promote').setDescription('Give a member the next higher role, or a specific role.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The member to promote.').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Specific role to add instead of auto-promoting.').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    const roleOverride = interaction.options.getRole('role');
    if (roleOverride) {
      const botTop = interaction.guild.members.me.roles.highest.position;
      if (roleOverride.position >= botTop) return interaction.reply({ embeds: [embeds.error('Cannot promote', `I can't assign ${roleOverride} — it's at or above my highest role.`)], ephemeral: true });
      if (target.roles.cache.has(roleOverride.id)) return interaction.reply({ embeds: [embeds.warning('Already has role', `${target} already has ${roleOverride}.`)], ephemeral: true });
      await target.roles.add(roleOverride);
      return interaction.reply({ embeds: [embeds.success('Promoted', `${target} has been given ${roleOverride}.`)] });
    }
    const roles = ascRoles(interaction.guild);
    if (roles.length === 0) return interaction.reply({ embeds: [embeds.error('No manageable roles', 'There are no roles I can assign.')], ephemeral: true });
    const memberIds = new Set(target.roles.cache.keys());
    const highestIdx = roles.findLastIndex(r => memberIds.has(r.id));
    if (highestIdx === roles.length - 1) return interaction.reply({ embeds: [embeds.warning('Already at top', `${target} already has the highest role I can manage.`)], ephemeral: true });
    const next = roles[highestIdx + 1];
    await target.roles.add(next);
    return interaction.reply({ embeds: [embeds.success('Promoted', `${target} has been promoted to ${next}.`)] });
  },
};

const demote = {
  data: new SlashCommandBuilder()
    .setName('demote').setDescription("Remove a member's highest role, or a specific role.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('The member to demote.').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Specific role to remove instead of auto-demoting.').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ embeds: [embeds.error('Not found', 'That user is not in this server.')], ephemeral: true });
    const roleOverride = interaction.options.getRole('role');
    if (roleOverride) {
      const botTop = interaction.guild.members.me.roles.highest.position;
      if (roleOverride.position >= botTop) return interaction.reply({ embeds: [embeds.error('Cannot demote', `I can't remove ${roleOverride} — it's at or above my highest role.`)], ephemeral: true });
      if (!target.roles.cache.has(roleOverride.id)) return interaction.reply({ embeds: [embeds.warning('Role not found', `${target} doesn't have ${roleOverride}.`)], ephemeral: true });
      await target.roles.remove(roleOverride);
      return interaction.reply({ embeds: [embeds.success('Demoted', `${target} has had ${roleOverride} removed.`)] });
    }
    const roles   = ascRoles(interaction.guild);
    const memberIds = new Set(target.roles.cache.keys());
    const highest = [...roles].reverse().find(r => memberIds.has(r.id));
    if (!highest) return interaction.reply({ embeds: [embeds.warning('No roles', `${target} has no roles I can remove.`)], ephemeral: true });
    await target.roles.remove(highest);
    return interaction.reply({ embeds: [embeds.success('Demoted', `${target} has had ${highest} removed.`)] });
  },
};

// ─── Export all commands ──────────────────────────────────────────────────────

module.exports = [embed, ticket, smp, strikerole, nick, timeout, untimeout, ban, kick, lockdown, strike, promote, demote];
