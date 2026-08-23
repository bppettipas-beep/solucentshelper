require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { reschedule } = require('./src/scheduler');
const interactions  = require('./src/interactions');
const commands      = require('./src/commands');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Load commands ────────────────────────────────────────────────────────────

client.commands = new Collection();
for (const cmd of commands) client.commands.set(cmd.data.name, cmd);

// ─── Events ───────────────────────────────────────────────────────────────────

client.once('clientReady', async c => {
  console.log(`[Ready] Logged in as ${c.user.tag}`);

  const seen = new Set();
  const commandData = commands
    .filter(command => seen.has(command.data.name) ? false : seen.add(command.data.name))
    .map(command => command.data.toJSON());

  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set(commandData);
      console.log(`[Commands] Registered ${commandData.length} command(s) in ${guild.name} (${guild.id}).`);
    } catch (err) {
      console.error(`[Commands] Failed to register commands in ${guild.name} (${guild.id}):`, err);
    }
  }

  reschedule(client);
});

client.on('interactionCreate', (...args) => interactions.execute(...args));

// ─── Start ────────────────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('[Error] DISCORD_TOKEN is not set. Copy .env.example to .env and fill in your token.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('[Error] Failed to login:', err.message);
  process.exit(1);
});
