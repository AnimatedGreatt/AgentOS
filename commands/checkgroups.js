const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const { getErrorEmbed } = require("../utils/errorCodes");

// Define categories and the group IDs in each
const GROUP_CATEGORIES = {
  "DIVISIONS": [
    6762663,  // SGC
    7001767,  // DoW
    16348435, // NID
    32481660, // R&D
    16242678, // MATCOM
    16242644, // SGSOC
    12327001  // OSI
  ],

  "HOSTILE FACTIONS": [
    35686873   // Sodan
  ],

  "BLACKLISTED GROUPS": [
    765802690, // SGW NID
    16140130 // Kaddin Empire Group
  ]
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("checkgroups")
    .setDescription("Check a Roblox user's group memberships")
    .addStringOption(option =>
      option
        .setName("username")
        .setDescription("Roblox username")
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(20)
    ),

  async execute(interaction) {
    const username = interaction.options.getString("username");
    await interaction.deferReply();

    try {
      // Get userId
      const userRes = await axios.post(
        "https://users.roblox.com/v1/usernames/users",
        { usernames: [username], excludeBannedUsers: true }
      );

      const robloxUser = userRes.data.data[0];
      if (!robloxUser) {
        const embed = getErrorEmbed(41) || new EmbedBuilder().setDescription("❌ Roblox user not found.");
        return interaction.editReply({ embeds: [embed] });
      }
      const userId = robloxUser.id;

      // Get groups
      const groupsRes = await axios.get(
        `https://groups.roblox.com/v2/users/${userId}/groups/roles`
      );
      const groups = groupsRes.data.data;

      // Organize groups
      const categorizedMatches = {};

      for (const [category, ids] of Object.entries(GROUP_CATEGORIES)) {
        categorizedMatches[category] = groups.filter(g => ids.includes(g.group.id));
      }

      // Embed builder
      const embed = new EmbedBuilder()
        .setTitle(`Roblox Groups for ${username}`)
        .setColor(0x00aff1)
        .setThumbnail(`https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=420&height=420&format=png`)
        .setFooter({ text: `User ID: ${userId}` });

      let hasAnyGroup = false;

      for (const [category, matchedGroups] of Object.entries(categorizedMatches)) {
        if (matchedGroups.length === 0) continue;
        hasAnyGroup = true;

      let value = matchedGroups.map(g => 
         `**${g.group.name}**\n**Role:** ${g.role.name}\n**Rank:** ${g.role.rank}`
      ).join("\n\n");

        embed.addFields({ name: category, value, inline: false });
      }

      if (!hasAnyGroup) {
        embed.setDescription("❌ User is not in any tracked groups.");
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error(err);
      // Network timeout / axios specific
      if (err && err.code === 'ECONNABORTED') {
        const embed = getErrorEmbed(43) || new EmbedBuilder().setDescription('Request timed out.');
        return interaction.editReply({ embeds: [embed] });
      }
      if (err && err.response && err.response.status === 429) {
        const embed = getErrorEmbed(20) || new EmbedBuilder().setDescription('Roblox API rate limited (429).');
        return interaction.editReply({ embeds: [embed] });
      }
      if (err && err.response && err.response.status >= 500) {
        const embed = getErrorEmbed(42) || new EmbedBuilder().setDescription('Roblox API server error.');
        return interaction.editReply({ embeds: [embed] });
      }

      const embed = getErrorEmbed(50) || new EmbedBuilder().setDescription('Internal error.');
      await interaction.editReply({ embeds: [embed] });
    }
  }
};

