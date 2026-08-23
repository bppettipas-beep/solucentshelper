const {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require('discord.js');
const { ticketConfig, getSupportRoleIds, tickets, ticketQuestions, donutPairings, donutStats } = require('./database');
const embeds = require('./utils');
const { closeTicket } = require('./utils');
const panelBuilder  = require('./panel');
const embedBuilder  = require('./embed');

// ─── Error reply helper ───────────────────────────────────────────────────────

async function safeErrorReply(interaction, err) {
  const reply = { embeds: [embeds.error('Something went wrong', err.message ?? String(err))], ephemeral: true };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  } catch { /* already gone */ }
}

module.exports = {
  name: 'interactionCreate',
  once: false,
  async execute(interaction) {
    // ── Slash Commands ─────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(`[Command:${interaction.commandName}]`, err);
        await safeErrorReply(interaction, err);
      }
      return;
    }

    // ── Button Interactions ────────────────────────────────────────────────────
    if (interaction.isButton()) {
      try {
        const [action, ...args] = interaction.customId.split(':');

        // ── Embed builder buttons ──────────────────────────────────────────────
        if (action === 'embed_edit')         return await embedBuilder.onEdit(interaction);
        if (action === 'embed_field_add')    return await embedBuilder.onFieldAdd(interaction);
        if (action === 'embed_field_remove') return await embedBuilder.onFieldRemove(interaction);
        if (action === 'embed_images')       return await embedBuilder.onImages(interaction);
        if (action === 'embed_post')         return await embedBuilder.onPost(interaction);
        if (action === 'embed_cancel')       return await embedBuilder.onCancel(interaction);

        // ── Ticket create (panel button) ───────────────────────────────────────
        if (action === 'ticket_create') return await handleTicketCreate(interaction);

        // ── Panel builder buttons ──────────────────────────────────────────────
        if (action === 'ticket_panel_addbtn')         return await panelBuilder.onAddButtonBtn(interaction);
        if (action === 'ticket_panel_removebtn')      return await panelBuilder.onRemoveLastBtn(interaction);
        if (action === 'ticket_panel_edit')           return await panelBuilder.onEditButton(interaction);
        if (action === 'ticket_panel_post')           return await panelBuilder.onPostButton(interaction);
        if (action === 'ticket_panel_cancel')         return await panelBuilder.onCancelButton(interaction);
        if (action === 'ticket_panel_btn_done')       return await panelBuilder.onBtnDone(interaction);
        if (action === 'ticket_panel_btn_clearcat')   return await panelBuilder.onBtnClearCat(interaction);
        if (action === 'ticket_panel_btn_clearroles') return await panelBuilder.onBtnClearRoles(interaction);

        // ── Ticket claim ───────────────────────────────────────────────────────
        if (action === 'ticket_claim') {
          const ticketId = parseInt(args[0], 10);
          const ticket   = tickets.getById.get(ticketId);
          const cfg      = ticketConfig.get.get(interaction.guildId);

          if (!ticket || ticket.status !== 'open')
            return interaction.reply({ embeds: [embeds.error('Ticket not found', 'This ticket could not be found or is already closed.')], ephemeral: true });
          const claimRoles = getSupportRoleIds(cfg);
          if (!claimRoles.some(id => interaction.member?.roles.cache.has(id)))
            return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only support staff can claim tickets.')], ephemeral: true });

          tickets.update.run({ '@id': ticketId, '@status': 'open', '@claimed_by': interaction.user.id, '@closed_at': null });
          await interaction.reply({ embeds: [embeds.info('Ticket Claimed', `${interaction.user} has claimed this ticket.`)] });
          return;
        }

        // ── Ticket close ───────────────────────────────────────────────────────
        if (action === 'ticket_close') {
          const ticketId = parseInt(args[0], 10);
          const ticket   = tickets.getById.get(ticketId);
          const cfg      = ticketConfig.get.get(interaction.guildId);

          if (!ticket || ticket.status !== 'open')
            return interaction.reply({ embeds: [embeds.error('Ticket not found', 'This ticket could not be found or is already closed.')], ephemeral: true });

          const closeRoles = getSupportRoleIds(cfg);
          const canClose =
            interaction.user.id === ticket.owner_id ||
            closeRoles.some(id => interaction.member?.roles.cache.has(id)) ||
            interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

          if (!canClose)
            return interaction.reply({ embeds: [embeds.error('Permission denied', 'Only the ticket owner or staff can close this.')], ephemeral: true });

          await interaction.deferReply();
          await closeTicket(interaction, ticket, cfg);
          return;
        }

        // ── Donut complete (DM button) ─────────────────────────────────────────
        if (action === 'donut_complete') {
          const pairingId = parseInt(args[0], 10);
          const pairing   = donutPairings.getById.get(pairingId);

          if (!pairing || pairing.status !== 'pending')
            return interaction.reply({ embeds: [embeds.warning('Already resolved', 'This pairing has already been marked.')], ephemeral: true });
          if (pairing.user1_id !== interaction.user.id && pairing.user2_id !== interaction.user.id)
            return interaction.reply({ embeds: [embeds.error('Not your pairing', 'You are not part of this donut pairing.')], ephemeral: true });

          donutPairings.updateStatus.run({ '@id': pairingId, '@status': 'completed', '@completed_at': Math.floor(Date.now() / 1000) });
          donutStats.upsertInit.run(pairing.guild_id, pairing.user1_id);
          donutStats.upsertInit.run(pairing.guild_id, pairing.user2_id);
          donutStats.recordComplete.run({ '@guild_id': pairing.guild_id, '@user_id': pairing.user1_id, '@round_id': pairing.round_id });
          donutStats.recordComplete.run({ '@guild_id': pairing.guild_id, '@user_id': pairing.user2_id, '@round_id': pairing.round_id });

          const partnerId = pairing.user1_id === interaction.user.id ? pairing.user2_id : pairing.user1_id;
          await interaction.update({
            embeds: [embeds.donut('Donut Completed! 🎉', `Your donut with <@${partnerId}> has been marked as completed. Your streak grows!`)],
            components: [],
          });
          return;
        }

        // ── Donut skip (DM button) ─────────────────────────────────────────────
        if (action === 'donut_skip') {
          const pairingId = parseInt(args[0], 10);
          const pairing   = donutPairings.getById.get(pairingId);

          if (!pairing || pairing.status !== 'pending')
            return interaction.reply({ embeds: [embeds.warning('Already resolved', 'This pairing has already been marked.')], ephemeral: true });
          if (pairing.user1_id !== interaction.user.id && pairing.user2_id !== interaction.user.id)
            return interaction.reply({ embeds: [embeds.error('Not your pairing', 'You are not part of this donut pairing.')], ephemeral: true });

          donutPairings.updateStatus.run({ '@id': pairingId, '@status': 'skipped', '@completed_at': Math.floor(Date.now() / 1000) });
          donutStats.upsertInit.run(pairing.guild_id, interaction.user.id);
          donutStats.recordSkip.run(pairing.guild_id, interaction.user.id);

          await interaction.update({
            embeds: [embeds.info('Pairing Skipped', 'Your pairing has been skipped for this round. Your streak has been reset.')],
            components: [],
          });
          return;
        }
      } catch (err) {
        console.error('[Button]', interaction.customId, err);
        await safeErrorReply(interaction, err);
      }
      return;
    }

    // ── Select Menus ───────────────────────────────────────────────────────────
    if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) {
      try {
        if (interaction.customId === 'ticket_panel_category')             return await panelBuilder.onCategorySelect(interaction);
        if (interaction.customId === 'ticket_panel_logchannel')           return await panelBuilder.onLogChannelSelect(interaction);
        if (interaction.customId === 'ticket_panel_supportrole')          return await panelBuilder.onSupportRoleSelect(interaction);
        if (interaction.customId === 'ticket_panel_editbtn_select')       return await panelBuilder.onEditBtnSelect(interaction);
        if (interaction.customId.startsWith('ticket_panel_btn_category')) return await panelBuilder.onBtnCategorySelect(interaction);
        if (interaction.customId.startsWith('ticket_panel_btn_rolesel'))  return await panelBuilder.onBtnRoleSelect(interaction);
      } catch (err) {
        console.error('[Select]', interaction.customId, err);
        await safeErrorReply(interaction, err);
      }
      return;
    }

    // ── Modal Submissions ──────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      try {
        if (interaction.customId === 'embed_edit_modal')                      return await embedBuilder.onEditModal(interaction);
        if (interaction.customId === 'embed_field_add_modal')                return await embedBuilder.onFieldAddModal(interaction);
        if (interaction.customId === 'embed_images_modal')                   return await embedBuilder.onImagesModal(interaction);
        if (interaction.customId.startsWith('ticket_panel_modal:'))          return await panelBuilder.onModalSubmit(interaction);
        if (interaction.customId === 'ticket_panel_addbtn_modal')            return await panelBuilder.onAddButtonModalSubmit(interaction);
        if (interaction.customId.startsWith('ticket_qs_form:'))             return await handleTicketQsForm(interaction);
        if (interaction.customId.startsWith('ticket_qs_setup:'))            return await handleQsSetup(interaction);
        if (interaction.customId.startsWith('ticket_edit_modal:'))          return await handleEditModal(interaction);
        if (interaction.customId.startsWith('ticket_panel_editbtn_modal:')) return await panelBuilder.onEditBtnModalSubmit(interaction);
      } catch (err) {
        console.error('[Modal]', interaction.customId, err);
        await safeErrorReply(interaction, err);
      }
      return;
    }
  },
};

// ─── Ticket create button click ───────────────────────────────────────────────

async function handleTicketCreate(interaction) {
  const prefix = interaction.customId.split(':')[1] || 'ticket';

  const cfg    = ticketConfig.get.get(interaction.guildId);
  const btnCfg = ticketQuestions.get.get(interaction.guildId, prefix);

  if (!btnCfg?.category_id && !cfg?.category_id)
    return interaction.reply({ embeds: [embeds.error('Not configured', 'No ticket panel has been set up yet.')], ephemeral: true });

  const existing = tickets.listOpen.all(interaction.guildId).find(t => t.owner_id === interaction.user.id);
  if (existing)
    return interaction.reply({ embeds: [embeds.warning('Already open', `You already have a ticket open: <#${existing.channel_id}>`)], ephemeral: true });

  const qRow  = btnCfg;
  const qList = qRow?.questions ? JSON.parse(qRow.questions) : [];

  if (qList.length > 0) {
    const typeName = prefix.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const modal = new ModalBuilder()
      .setCustomId(`ticket_qs_form:${prefix}`)
      .setTitle(`${typeName} — Open a Ticket`);

    qList.slice(0, 5).forEach((q, i) => {
      const isParagraph = /explain|describe|proof|detail|reason|issue|problem/i.test(q.label);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`q${i}`)
            .setLabel(q.label.substring(0, 45))
            .setStyle(isParagraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(q.required)
            .setMaxLength(500)
        )
      );
    });

    return interaction.showModal(modal);
  }

  return createTicketChannel(interaction, prefix, []);
}

// ─── Ticket questions form modal submit ───────────────────────────────────────

async function handleTicketQsForm(interaction) {
  const prefix = interaction.customId.split(':')[1] || 'ticket';
  const qRow   = ticketQuestions.get.get(interaction.guildId, prefix);
  const qList  = qRow ? JSON.parse(qRow.questions) : [];

  const answers = qList.slice(0, 5).map((q, i) => ({
    question: q.label,
    answer:   interaction.fields.getTextInputValue(`q${i}`),
  }));

  return createTicketChannel(interaction, prefix, answers);
}

// ─── Admin questions setup modal submit ───────────────────────────────────────

async function handleQsSetup(interaction) {
  const prefix = interaction.customId.split(':')[1];
  const raw    = interaction.fields.getTextInputValue('questions').trim();

  const questions = raw
    ? raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5).map(l => ({
        label:    l.startsWith('*') ? l.slice(1).trim() : l,
        required: !l.startsWith('*'),
      }))
    : [];

  const existing = ticketQuestions.get.get(interaction.guildId, prefix);
  ticketQuestions.upsert.run({
    '@guild_id':         interaction.guildId,
    '@prefix':           prefix,
    '@questions':        JSON.stringify(questions),
    '@category_id':      existing?.category_id      ?? null,
    '@support_role_ids': existing?.support_role_ids ?? null,
  });

  await interaction.reply({
    embeds: [embeds.success('Questions Saved', `Set **${questions.length}** question(s) for **${prefix}** tickets.`)],
    ephemeral: true,
  });
}

// ─── Edit message modal submit ────────────────────────────────────────────────

async function handleEditModal(interaction) {
  const messageId = interaction.customId.split(':')[1];
  const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);

  if (!msg)
    return interaction.reply({ embeds: [embeds.error('Not found', 'Message could not be found.')], ephemeral: true });

  const newTitle = interaction.fields.getTextInputValue('title').trim();
  const newDesc  = interaction.fields.getTextInputValue('description').trim();

  if (msg.embeds.length > 0) {
    const old     = msg.embeds[0];
    const updated = EmbedBuilder.from(old);
    if (newTitle) updated.setTitle(newTitle); else updated.setTitle(null);
    if (newDesc)  updated.setDescription(newDesc); else updated.setDescription(null);
    await msg.edit({ embeds: [updated] });
  } else {
    await msg.edit({ content: newDesc || null });
  }

  await interaction.reply({ embeds: [embeds.success('Message Updated', 'The message has been edited.')], ephemeral: true });
}

// ─── Create ticket channel ────────────────────────────────────────────────────

async function createTicketChannel(interaction, prefix, answers) {
  await interaction.deferReply({ ephemeral: true });

  const cfg    = ticketConfig.get.get(interaction.guildId);
  const btnCfg = ticketQuestions.get.get(interaction.guildId, prefix);

  const categoryId = btnCfg?.category_id || cfg?.category_id;
  if (!categoryId)
    return interaction.editReply({ embeds: [embeds.error('Not configured', 'No ticket panel has been set up yet.')] });

  let supportRoleIds;
  if (btnCfg?.support_role_ids) {
    try { supportRoleIds = JSON.parse(btnCfg.support_role_ids); } catch { supportRoleIds = []; }
  } else {
    supportRoleIds = getSupportRoleIds(cfg);
  }

  const existing = tickets.listOpen.all(interaction.guildId).find(t => t.owner_id === interaction.user.id);
  if (existing)
    return interaction.editReply({ embeds: [embeds.warning('Already open', `You already have a ticket open: <#${existing.channel_id}>`)] });

  const typeName = prefix.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const num      = cfg.next_ticket_num;
  const guild    = interaction.guild;

  const sanitizedName = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 25) || 'user';

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny:  [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id,     allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...supportRoleIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
  ];

  const channel = await guild.channels.create({
    name: `${prefix}-${sanitizedName}`,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites,
  });

  const result = tickets.create.run({
    '@guild_id':   interaction.guildId,
    '@channel_id': channel.id,
    '@ticket_num': num,
    '@owner_id':   interaction.user.id,
    '@reason':     answers.length ? answers.map(a => `${a.question}: ${a.answer}`).join('\n') : null,
  });
  ticketConfig.bumpTicketNum.run(interaction.guildId);

  const ticketId    = result.lastInsertRowid;
  const displayName = interaction.member?.displayName ?? interaction.user.username;

  const greeting = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle(`🎫 ${typeName} — ${displayName}`)
    .setDescription(`Hello ${interaction.user}! Support staff will be with you shortly.`)
    .setFooter({ text: 'Use /ticket close to close this ticket.' })
    .setTimestamp();

  if (answers.length > 0) {
    greeting.addFields(answers.map(a => ({ name: a.question, value: a.answer || '—', inline: false })));
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim:${ticketId}`).setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_close:${ticketId}`).setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

  const pingContent = supportRoleIds.length
    ? `${interaction.user} ${supportRoleIds.map(id => `<@&${id}>`).join(' ')}`
    : `${interaction.user}`;

  await channel.send({ content: pingContent, embeds: [greeting], components: [row] });

  if (cfg.log_channel_id) {
    const logCh = await interaction.client.channels.fetch(cfg.log_channel_id).catch(() => null);
    if (logCh) {
      const logEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle(`${typeName} Ticket Opened`)
        .addFields(
          { name: 'User',    value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Type',    value: typeName, inline: true },
        )
        .setTimestamp();

      if (answers.length > 0) {
        logEmbed.addFields(answers.map(a => ({ name: a.question, value: a.answer || '—', inline: false })));
      }

      await logCh.send({ embeds: [logEmbed] }).catch(() => {});
    }
  }

  await interaction.editReply({ embeds: [embeds.success('Ticket Created', `Your ticket is open in ${channel}.`)] });
}
