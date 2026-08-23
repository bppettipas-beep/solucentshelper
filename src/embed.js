const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const sessions = new Map();
const BLUE = 0x5865F2;

function key(guildId, userId) { return `${guildId}:${userId}`; }

function parseColor(str) {
  const n = parseInt(str.replace('#', ''), 16);
  return isNaN(n) ? BLUE : n;
}

function preview(s) {
  const e = new EmbedBuilder().setColor(s.color);
  if (s.title)         e.setTitle(s.title);
  if (s.description)   e.setDescription(s.description);
  if (s.footer)        e.setFooter({ text: s.footer });
  if (s.authorName)    e.setAuthor({ name: s.authorName });
  if (s.imageUrl)      e.setImage(s.imageUrl);
  if (s.thumbnailUrl)  e.setThumbnail(s.thumbnailUrl);
  if (s.fields.length) e.addFields(s.fields);
  if (!s.title && !s.description && !s.fields.length)
    e.setDescription('*(empty — click **Edit Embed** to add content)*');
  return e;
}

function panel(s) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('🖼️ Embed Builder')
    .setDescription(`Posting to <#${s.channelId}>`)
    .addFields(
      { name: 'Title',     value: s.title      || '—', inline: true },
      { name: 'Color',     value: `#${s.color.toString(16).padStart(6, '0').toUpperCase()}`, inline: true },
      { name: 'Fields',    value: String(s.fields.length), inline: true },
      { name: 'Footer',    value: s.footer      || '—', inline: true },
      { name: 'Author',    value: s.authorName  || '—', inline: true },
      { name: 'Images',    value: (s.imageUrl || s.thumbnailUrl) ? '✅ Set' : '—', inline: true },
    )
    .setFooter({ text: 'Click Post when your embed is ready.' });
}

function rows(s) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('embed_edit').setLabel('Edit Embed').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('embed_field_add').setLabel('Add Field').setEmoji('➕').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('embed_field_remove').setLabel('Remove Field').setEmoji('➖').setStyle(ButtonStyle.Secondary).setDisabled(s.fields.length === 0),
      new ButtonBuilder().setCustomId('embed_images').setLabel('Images').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('embed_post').setLabel('Post').setEmoji('📤').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('embed_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function refresh(interaction, s) {
  return interaction.update({ embeds: [preview(s), panel(s)], components: rows(s) });
}

// ─── /embed start ─────────────────────────────────────────────────────────────

async function start(interaction, channelId) {
  const s = { channelId, title: '', description: '', color: BLUE, footer: '', authorName: '', imageUrl: '', thumbnailUrl: '', fields: [] };
  sessions.set(key(interaction.guildId, interaction.user.id), s);
  await interaction.reply({ embeds: [preview(s), panel(s)], components: rows(s), ephemeral: true });
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

async function onEdit(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });

  await interaction.showModal(
    new ModalBuilder().setCustomId('embed_edit_modal').setTitle('Edit Embed').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(s.title)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(s.description)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color (hex, e.g. #5865F2)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7).setValue(`#${s.color.toString(16).padStart(6, '0').toUpperCase()}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer Text').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2048).setValue(s.footer)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('author').setLabel('Author Name').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(s.authorName)),
    )
  );
}

async function onFieldAdd(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });
  if (s.fields.length >= 25) return interaction.reply({ content: 'Maximum of 25 fields reached.', ephemeral: true });

  await interaction.showModal(
    new ModalBuilder().setCustomId('embed_field_add_modal').setTitle('Add Field').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Field Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value').setLabel('Field Value').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1024)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inline').setLabel('Inline? (yes / no)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3).setValue('no')),
    )
  );
}

async function onFieldRemove(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });
  s.fields.pop();
  await refresh(interaction, s);
}

async function onImages(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });

  await interaction.showModal(
    new ModalBuilder().setCustomId('embed_images_modal').setTitle('Set Images').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (large, bottom)').setStyle(TextInputStyle.Short).setRequired(false).setValue(s.imageUrl)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('Thumbnail URL (small, top-right)').setStyle(TextInputStyle.Short).setRequired(false).setValue(s.thumbnailUrl)),
    )
  );
}

async function onPost(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });
  if (!s.title && !s.description && !s.fields.length)
    return interaction.reply({ content: 'Add at least a title or description before posting.', ephemeral: true });

  const ch = await interaction.client.channels.fetch(s.channelId).catch(() => null);
  if (!ch) return interaction.reply({ content: 'Target channel not found.', ephemeral: true });

  await ch.send({ embeds: [preview(s)] });
  sessions.delete(key(interaction.guildId, interaction.user.id));

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Embed Posted').setDescription(`Your embed has been sent to <#${s.channelId}>.`)],
    components: [],
  });
}

async function onCancel(interaction) {
  sessions.delete(key(interaction.guildId, interaction.user.id));
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(BLUE).setTitle('Embed Builder Cancelled')],
    components: [],
  });
}

// ─── Modals ───────────────────────────────────────────────────────────────────

async function onEditModal(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });

  s.title       = interaction.fields.getTextInputValue('title').trim();
  s.description = interaction.fields.getTextInputValue('description').trim();
  s.footer      = interaction.fields.getTextInputValue('footer').trim();
  s.authorName  = interaction.fields.getTextInputValue('author').trim();
  const colorRaw = interaction.fields.getTextInputValue('color').trim();
  if (colorRaw) s.color = parseColor(colorRaw);

  await refresh(interaction, s);
}

async function onFieldAddModal(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });

  s.fields.push({
    name:   interaction.fields.getTextInputValue('name').trim(),
    value:  interaction.fields.getTextInputValue('value').trim(),
    inline: interaction.fields.getTextInputValue('inline').trim().toLowerCase() === 'yes',
  });
  await refresh(interaction, s);
}

async function onImagesModal(interaction) {
  const s = sessions.get(key(interaction.guildId, interaction.user.id));
  if (!s) return interaction.reply({ content: 'Session expired — run `/embed` again.', ephemeral: true });

  s.imageUrl     = interaction.fields.getTextInputValue('image').trim();
  s.thumbnailUrl = interaction.fields.getTextInputValue('thumbnail').trim();
  await refresh(interaction, s);
}

module.exports = { start, onEdit, onFieldAdd, onFieldRemove, onImages, onPost, onCancel, onEditModal, onFieldAddModal, onImagesModal };
