const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inactivity-notice')
    .setDescription('Create an inactivity notice')
    .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true)),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    if (!target) return interaction.reply({ content: 'You must specify a target user.', ephemeral: true });

    // Build modal
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder().setCustomId(`inactivity_modal_${target.id}`).setTitle('Inactivity Notice');

    const duration = new TextInputBuilder().setCustomId('duration').setLabel('Duration (e.g. 14 or "14 days")').setStyle(TextInputStyle.Short).setRequired(true);
    const roblox = new TextInputBuilder().setCustomId('roblox').setLabel('Roblox Username').setStyle(TextInputStyle.Short).setRequired(true);
    const reason = new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(duration), new ActionRowBuilder().addComponents(roblox), new ActionRowBuilder().addComponents(reason));

    try {
      await interaction.showModal(modal);
    } catch (err) {
      console.error('Failed to show inactivity modal:', err);
      await interaction.reply({ content: 'Failed to open form.', ephemeral: true });
    }
  }
};
