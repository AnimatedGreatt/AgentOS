const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../../config');

async function handleExamReject(interaction) {
  try {
    await interaction.deferUpdate();
    const parts = String(interaction.customId).split(':');
    const userId = parts[1];
    const examId = parts[2];

    if (!interaction.member.roles.cache.has(config.EXAM_AUTH_ROLE_ID)) {
      return interaction.followUp({ content: '❌ You are not authorized to reject exams.', ephemeral: true });
    }

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`exam_authorize:${userId}:${examId}`)
        .setLabel('Authorize & Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`exam_reject:${userId}:${examId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true)
    );

    try {
      await interaction.message.edit({ content: `❌ Rejected by ${interaction.user.tag}`, components: [disabledRow] });
    } catch (e) {
      console.error('Failed to edit rejected exam request message:', e);
    }

    await interaction.followUp({ content: `✅ Rejected exam request for <@${userId}> (${examId}).`, ephemeral: true });
  } catch (e) {
    console.error('handleExamReject error:', e);
    try { await interaction.followUp({ content: '⚠️ Failed to reject exam.', ephemeral: true }); } catch (_) {}
  }
}

module.exports = { handleExamReject };