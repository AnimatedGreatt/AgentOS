require("dotenv").config();
const { REST, Routes } = require("discord.js");
const fs = require("fs");

const commands = [];
const commandFiles = fs.readdirSync("./commands").filter(file => file.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  // Safety: log command name and validate shape before pushing
  try {
    if (!command || !command.data) {
      console.error('Command file missing `data` export:', file);
    } else {
      console.log('Found command:', file, '->', command.data.name || command.data?.toJSON?.().name);
      commands.push(command.data.toJSON());
    }
  } catch (e) {
    console.error('Failed to process command file:', file, e);
  }
}

// Detect duplicate command names before sending to Discord
const nameMap = {};
for (let i = 0; i < commands.length; i++) {
  const c = commands[i];
  const n = c.name;
  if (!n) continue;
  nameMap[n] = nameMap[n] || [];
  nameMap[n].push(i);
}
for (const [n, idxs] of Object.entries(nameMap)) {
  if (idxs.length > 1) {
    console.error('Duplicate command name detected in local files:', n, 'indexes:', idxs);
  }
}

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
const applicationId = process.env.APPLICATION_ID || process.env.DISCORD_APPLICATION_ID || process.env.CLIENT_ID;

if (!applicationId) {
  console.error('Missing Discord application ID. Set APPLICATION_ID or DISCORD_APPLICATION_ID before deploying commands.');
  process.exit(1);
}

(async () => {
  try {
    console.log("Registering slash commands... :3");
    await rest.put(
      Routes.applicationCommands(applicationId),
      { body: commands }
    );
    console.log("Commands registered.");
  } catch (error) {
    console.error(error);
  }
})();
