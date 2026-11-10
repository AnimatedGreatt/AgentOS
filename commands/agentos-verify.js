const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const verificationStore = require('../utils/verification/verificationStore');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('agentos-verify')
    .setDescription('Link (or re-link) your Discord account to a Roblox username')
    .addStringOption(opt => opt.setName('username').setDescription('Roblox username').setRequired(true)),

  async execute(interaction) {
    const roblox = String(interaction.options.getString('username') || '').trim();
    const discordId = interaction.user.id;
    await interaction.deferReply({ ephemeral: true });

    // resolve roblox id
    let robloxId = null;
    try {
      const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [roblox], excludeBannedUsers: true });
      if (res.data && res.data.data && res.data.data[0]) robloxId = res.data.data[0].id;
    } catch (err) {
      console.warn('Failed to fetch Roblox user id:', err?.response?.data || err.message || err);
    }
    if (!robloxId) {
      const e = new EmbedBuilder().setTitle('Verification Error').setColor(0xed4245).setDescription('Failed to resolve Roblox username. Please check the name.');
      return interaction.editReply({ embeds: [e], ephemeral: true });
    }

    // generate an OAuth state and present a one-click Roblox OAuth link
    const state = crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    try {
      await verificationStore.createChallenge(roblox, robloxId, discordId, state, expires);

      const clientId = config.ROBLOX_OAUTH_CLIENT_ID;
      const redirectUri = config.ROBLOX_OAUTH_REDIRECT_URI;
      if (!clientId || !redirectUri) {
        const e = new EmbedBuilder().setTitle('Verification Error').setColor(0xed4245).setDescription('OAuth is not configured on this bot. Please contact an administrator.');
        return interaction.editReply({ embeds: [e], ephemeral: true });
      }

      const authUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile&state=${encodeURIComponent(state)}`;

      const existing = await verificationStore.getByDiscord(discordId).catch(() => null);
      const relinkNote = existing && existing.roblox_username
        ? `\n\nYou are currently linked to **${existing.roblox_username}**. Completing this will replace that link.`
        : '';

      const startEmbed = new EmbedBuilder()
        .setTitle('AgentOS Verification (Roblox OAuth)')
        .setColor(0x00aff1)
        .setDescription(`To verify ownership of Roblox account **${roblox}**, click the button below to authorize via Roblox. The OAuth flow will confirm your Roblox account and complete verification automatically.${relinkNote}`)
        .setTimestamp(new Date());

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Authorize on Roblox').setStyle(ButtonStyle.Link).setURL(authUrl)
      );

      return interaction.editReply({ embeds: [startEmbed], components: [row], ephemeral: true });
    } catch (err) {
      console.error('Failed to create verification challenge:', err);
      const e = new EmbedBuilder().setTitle('Verification Error').setColor(0xed4245).setDescription('Failed to initiate verification. Try again later.');
      return interaction.editReply({ embeds: [e], ephemeral: true });
    }
  }
};
