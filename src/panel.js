const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { ticketConfig, ticketQuestions } = require('./database');
const embeds = require('./utils');

const builders = new Map();

async function respondToModal(interaction, payload) {
  if (interaction.message) {
    const { ephemeral, ...updatePayload } = payload;
    await interaction.update(updatePayload);
  } else {
    await interaction.reply(payload);
  }
}

const STYLES = {
  blue:  { label: 'Blue',  style: ButtonStyle.Primary   },
  green: { label: 'Green', style: ButtonStyle.Success   },
  red:   { label: 'Red',   style: ButtonStyle.Danger    },
  grey:  { label: 'Grey',  style: ButtonStyle.Secondary },
};

function parseColor(str) {
  if (!str) return 0x3498DB;
  const n = parseInt(str.replace('#', '').trim(), 16);
  return isNaN(n) ? 0x3498DB : n;
}

function resolveStyle(str) { return STYLES[str?.toLowerCase()] ?? STYLES.blue; }

function builderPayload(config) {
  const previewEmbed = new EmbedBuilder()
    .setColor(config.color).setTitle(config.title).setDescription(config.description)
    .setFooter({ text: 'Panel Preview' });

  const buttonLines = config.buttons.length
    ? config.buttons.map((b, i) => {
        const style    = resolveStyle(b.style);
        const emoji    = b.emoji ? `${b.emoji} ` : '';
        const qNote    = b.questions?.length ? ` · ${b.questions.length}Q` : '';
        const catNote  = b.categoryId ? ' · 📁' : '';
        const roleNote = b.supportRoleIds?.length ? ` · 🛡️(${b.supportRoleIds.length})` : '';
        return `**${i + 1}.** ${emoji}**${b.label}** (${style.label}) → \`${b.prefix || 'ticket'}-####\`${qNote}${catNote}${roleNote}`;
      }).join('\n')
    : '*No buttons added yet — click ➕ Add Button*';

  const rolesValue = config.supportRoleIds?.length ? config.supportRoleIds.map(id => `<@&${id}>`).join(', ') : '❌ Not set';

  const configEmbed = new EmbedBuilder()
    .setColor(0x5865F2).setTitle('⚙️ Panel Configuration')
    .addFields(
      { name: '📁 Ticket Category', value: config.categoryId   ? `<#${config.categoryId}>`   : '❌ Not set', inline: true },
      { name: '📋 Log Channel',     value: config.logChannelId ? `<#${config.logChannelId}>` : '❌ Not set', inline: true },
      { name: `🛡️ Support Roles (${config.supportRoleIds?.length ?? 0})`, value: rolesValue, inline: false },
      { name: `🔘 Buttons (${config.buttons.length}/5)`, value: buttonLines },
    )
    .setFooter({ text: 'Category, log channel, at least one support role, and one button must be set.' });

  const categoryRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('ticket_panel_category')
      .setPlaceholder(config.categoryId ? '✅ Category set — click to change' : '📁 Select ticket category...')
      .setChannelTypes(ChannelType.GuildCategory)
  );
  const logRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('ticket_panel_logchannel')
      .setPlaceholder(config.logChannelId ? '✅ Log channel set — click to change' : '📋 Select log channel...')
      .setChannelTypes(ChannelType.GuildText)
  );
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('ticket_panel_supportrole')
      .setPlaceholder(config.supportRoleIds?.length ? '✅ Roles set — select again to replace' : '🛡️ Select support roles...')
      .setMinValues(1).setMaxValues(10)
  );

  const ready = config.categoryId && config.logChannelId && config.supportRoleIds?.length > 0 && config.buttons.length > 0;
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_panel_addbtn').setLabel('Add Button').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(config.buttons.length >= 5),
    new ButtonBuilder().setCustomId('ticket_panel_removebtn').setLabel('Remove Last').setEmoji('↩️').setStyle(ButtonStyle.Secondary).setDisabled(config.buttons.length === 0),
    new ButtonBuilder().setCustomId('ticket_panel_edit').setLabel('Edit Text').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket_panel_post').setLabel('Post Panel').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId('ticket_panel_cancel').setLabel('Cancel').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );

  const components = [categoryRow, logRow, roleRow];
  if (config.buttons.length > 0) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('ticket_panel_editbtn_select')
        .setPlaceholder('✏️ Select a button to edit...')
        .addOptions(config.buttons.map((b, i) => ({
          label:       (b.label || `Button ${i + 1}`).substring(0, 100),
          value:       String(i),
          description: `prefix: ${b.prefix || 'ticket'} · ${b.questions?.length ?? 0} question(s)`,
        })))
    ));
  }
  components.push(actionRow);
  return { embeds: [previewEmbed, configEmbed], components };
}

function buttonConfigPayload(config, index) {
  const btn = config.buttons[index];
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`⚙️ Configure: ${btn.label}`)
    .setDescription('Set a **specific category and support roles** for this ticket type.\nLeave unset to inherit the panel\'s global defaults.')
    .addFields(
      { name: '📁 Category',      value: btn.categoryId            ? `<#${btn.categoryId}>`                                   : '*(uses panel default)*', inline: true },
      { name: '🛡️ Support Roles', value: btn.supportRoleIds?.length ? btn.supportRoleIds.map(id => `<@&${id}>`).join(', ')    : '*(uses panel defaults)*', inline: true },
    );

  const categoryRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`ticket_panel_btn_category:${index}`)
      .setPlaceholder(btn.categoryId ? '✅ Category set — click to change' : '📁 Select category for this ticket type...')
      .setChannelTypes(ChannelType.GuildCategory)
  );
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId(`ticket_panel_btn_rolesel:${index}`)
      .setPlaceholder(btn.supportRoleIds?.length ? '✅ Roles set — select to replace' : '🛡️ Select support roles for this ticket type...')
      .setMinValues(1).setMaxValues(10)
  );
  const clearBtns = [];
  if (btn.categoryId)         clearBtns.push(new ButtonBuilder().setCustomId(`ticket_panel_btn_clearcat:${index}`).setLabel('Clear Category').setStyle(ButtonStyle.Secondary));
  if (btn.supportRoleIds?.length) clearBtns.push(new ButtonBuilder().setCustomId(`ticket_panel_btn_clearroles:${index}`).setLabel('Clear Roles').setStyle(ButtonStyle.Secondary));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_panel_btn_done:${index}`).setLabel('Done').setEmoji('✅').setStyle(ButtonStyle.Success),
    ...clearBtns,
  );
  return { embeds: [embed], components: [categoryRow, roleRow, actionRow], ephemeral: true };
}

async function onModalSubmit(interaction) {
  const channelId   = interaction.customId.split(':')[1];
  const title       = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const colorRaw    = interaction.fields.getTextInputValue('color').trim();
  const existing    = builders.get(interaction.user.id) ?? {};
  const config = { channelId, title, description, color: parseColor(colorRaw), categoryId: existing.categoryId ?? null, logChannelId: existing.logChannelId ?? null, supportRoleIds: existing.supportRoleIds ?? [], buttons: existing.buttons ?? [] };
  builders.set(interaction.user.id, config);
  await respondToModal(interaction, { ...builderPayload(config), ephemeral: true });
}

async function onAddButtonModalSubmit(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const label        = interaction.fields.getTextInputValue('btn_label').trim();
  const emoji        = interaction.fields.getTextInputValue('btn_emoji').trim();
  const prefix       = interaction.fields.getTextInputValue('btn_prefix').trim().toLowerCase().replace(/\s+/g, '-') || 'ticket';
  const style        = interaction.fields.getTextInputValue('btn_style').trim().toLowerCase();
  const questionsRaw = interaction.fields.getTextInputValue('btn_questions').trim();
  const questions    = questionsRaw ? questionsRaw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5).map(l => ({ label: l.startsWith('*') ? l.slice(1).trim() : l, required: !l.startsWith('*') })) : [];
  config.buttons.push({ label, emoji, style, prefix, questions, categoryId: null, supportRoleIds: [] });
  builders.set(interaction.user.id, config);
  await respondToModal(interaction, buttonConfigPayload(config, config.buttons.length - 1));
}

async function onAddButtonBtn(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const modal = new ModalBuilder().setCustomId('ticket_panel_addbtn_modal').setTitle('Add Ticket Button');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_label').setLabel('Button Label').setStyle(TextInputStyle.Short).setPlaceholder('e.g. General Support').setMaxLength(80).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 🎫').setMaxLength(10).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_prefix').setLabel('Ticket Name Prefix').setStyle(TextInputStyle.Short).setPlaceholder('e.g. support → channel: support-0001').setMaxLength(20).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_style').setLabel('Button Color (blue / green / red / grey)').setStyle(TextInputStyle.Short).setPlaceholder('blue').setMaxLength(10).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_questions').setLabel('Questions (one per line, * = optional)').setStyle(TextInputStyle.Paragraph).setPlaceholder('Are you buying or selling?\nHow many units?\n*Any notes?').setMaxLength(500).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function onRemoveLastBtn(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config || config.buttons.length === 0) return interaction.reply({ embeds: [embeds.error('No buttons', 'Nothing to remove.')], ephemeral: true });
  config.buttons.pop();
  await interaction.update(builderPayload(config));
}

async function onCategorySelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  config.categoryId = interaction.values[0];
  await interaction.update(builderPayload(config));
}

async function onLogChannelSelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  config.logChannelId = interaction.values[0];
  await interaction.update(builderPayload(config));
}

async function onSupportRoleSelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  config.supportRoleIds = interaction.values;
  await interaction.update(builderPayload(config));
}

async function onEditButton(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const modal = new ModalBuilder().setCustomId(`ticket_panel_modal:${config.channelId}`).setTitle('Edit Panel Text');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel Title').setStyle(TextInputStyle.Short).setValue(config.title).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel Description').setStyle(TextInputStyle.Paragraph).setValue(config.description).setMaxLength(2000).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Embed Color (hex, e.g. 3498DB)').setStyle(TextInputStyle.Short).setValue(config.color.toString(16).toUpperCase().padStart(6, '0')).setMaxLength(7).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function onPostButton(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  if (config.buttons.length === 0) return interaction.reply({ embeds: [embeds.error('No buttons', 'Add at least one button before posting.')], ephemeral: true });
  if (!config.editMessageId && (!config.categoryId || !config.logChannelId || !config.supportRoleIds?.length))
    return interaction.reply({ embeds: [embeds.error('Incomplete', 'Fill in category, log channel, and at least one support role.')], ephemeral: true });

  await interaction.deferUpdate();
  const channel = await interaction.client.channels.fetch(config.channelId).catch(() => null);
  if (!channel) return interaction.editReply({ embeds: [embeds.error('Channel not found', 'The target channel could not be found.')], components: [] });

  const panelEmbed = new EmbedBuilder().setColor(config.color).setTitle(config.title).setDescription(config.description).setFooter({ text: "Solucent's Helper • Ticket System" });
  const buttonComponents = config.buttons.map(b => {
    const { style } = resolveStyle(b.style);
    const btn = new ButtonBuilder().setCustomId(`ticket_create:${b.prefix}`).setLabel(b.label).setStyle(style);
    if (b.emoji) btn.setEmoji(b.emoji);
    return btn;
  });
  const panelPayload = { embeds: [panelEmbed], components: [new ActionRowBuilder().addComponents(buttonComponents)] };

  let panelMsgId;
  if (config.editMessageId) {
    const existing = await channel.messages.fetch(config.editMessageId).catch(() => null);
    if (!existing) return interaction.editReply({ embeds: [embeds.error('Original message not found', 'It may have been deleted.')], components: [] });
    await existing.edit(panelPayload);
    panelMsgId = config.editMessageId;
  } else {
    panelMsgId = (await channel.send(panelPayload)).id;
  }

  const existingCfg = ticketConfig.get.get(interaction.guildId);
  ticketConfig.upsert.run({ '@guild_id': interaction.guildId, '@category_id': config.categoryId, '@log_channel_id': config.logChannelId, '@support_role_id': config.supportRoleIds[0] ?? null, '@support_role_ids': JSON.stringify(config.supportRoleIds), '@panel_channel_id': config.channelId, '@panel_message_id': panelMsgId, '@next_ticket_num': existingCfg?.next_ticket_num ?? 1 });

  for (const b of config.buttons) {
    ticketQuestions.upsert.run({ '@guild_id': interaction.guildId, '@prefix': b.prefix || 'ticket', '@questions': JSON.stringify(b.questions || []), '@category_id': b.categoryId || null, '@support_role_ids': b.supportRoleIds?.length ? JSON.stringify(b.supportRoleIds) : null });
  }

  builders.delete(interaction.user.id);
  const verb = config.editMessageId ? 'Updated' : 'Posted';
  await interaction.editReply({ embeds: [embeds.success(`Panel ${verb}!`, `Your ticket panel in <#${config.channelId}> has been ${verb.toLowerCase()}.`)], components: [] });
}

async function onCancelButton(interaction) {
  builders.delete(interaction.user.id);
  await interaction.update({ embeds: [embeds.info('Cancelled', 'Panel builder closed.')], components: [] });
}

async function onEditBtnSelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.values[0], 10);
  const btn   = config.buttons[index];
  if (!btn) return interaction.reply({ embeds: [embeds.error('Button not found', 'That button no longer exists.')], ephemeral: true });
  const questionsText = btn.questions?.length ? btn.questions.map(q => (q.required ? '' : '*') + q.label).join('\n') : '';
  const modal = new ModalBuilder().setCustomId(`ticket_panel_editbtn_modal:${index}`).setTitle(`Edit: ${btn.label.substring(0, 40)}`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_label').setLabel('Button Label').setStyle(TextInputStyle.Short).setValue(btn.label).setMaxLength(80).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setValue(btn.emoji || '').setMaxLength(10).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_prefix').setLabel('Ticket Name Prefix').setStyle(TextInputStyle.Short).setValue(btn.prefix || 'ticket').setMaxLength(20).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_style').setLabel('Button Color (blue / green / red / grey)').setStyle(TextInputStyle.Short).setValue(btn.style || 'blue').setMaxLength(10).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('btn_questions').setLabel('Questions (one per line, * = optional)').setStyle(TextInputStyle.Paragraph).setValue(questionsText).setMaxLength(500).setRequired(false)),
  );
  await interaction.showModal(modal);
}

async function onEditBtnModalSubmit(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(index) || index < 0 || index >= config.buttons.length) return;
  const label        = interaction.fields.getTextInputValue('btn_label').trim();
  const emoji        = interaction.fields.getTextInputValue('btn_emoji').trim();
  const prefix       = interaction.fields.getTextInputValue('btn_prefix').trim().toLowerCase().replace(/\s+/g, '-') || 'ticket';
  const style        = interaction.fields.getTextInputValue('btn_style').trim().toLowerCase();
  const questionsRaw = interaction.fields.getTextInputValue('btn_questions').trim();
  const questions    = questionsRaw ? questionsRaw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5).map(l => ({ label: l.startsWith('*') ? l.slice(1).trim() : l, required: !l.startsWith('*') })) : [];
  config.buttons[index] = { label, emoji, style, prefix, questions, categoryId: config.buttons[index]?.categoryId ?? null, supportRoleIds: config.buttons[index]?.supportRoleIds ?? [] };
  builders.set(interaction.user.id, config);
  await respondToModal(interaction, buttonConfigPayload(config, index));
}

async function onBtnCategorySelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(index) || index >= config.buttons.length) return;
  config.buttons[index].categoryId = interaction.values[0];
  await interaction.update(buttonConfigPayload(config, index));
}

async function onBtnRoleSelect(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(index) || index >= config.buttons.length) return;
  config.buttons[index].supportRoleIds = interaction.values;
  await interaction.update(buttonConfigPayload(config, index));
}

async function onBtnDone(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  await interaction.update(builderPayload(config));
}

async function onBtnClearCat(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(index) || index >= config.buttons.length) return;
  config.buttons[index].categoryId = null;
  await interaction.update(buttonConfigPayload(config, index));
}

async function onBtnClearRoles(interaction) {
  const config = builders.get(interaction.user.id);
  if (!config) return interaction.reply({ embeds: [embeds.error('Session expired', 'Run `/ticket panel` again.')], ephemeral: true });
  const index = parseInt(interaction.customId.split(':')[1], 10);
  if (isNaN(index) || index >= config.buttons.length) return;
  config.buttons[index].supportRoleIds = [];
  await interaction.update(buttonConfigPayload(config, index));
}

async function openForEdit(interaction, config) {
  for (const b of config.buttons) {
    const row = ticketQuestions.get.get(interaction.guildId, b.prefix || 'ticket');
    b.categoryId     = row?.category_id ?? null;
    b.supportRoleIds = row?.support_role_ids ? (() => { try { return JSON.parse(row.support_role_ids); } catch { return []; } })() : [];
  }
  builders.set(interaction.user.id, config);
  await interaction.reply({ ...builderPayload(config), ephemeral: true });
}

module.exports = { onModalSubmit, onAddButtonModalSubmit, onAddButtonBtn, onRemoveLastBtn, onEditBtnSelect, onEditBtnModalSubmit, onCategorySelect, onLogChannelSelect, onSupportRoleSelect, onEditButton, onPostButton, onCancelButton, openForEdit, onBtnCategorySelect, onBtnRoleSelect, onBtnDone, onBtnClearCat, onBtnClearRoles };
