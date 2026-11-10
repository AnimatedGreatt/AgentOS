const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getErrorEmbed } = require("../utils/errorCodes");
const axios = require("axios");

// Define restricted groups (from checkgroups.js)
const RESTRICTED_GROUPS = {
  "HOSTILE FACTIONS": [
    34810794,  // Ori
    14153848,  // RNID
    35686873   // Sodan
  ],

  "BLACKLISTED GROUPS": [
    765802690, // SGW NID
    16140130 // Kaddin Empire Group
  ]
};

// Role IDs that are allowed to use this command
const ALLOWED_ROLE_IDS = [
  "1449860815086813224", // OSI HC
  "1106739929540730921", // OSI Oversight
  "1263502224181694467", // OSI CoS
  "1344664234641850441", // MATCOM Oversight
  "1193616594455253072", // MATCOM HC
  "1263502187208638534", // MATCOM CoS
  "994285075678109759" // SGC Officers
];

// User IDs that are allowed to use this command (for testing/debugging)
const ALLOWED_USER_IDS = [
  "716248402513494027" // UID for testing
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("checksecurity")
    .setDMPermission(false)
    .setDescription("(HC Restricted) Check if group members are in hostile or blacklisted factions")
    .addIntegerOption(option =>
      option
        .setName("groupid")
        .setDescription("Roblox group ID to check")
        .setRequired(true)
    ),

  async execute(interaction) {
    // User check (for testing/debugging)
    if (ALLOWED_USER_IDS.includes(interaction.user.id)) {
      // Skip all permission checks for whitelisted users
    } else {
      // Role check
      const hasRole = ALLOWED_ROLE_IDS.some(roleId =>
        interaction.member.roles.cache.has(roleId)
      );

      if (!hasRole) {
        return interaction.reply({
          content: "❌ You do not have permission to use this command.",
          ephemeral: true
        });
      }
    }

    const groupId = interaction.options.getInteger("groupid");
    await interaction.deferReply();

    // Prepare informational disclaimer: command is deprecated/disused
    const disclaimerEmbed = new EmbedBuilder()
      .setTitle("Notice — Deprecated Command")
      .setDescription("All hostile factions are defunct and this command is disused; results are informational only.")
      .setColor(0x808080);

    try {
      // Get group info
      const groupRes = await axios.get(
        `https://groups.roblox.com/v1/groups/${groupId}`
      );
      const groupName = groupRes.data.name;
      const groupIcon = groupRes.data.icon || "https://www.roblox.com/Thumbs/Avatar.ashx?x=150&y=150&Format=Png"; // Fallback icon

      // Get group members with pagination (max 500 members to avoid excessive API calls)
      const allMembers = [];
      let cursor = null;
      const maxMembers = 500;

      do {
        const url = cursor
          ? `https://groups.roblox.com/v1/groups/${groupId}/users?limit=100&sortOrder=Desc&cursor=${cursor}`
          : `https://groups.roblox.com/v1/groups/${groupId}/users?limit=100&sortOrder=Desc`;

        const membersRes = await axios.get(url);
        allMembers.push(...membersRes.data.data);
        cursor = membersRes.data.nextPageCursor;

        // Stop if we've reached max members or no more pages
        if (allMembers.length >= maxMembers) {
          allMembers.length = maxMembers;
          break;
        }
      } while (cursor);

      const members = allMembers;
      const checkedMemberCount = members.length;

      const suspiciousMembers = [];

      // Check each member against restricted groups
      let rateLimited = false;
      for (const member of members) {
        const userId = member.user.userId;
        
        try {
          const userGroupsRes = await axios.get(
            `https://groups.roblox.com/v2/users/${userId}/groups/roles`
          );
          const userGroups = userGroupsRes.data.data;

          for (const [category, restrictedIds] of Object.entries(RESTRICTED_GROUPS)) {
            const foundGroup = userGroups.find(g => restrictedIds.includes(g.group.id));
            if (foundGroup) {
              suspiciousMembers.push({
                username: member.user.username,
                groupName: foundGroup.group.name,
                category: category,
                role: foundGroup.role.name
              });
              break; // Only report once per member
            }
          }
        } catch (err) {
          // If rate limited by Roblox API, surface error code 20 to the user
          if (err && err.response && err.response.status === 429) {
            rateLimited = true;
            break;
          }
          // Otherwise skip this user
          continue;
        }
      }
      if (rateLimited) {
        const embed = getErrorEmbed(20) || new EmbedBuilder().setDescription("Rate limited (429)");
        return interaction.editReply({ embeds: [disclaimerEmbed, embed] });
      }

      // Build embed report
      const embed = new EmbedBuilder()
        .setTitle(`Security Report: ${groupName}`)
        .setColor(suspiciousMembers.length > 0 ? 0xed4245 : 0x57F287)
        .setThumbnail(groupIcon)
        .setFooter({ text: `Checked ${checkedMemberCount} members (limited to first 500)` });

      if (suspiciousMembers.length === 0) {
        embed.setDescription("✅ No members found in hostile or blacklisted groups.");
      } else {
        let report = suspiciousMembers.map(m =>
          `**${m.username}**\n` +
          `└─ ${m.category}: ${m.groupName}`
        ).join("\n\n");
        // If report is too long to post, return a specific error code (10)
        if (report.length > 1000 || suspiciousMembers.length > 40) {
          const errEmbed = getErrorEmbed(10) || new EmbedBuilder().setDescription("Too many suspicious members to display.");
          return interaction.editReply({ embeds: [errEmbed] });
        }

        // Truncate defensively if necessary
        if (report.length > 1024) report = report.substring(0, 1021) + "...";

        embed.addFields({ name: `⚠️ Suspicious Members (${suspiciousMembers.length})`, value: report, inline: false });
      }

      await interaction.editReply({ embeds: [disclaimerEmbed, embed] });

    } catch (err) {
      console.error(err);
      // Timeouts
        if (err && err.code === 'ECONNABORTED') {
        const embed = getErrorEmbed(43) || new EmbedBuilder().setDescription('Request timed out.');
        return interaction.editReply({ embeds: [disclaimerEmbed, embed] });
      }

      // Roblox rate limit
      if (err && err.response && err.response.status === 429) {
        const embed = getErrorEmbed(20) || new EmbedBuilder().setDescription('Roblox API rate limited (429).');
        return interaction.editReply({ embeds: [disclaimerEmbed, embed] });
      }

      // Roblox server errors
      if (err && err.response && err.response.status >= 500) {
        const embed = getErrorEmbed(42) || new EmbedBuilder().setDescription('Roblox API server error.');
        return interaction.editReply({ embeds: [disclaimerEmbed, embed] });
      }

      // Generic internal error
      const embed = getErrorEmbed(50) || new EmbedBuilder().setDescription('Something went wrong.');
      await interaction.editReply({ embeds: [disclaimerEmbed, embed] });
    }
  }
};
