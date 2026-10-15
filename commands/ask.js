const { SlashCommandBuilder } = require("discord.js");
const aiStore = require("../utils/ai/aiStore");
const { isAiGuild, checkRateLimit, buildContext, answerQuestion } = require("../utils/ai/aiDiscord");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI about OSI guidelines, the UCMJ, punishments or the game")
    .addStringOption(option =>
      option
        .setName("question")
        .setDescription("Your question")
        .setRequired(true)
        .setMaxLength(500)
    )
    .addBooleanOption(option =>
      option
        .setName("private")
        .setDescription("Only you can see the answer")
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!isAiGuild(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: "❌ This command is not available in this server.", ephemeral: true });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      await interaction.reply({ content: "⚠️ The AI assistant is not configured.", ephemeral: true });
      return;
    }

    const limited = checkRateLimit(interaction.user.id);
    if (limited) {
      await interaction.reply({ content: limited, ephemeral: true });
      return;
    }

    const isPrivate = interaction.options.getBoolean("private") || false;
    const question = interaction.options.getString("question");
    await interaction.deferReply({ ephemeral: isPrivate });

    let context = { memory: [], replyChain: [], chat: [] };
    try {
      const channel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId);
      context = await buildContext({ client: interaction.client, channel, userId: interaction.user.id });
    } catch (e) {
      console.warn("AI /ask: could not build context:", e.message || e);
    }

    const { queryId, payload } = await answerQuestion({
      question,
      context,
      user: interaction.user,
      member: interaction.member,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      source: "slash"
    });

    // Show the question above the answer for public replies so the channel can follow along.
    if (!isPrivate && payload.components && payload.components.length) {
      payload.content = `> ${question.replace(/\n/g, "\n> ")}\n\n${payload.content}`.slice(0, 2000);
    }
    const sent = await interaction.editReply(payload);
    if (queryId && !isPrivate && sent && sent.url) aiStore.setQueryMessageUrl(queryId, sent.url).catch(() => {});
  }
};
