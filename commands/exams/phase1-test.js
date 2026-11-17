const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../../config');
const verificationStore = require('../../utils/verification/verificationStore');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('phase1-test')
    .setDMPermission(false)
    .setDescription('Request the Phase 1 Knowledge Test'),
    
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const linked = await verificationStore.getByDiscord(interaction.user.id).catch(() => null);
    if (!linked || !linked.roblox_username) {
      return interaction.editReply({
        content: 'You must link a Roblox account before requesting this exam. Use /agentos-verify first.',
        ephemeral: true
      });
    }

    const examGuildId = config.EXAM_GUILD_ID;
    if (!examGuildId) {
      return interaction.editReply({ content: 'Exam guild is not configured. Please contact staff.', ephemeral: true });
    }

    const examGuild = await interaction.client.guilds.fetch(examGuildId).catch(() => null);
    if (!examGuild) {
      return interaction.editReply({ content: 'Exam guild is unavailable right now. Please try again later.', ephemeral: true });
    }

    const examMember = await examGuild.members.fetch(interaction.user.id).catch(() => null);
    if (!examMember) {
      return interaction.editReply({ content: 'You must be a member of the exam guild to request this exam.', ephemeral: true });
    }

    if (config.EXAM_CANDIDATE_ROLE_ID && !examMember.roles.cache.has(config.EXAM_CANDIDATE_ROLE_ID)) {
      return interaction.editReply({ content: 'You do not have the required role to request this exam.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('Request — Phase 1 Knowledge Test')
      .setColor(config.EMBED_COLOR)
      .addFields({ name: 'Candidate', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Exam', value: 'Phase 1 Knowledge Test', inline: true })
      .setTimestamp(new Date());

    const approve = new ButtonBuilder().setCustomId(`exam_authorize:${interaction.user.id}:phase1`).setLabel('Authorize & Start').setStyle(ButtonStyle.Success);
    const reject = new ButtonBuilder().setCustomId(`exam_reject:${interaction.user.id}:phase1`).setLabel('Reject').setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approve, reject);

    const chan = await interaction.client.channels.fetch(config.EXAM_AUTH_CHANNEL_ID).catch(() => null);
    if (!chan) return interaction.editReply({ content: 'An error occurred while fetching the authorization channel. Contact the Department of Engineering.', ephemeral: true });
    const sent = await chan.send({ embeds: [embed], components: [row] }).catch(() => null);
    if (!sent) return interaction.editReply({ content: 'An error occurred while creating the authorization request. Contact the Department of Engineering.', ephemeral: true });

    await interaction.editReply({ content: `Authorization request posted in <#${config.EXAM_AUTH_CHANNEL_ID}>`, ephemeral: true });
  }
};
