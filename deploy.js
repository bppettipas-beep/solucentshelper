require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('./src/commands');

const seen   = new Set();
const unique = commands.filter(c => seen.has(c.data.name) ? false : seen.add(c.data.name)).map(c => c.data.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  const guildIds = process.env.GUILD_ID
    ? process.env.GUILD_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  console.log(`Deploying ${unique.length} command(s)...`);

  if (guildIds.length === 0) {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: unique });
    console.log('Commands deployed globally.');
  } else {
    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: unique });
        console.log(`Commands deployed to guild ${guildId}.`);
      } catch (err) {
        console.error(`Failed to deploy to guild ${guildId}: ${err.message}`);
      }
    }
  }
})();
