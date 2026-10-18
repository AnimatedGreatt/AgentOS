const fs = require("fs");
const path = require("path");
const { Collection } = require("discord.js");

/**
 * Loads all command modules from the commands directory
 * @param {Client} client - Discord client instance
 */
function loadCommands(client) {
  client.commands = new Collection();

  const commandsPath = path.join(__dirname, "..", "commands");
  const commandFiles = fs.readdirSync(commandsPath, { recursive: true }).filter(file => file.endsWith(".js"));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
  }

  console.info && console.info(`Loaded ${client.commands.size} command(s)`);
}

module.exports = { loadCommands };
