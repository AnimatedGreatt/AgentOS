const { SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const config = require('../config');
const arrestStore = require('../utils/arrestStore');
const { findActiveAosByUsername } = require('../utils/aos/aosForumLookup');

const DIVISION_IDS = [7001767, 16348435, 32481660, 16242678, 16242644, 12327001];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('background-check')
    .setDescription('Run a background check on a Roblox username')
    .addStringOption(opt => opt
      .setName('username')
      .setDescription('Roblox username to check')
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(20)),

  async execute(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
    });

    const username = String(interaction.options.getString('username') || '').trim();
    let robloxUserId;
    let robloxUsername = username;

    try {
      const response = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [username], excludeBannedUsers: true },
        { timeout: 10000 }
      );
      const account = response.data?.data?.[0];
      if (!account) {
        const container = new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## Background check\nNo Roblox account was found for **${username}**.`)
        );
        return interaction.editReply({ components: [container] });
      }
      robloxUserId = String(account.id);
      robloxUsername = account.name || username;
    } catch (error) {
      console.error('Background check could not resolve Roblox username:', error?.response?.status || error?.message || error);
      const container = new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## Background check\nRoblox could not be reached. Please try again later.')
      );
      return interaction.editReply({ components: [container] });
    }

    const profileUrl = `https://www.roblox.com/users/${robloxUserId}/profile`;
    const profileLines = [
      '## Roblox profile',
      `**Account:** [${robloxUsername}](${profileUrl})`,
      `**User ID:** \`${robloxUserId}\``
    ];

    try {
      const response = await axios.get(
        `https://users.roblox.com/v1/users/${robloxUserId}`,
        { timeout: 10000 }
      );
      if (response.data?.created) {
        const created = new Date(response.data.created);
        const timestamp = Math.floor(created.getTime() / 1000);
        const ageDays = Math.floor((Date.now() - created.getTime()) / 86400000);
        profileLines.push(`**Created:** <t:${timestamp}:D> • <t:${timestamp}:R>`);
        profileLines.push(`**Account age:** ${ageDays.toLocaleString()} days`);
      }
    } catch (error) {
      console.warn('Background check account lookup failed:', error?.response?.status || error?.message || error);
      profileLines.push('⚠️ Account details are unavailable.');
    }

    try {
      const response = await axios.get(
        `https://users.roblox.com/v1/users/${robloxUserId}/username-history`,
        { timeout: 10000 }
      );
      const names = Array.isArray(response.data?.data)
        ? response.data.data.map(item => item.name).filter(Boolean).slice(0, 8)
        : [];
      profileLines.push(`**Previous usernames:** ${names.length ? names.map(name => `\`${name}\``).join(', ') : 'None'}`);
    } catch (error) {
      console.warn('Background check username history failed:', error?.response?.status || error?.message || error);
      profileLines.push('⚠️ Username history is unavailable.');
    }

    const groupLines = ['## Group memberships'];
    try {
      const response = await axios.get(
        `https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`,
        { timeout: 10000 }
      );
      const groups = Array.isArray(response.data?.data) ? response.data.data : [];
      const mainGroupId = Number(config.TIME_SGC_GROUP_ID || 6762663);
      const memberships = groups.filter(group =>
        Number(group.group?.id) === mainGroupId || DIVISION_IDS.includes(Number(group.group?.id))
      );

      if (memberships.length) {
        for (const membership of memberships) {
          groupLines.push(`**${String(membership.group?.name || 'Unknown group').slice(0, 100)}** — ${String(membership.role?.name || 'Unknown rank').slice(0, 100)}`);
        }
      } else {
        groupLines.push('No membership found in the configured groups.');
      }
    } catch (error) {
      console.warn('Background check group lookup failed:', error?.response?.status || error?.message || error);
      groupLines.push('⚠️ Roblox group memberships are unavailable.');
    }

    const suspensionLines = ['## Suspensions'];
    const boardId = config.TRELLO_SUSPENSIONS_BOARD_ID || process.env.TRELLO_SUSPENSIONS_BOARD_ID;
    const trelloKey = process.env.TRELLO_KEY;
    const trelloToken = process.env.TRELLO_TOKEN;

    if (!boardId || !trelloKey || !trelloToken) {
      suspensionLines.push('Trello search is not configured.');
    } else {
      try {
        const response = await axios.get(`https://api.trello.com/1/boards/${boardId}/cards`, {
          params: { key: trelloKey, token: trelloToken, fields: 'name,desc,url,labels' },
          timeout: 10000
        });
        const cards = Array.isArray(response.data) ? response.data : [];
        const escapedUsername = robloxUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernamePattern = new RegExp(`(^|[^a-z0-9_])${escapedUsername}($|[^a-z0-9_])`, 'i');
        const matches = cards.filter(card => {
          const text = `${card.name || ''}\n${card.desc || ''}`;
          return usernamePattern.test(text) || text.includes(robloxUserId);
        });

        suspensionLines.push(matches.length ? `**${matches.length} match(es)**` : 'No matching records.');
        for (const card of matches.slice(0, 5)) {
          const title = String(card.name || 'Untitled').slice(0, 120);
          const labels = Array.isArray(card.labels)
            ? card.labels.map(label => label.name).filter(Boolean).join(', ').slice(0, 100)
            : '';
          const description = String(card.desc || '').replace(/\s+/g, ' ').trim().slice(0, 180);
          suspensionLines.push(`• [${title}](${card.url})${labels ? ` — ${labels}` : ''}${description ? `\n  ${description}` : ''}`);
        }
        if (matches.length > 5) suspensionLines.push(`Plus ${matches.length - 5} more.`);
      } catch (error) {
        console.warn('Background check suspension lookup failed:', error?.response?.status || error?.message || error);
        suspensionLines.push('⚠️ Suspension records are unavailable.');
      }
    }

    const arrestLines = ['## Arrest records'];
    try {
      const arrests = await arrestStore.getArrestsByRoblox(robloxUsername);
      arrestLines.push(arrests.length ? `**${arrests.length} record(s)**` : 'No matching records.');
      for (const arrest of arrests.slice(0, 5)) {
        const date = arrest.created_at
          ? ` • <t:${Math.floor(new Date(arrest.created_at).getTime() / 1000)}:d>`
          : '';
        const details = [];
        if (arrest.charges) details.push(`Charges: ${String(arrest.charges).slice(0, 180)}`);
        if (arrest.sentence !== null && arrest.sentence !== undefined) details.push(`Sentence: ${arrest.sentence} minutes`);
        if (arrest.incident_summary) details.push(`Summary: ${String(arrest.incident_summary).slice(0, 180)}`);
        if (arrest.submitted_by_tag) details.push(`Logged by: ${arrest.submitted_by_tag}`);
        if (arrest.proof) details.push(`[Proof](${arrest.proof})`);
        arrestLines.push(`• **Record ${arrest.id || ''}**${date}\n${details.length ? details.join(' • ') : 'No additional details.'}`);
      }
      if (arrests.length > 5) arrestLines.push(`Plus ${arrests.length - 5} more.`);
    } catch (error) {
      console.warn('Background check arrest lookup failed:', error?.message || error);
      arrestLines.push('⚠️ Arrest records are unavailable.');
    }

    const aosLines = ['## Active AoS cases'];
    try {
      const cases = await findActiveAosByUsername(interaction.client, robloxUsername);
      aosLines.push(cases.length ? `**${cases.length} active case(s)**` : 'No active cases found.');
      for (const item of cases.slice(0, 5)) {
        aosLines.push(`• [${String(item.threadName || 'AoS case').slice(0, 140)}](${item.url})`);
      }
      if (cases.length > 5) aosLines.push(`Plus ${cases.length - 5} more.`);
    } catch (error) {
      console.warn('Background check AoS lookup failed:', error?.message || error);
      aosLines.push('⚠️ Active AoS cases are unavailable.');
    }

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(profileLines.join('\n').slice(0, 3900)),
      new TextDisplayBuilder().setContent(groupLines.join('\n').slice(0, 3900)),
      new TextDisplayBuilder().setContent(suspensionLines.join('\n').slice(0, 3900)),
      new TextDisplayBuilder().setContent(arrestLines.join('\n').slice(0, 3900)),
      new TextDisplayBuilder().setContent(aosLines.join('\n').slice(0, 3900))
    );
    return interaction.editReply({ components: [container] });
  }
};