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

    try {
      await interaction.message.edit({ content: `❌ Rejected by ${interaction.user.tag}`, components: [] });
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