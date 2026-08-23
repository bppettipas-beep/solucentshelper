const { EmbedBuilder } = require('discord.js');
const { tickets, donutPairings } = require('./database');

// ─── Embeds ───────────────────────────────────────────────────────────────────

const COLORS = { primary: 0x3498DB, success: 0x57F287, error: 0xED4245, warning: 0xFEE75C, info: 0x5865F2, neutral: 0x99AAB5 };

function primary(title, description) { return new EmbedBuilder().setColor(COLORS.primary).setTitle(title).setDescription(description ?? null); }
function success(title, description) { return new EmbedBuilder().setColor(COLORS.success).setTitle(`✅ ${title}`).setDescription(description ?? null); }
function error(title, description)   { return new EmbedBuilder().setColor(COLORS.error).setTitle(`❌ ${title}`).setDescription(description ?? null); }
function warning(title, description) { return new EmbedBuilder().setColor(COLORS.warning).setTitle(`⚠️ ${title}`).setDescription(description ?? null); }
function info(title, description)    { return new EmbedBuilder().setColor(COLORS.info).setTitle(`ℹ️ ${title}`).setDescription(description ?? null); }
function donut(title, description)   { return new EmbedBuilder().setColor(COLORS.primary).setTitle(`🍩 ${title}`).setDescription(description ?? null); }

// ─── Ticket utils ─────────────────────────────────────────────────────────────

async function generateTranscript(channel, ticket, cfg, client) {
  if (!cfg?.log_channel_id) return;
  const logCh = await client.channels.fetch(cfg.log_channel_id).catch(() => null);
  if (!logCh) return;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages || messages.size === 0) return;
  const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = sorted.map(m => {
    const time   = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const author = m.author.bot ? `[BOT] ${m.author.username}` : `${m.author.username} (${m.author.id})`;
    const parts  = [];
    if (m.content) parts.push(m.content);
    for (const e of m.embeds) {
      const ep = [];
      if (e.title)       ep.push(`[Embed: ${e.title}]`);
      if (e.description) ep.push(e.description.substring(0, 300));
      parts.push(ep.join(' — ') || '[Embed]');
    }
    if (m.attachments.size) parts.push(`[${m.attachments.size} attachment(s)]`);
    return `[${time}] ${author}: ${parts.join(' | ') || '[no content]'}`;
  });
  const header = [`Ticket #${ticket.ticket_num} — Transcript`, '='.repeat(60), `Opened by : ${ticket.owner_id}`, `Channel   : ${channel.name}`, `Generated : ${new Date().toISOString()}`, '='.repeat(60), ''].join('\n');
  await logCh.send({
    embeds: [
      new EmbedBuilder().setColor(0xED4245).setTitle('🎫 Ticket Closed')
        .addFields(
          { name: 'Ticket #',   value: String(ticket.ticket_num), inline: true },
          { name: 'Opened by', value: `<@${ticket.owner_id}>`,    inline: true },
          { name: 'Messages',  value: String(sorted.length),       inline: true },
        )
        .setFooter({ text: 'Transcript attached below' }).setTimestamp(),
    ],
    files: [{ attachment: Buffer.from(header + lines.join('\n'), 'utf-8'), name: `ticket-${ticket.ticket_num}-transcript.txt` }],
  }).catch(err => console.error('[Transcript]', err));
}

async function closeTicket(interaction, ticket, cfg) {
  tickets.update.run({ '@id': ticket.id, '@status': 'closed', '@claimed_by': ticket.claimed_by ?? null, '@closed_at': Math.floor(Date.now() / 1000) });
  await generateTranscript(interaction.channel, ticket, cfg, interaction.client);
  const send = (interaction.deferred || interaction.replied) ? p => interaction.editReply(p) : p => interaction.reply(p);
  await send({ embeds: [info('Ticket Closed', 'This channel will be deleted in 5 seconds.')] });
  setTimeout(() => interaction.channel.delete().catch(err => console.error('[Ticket Delete]', err)), 5000);
}

// ─── Pairing ──────────────────────────────────────────────────────────────────

function generatePairings(guildId, memberIds) {
  if (memberIds.length < 2) return { pairs: [], leftover: memberIds[0] ?? null };
  const previousPairs = new Set();
  for (const uid of memberIds) {
    for (const row of donutPairings.getPreviousPairs.all(guildId, uid, uid)) {
      previousPairs.add([row.user1_id, row.user2_id].sort().join(':'));
    }
  }
  const pool = [...memberIds].sort(() => Math.random() - 0.5);
  const pairs = [], used = new Set();
  for (let i = 0; i < pool.length; i++) {
    if (used.has(pool[i])) continue;
    for (let j = i + 1; j < pool.length; j++) {
      if (used.has(pool[j])) continue;
      const key = [pool[i], pool[j]].sort().join(':');
      if (!previousPairs.has(key)) { pairs.push([pool[i], pool[j]]); used.add(pool[i]); used.add(pool[j]); break; }
    }
  }
  const remaining = pool.filter(uid => !used.has(uid));
  for (let i = 0; i + 1 < remaining.length; i += 2) pairs.push([remaining[i], remaining[i + 1]]);
  return { pairs, leftover: pool.find(uid => !used.has(uid)) ?? null };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PROMPTS = {
  general: [
    "What's a skill you've been wanting to learn lately?",
    "If you could live anywhere in the world for a year, where would it be?",
    "What's the best book, show, or movie you've consumed recently?",
    "What does your ideal weekend look like?",
    "What's something you're really proud of from the last few months?",
    "If you could switch roles with anyone on the team for a week, who would it be?",
    "What's a hidden talent or hobby most people don't know you have?",
    "What's your favorite way to recharge after a long day?",
    "If you could have dinner with any historical figure, who would it be and why?",
    "What's a piece of advice you'd give your younger self?",
    "What's your go-to comfort food?",
    "What's a project you'd work on if you had an extra hour each day?",
    "What technology or trend are you most excited about right now?",
    "What's your morning routine like?",
    "If you could instantly master one skill, what would it be?",
  ],
  work: [
    "What part of your job do you find most energizing?",
    "What's the biggest lesson you've learned in your career so far?",
    "What tool or process has improved your work the most recently?",
    "What does an ideal workday look like for you?",
    "What's a problem you're currently trying to solve at work?",
    "What's something you wish you'd known earlier in your career?",
    "How do you stay focused when things get hectic?",
    "What project are you most excited about right now?",
    "What's a challenge you overcame that you're proud of?",
    "How do you prefer to give and receive feedback?",
  ],
  fun: [
    "What's the most unusual job you've ever had or considered?",
    "If your life had a theme song, what would it be?",
    "What's a rule you'd create if you ran the world for a day?",
    "What fictional universe would you most want to live in?",
    "What's the weirdest food combination you actually enjoy?",
    "If you were a superhero, what would your power be?",
    "What board game or video game could you play endlessly?",
    "What's on your bucket list that might surprise people?",
    "If you had to eat only one cuisine forever, which would you choose?",
    "What's the most adventurous thing you've ever done?",
  ],
};

function getRandomPrompt(category = 'general') {
  const pool = PROMPTS[category] ?? PROMPTS.general;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { COLORS, primary, success, error, warning, info, donut, generateTranscript, closeTicket, generatePairings, PROMPTS, getRandomPrompt };
