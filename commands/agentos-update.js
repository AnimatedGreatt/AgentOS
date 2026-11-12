const { SlashCommandBuilder } = require('discord.js');
const rankConfig = require('../rankconfig.json');
const verificationStore = require('../utils/verification/verificationStore');
const { syncmember } = require('../utils/verification/rankSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('agentos-update')
    .setDescription('Update yourself'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.guildId !== String(rankConfig.testserver)) {
      return interaction.editReply({ content: 'Development Team Command.' });
    }

    try {
      const verification = await verificationStore.getByDiscord(interaction.user.id);
      if (!verification || !verification.roblox_userid) {
        return interaction.editReply({ content: 'You are not verified.' });
      }

      const result = await syncmember(interaction.client, {
        discordId: interaction.user.id,
        robloxUserId: verification.roblox_userid,
        robloxUsername: verification.roblox_username
      });

      if (result.status === 'allg') {
        return interaction.editReply({ content: 'You have been updated.' });
      }
      if (result.status === 'ranknotfound') {
        return interaction.editReply({ content: 'Rank Configuration is not complete for your rank.' });
      }
      if (result.status === 'nogroup') {
        return interaction.editReply({ content: 'You are up to date.' });
      }

      return interaction.editReply({ content: 'The update could not be completed.' });
    } catch (err) {
      console.error('agentos-update command failed:', err);
      return interaction.editReply({ content: 'The update failed.' });
    }
  }
};