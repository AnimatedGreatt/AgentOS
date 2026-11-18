const { SlashCommandBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder } = require('discord.js');
const verificationStore = require('../utils/verification/verificationStore');
const { syncmember } = require('../utils/verification/rankSync');

function buildcomponent(message) {
  return new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## AgentOS update\n${message}`)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('agentos-update')
    .setDescription('Update yourself'),

  async execute(interaction) {
    await interaction.reply({
      components: [buildcomponent('Updating your roles...')],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
    });

    try {
      const verification = await verificationStore.getByDiscord(interaction.user.id);
      if (!verification || !verification.roblox_userid) {
        return interaction.editReply({ components: [buildcomponent('You are not verified.')] });
      }

      const result = await syncmember(interaction.client, {
        discordId: interaction.user.id,
        robloxUserId: verification.roblox_userid,
        robloxUsername: verification.roblox_username,
        auditLabel: 'Updater'
      });

      if (result.status === 'allg') {
        return interaction.editReply({ components: [buildcomponent('You have been updated.')] });
      }
      if (result.status === 'ranknotfound') {
        return interaction.editReply({
          components: [buildcomponent('Rank Configuration is not complete for your rank.')]
        });
      }
      if (result.status === 'nogroup') {
        return interaction.editReply({ components: [buildcomponent('You are up to date.')] });
      }

      return interaction.editReply({
        components: [buildcomponent('The update could not be completed.')]
      });
    } catch (err) {
      console.error('agentos-update command failed:', err);
      return interaction.editReply({
        components: [buildcomponent('The update failed.')]
      });
    }
  }
};