const cron = require('node-cron');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { donutConfig, donutMembers, donutRounds, donutPairings, donutStats, db } = require('./database');
const { generatePairings, getRandomPrompt } = require('./utils');

const activeTasks = new Map();

function reschedule(client) {
  for (const [guildId, task] of activeTasks) { task.stop(); activeTasks.delete(guildId); }
  const configs = db.prepare('SELECT * FROM donut_config WHERE active = 1').all();
  for (const cfg of configs) scheduleGuild(client, cfg);
}

function scheduleGuild(client, cfg) {
  if (!cron.validate(cfg.cron_expression)) return;
  const task = cron.schedule(cfg.cron_expression, async () => { await runRound(client, cfg.guild_id); }, { timezone: 'UTC' });
  activeTasks.set(cfg.guild_id, task);
}

async function runRound(client, guildId) {
  const cfg = donutConfig.get.get(guildId);
  if (!cfg) return { ok: false, message: 'Donut system is not configured for this server.' };

  const prev = donutRounds.getActive.get(guildId);
  if (prev) donutRounds.complete.run(prev.id);

  const members = donutMembers.getActive.all(guildId);
  if (members.length < 2) return { ok: false, message: 'Not enough active members to form a round (need at least 2).' };

  const memberIds = members.map(m => m.user_id);
  const { pairs, leftover } = generatePairings(guildId, memberIds);
  if (pairs.length === 0) return { ok: false, message: 'Could not form any pairs.' };

  const round   = donutRounds.create.get(guildId);
  const roundId = round.id;

  for (const [u1, u2] of pairs) {
    const prompt = getRandomPrompt(cfg.prompt_category);
    donutPairings.create.run({ '@round_id': roundId, '@guild_id': guildId, '@user1_id': u1, '@user2_id': u2, '@prompt': prompt });
    donutStats.upsertInit.run(guildId, u1);
    donutStats.upsertInit.run(guildId, u2);
    donutStats.incrementTotal.run(guildId, u1);
    donutStats.incrementTotal.run(guildId, u2);
  }

  const announceChannel = await client.channels.fetch(cfg.announce_channel_id).catch(() => null);
  if (announceChannel) {
    const roundFields = [
      { name: 'Participants', value: String(memberIds.length), inline: true },
      { name: 'Pairs Created', value: String(pairs.length),   inline: true },
    ];
    if (leftover) roundFields.push({ name: 'Odd one out', value: `<@${leftover}> — you'll be in the next round!`, inline: true });

    await announceChannel.send({
      embeds: [
        new EmbedBuilder().setColor(0x3498DB).setTitle('🍩 New Donut Round!')
          .setDescription(`A new round of donuts has started! **${pairs.length} pairs** have been matched.\n\nCheck your DMs for your pairing and a conversation prompt. Use \`/donut complete\` once you've had your chat, or \`/donut skip\` to pass.`)
          .addFields(roundFields).setFooter({ text: "Solucent's Helper" }).setTimestamp(),
      ],
    }).catch(() => {});
  }

  for (const row of donutPairings.getByRound.all(roundId)) {
    await sendPairingDMs(client, row);
  }

  return { ok: true, pairs: pairs.length, message: `Round started with ${pairs.length} pairs.` };
}

async function sendPairingDMs(client, pairing) {
  const prompt = pairing.prompt;
  const embed = partnerId => new EmbedBuilder().setColor(0x3498DB).setTitle('🍩 You have a new Donut!')
    .setDescription(`You've been paired with <@${partnerId}> for this round!\n\n**Conversation starter:**\n> ${prompt}\n\nReach out and schedule a quick chat. Once you're done, use \`/donut complete\` in the server to track it!`)
    .setFooter({ text: "Solucent's Helper • Reply /donut skip if you need to pass" }).setTimestamp();

  const completeRow = pairingId => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`donut_complete:${pairingId}`).setLabel('Mark as Completed').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`donut_skip:${pairingId}`).setLabel('Skip This Round').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
  );

  for (const uid of [pairing.user1_id, pairing.user2_id]) {
    const partnerId = uid === pairing.user1_id ? pairing.user2_id : pairing.user1_id;
    try {
      const user = await client.users.fetch(uid);
      await user.send({ embeds: [embed(partnerId)], components: [completeRow(pairing.id)] });
    } catch { /* DMs disabled */ }
  }

  donutPairings.markDmSent.run(pairing.id);
}

module.exports = { reschedule, runRound, scheduleGuild };
