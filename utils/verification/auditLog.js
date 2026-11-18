const { ContainerBuilder, MessageFlags, TextDisplayBuilder } = require('discord.js');
const config = require('../../config');

async function send(client, title, details) {
  const channel = await client.channels.fetch(config.AUDITLOGS_ID);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('Verification audit channel is unavailable or cannot accept messages.');
  }

  return channel.send({
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${title}\n${details}`.slice(0, 4000))
      )
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

async function remove(message) {
  if (message) await message.delete();
}

module.exports = { send, remove };
