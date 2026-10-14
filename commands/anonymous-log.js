const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName("anonymous-log")
    .setDescription("Submit a Sealed Case File or an Anonymous Request")
    .addSubcommand(sub =>
      sub
        .setName("case")
        .setDescription("Submit a Sealed Case File to High Command.")
        .addStringOption(option =>
          option
            .setName("link")
            .setDescription("Link to the Case File")
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName("casenumber")
            .setDescription("The identifying number of the case")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("request")
        .setDescription("Submit an anonymity request for a user.")
        .addStringOption(option =>
          option
            .setName("requester")
            .setDescription("Requester username (who wants anonymity)")
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName("reason")
            .setDescription("Reason for the anonymity request")
            .setRequired(true)
        )
        .addAttachmentOption(option =>
          option
            .setName("evidence")
            .setDescription("Optional evidence file (attachment)")
            .setRequired(false)
        )
    ),

  guildOnly: config.GUILD_ID || undefined,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const targetChannelId = config.ANONYMOUS_LOG_CHANNEL_ID || config.LOG_CHANNEL_ID || interaction.channelId;
      const channel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
      if (!channel) {
        await interaction.editReply({ content: '❌ The anonymous log channel is not configured for this server. Set ANONYMOUS_LOG_CHANNEL_ID or LOG_CHANNEL_ID in the environment.', ephemeral: true });
        return;
      }
      const sub = interaction.options.getSubcommand();

      if (sub === "case") {
        const link = interaction.options.getString("link");
        const casenumber = interaction.options.getString("casenumber");

        const embed = new EmbedBuilder()
          .setTitle(`Sealed Case File #${casenumber}`)
          .setDescription(`Submitted by ${interaction.user}`)
          .addFields({ name: "Case File", value: `[View Case File](${link})`, inline: false })
          .setColor(0x00aff1)
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        await interaction.editReply("✅ Case submitted successfully.");
        return;
      }

      if (sub === "request") {
        const requester = interaction.options.getString("requester");
        const reason = interaction.options.getString("reason");
        const evidence = interaction.options.getAttachment("evidence");

        const embed = new EmbedBuilder()
          .setTitle("Anonymous Request")
          .setDescription(`Submitted by ${interaction.user}`)
          .addFields(
            { name: "Requester", value: requester, inline: false },
            { name: "Reason", value: reason, inline: false }
          )
          .setColor(0x00aff1)
          .setTimestamp();

        const sendOptions = { embeds: [embed] };
        if (evidence) {
          // Only embed the evidence image; do not attach the file to the message
          embed.setImage(evidence.url);
        }

        await channel.send({ embeds: [embed] });
        await interaction.editReply("✅ Anonymous request submitted successfully.");
        return;
      }

      await interaction.editReply("⚠️ Unknown subcommand.");
    } catch (err) {
      console.error(err);
      try { await interaction.editReply("⚠️ Something went wrong."); } catch (e) {}
    }
  }
};