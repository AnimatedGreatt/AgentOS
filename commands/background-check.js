const { SlashCommandBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, MessageFlags } = require('discord.js');
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
    const progressContainer = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## Background check\nChecking Roblox and case records...')
    );
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [progressContainer]
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
    const boardId = config.TRELLO_SUSPENSIONS_BOARD_ID || process.env.TRELLO_SUSPENSIONS_BOARD_ID;
    const trelloKey = process.env.TRELLO_KEY;
    const trelloToken = process.env.TRELLO_TOKEN;
    const [
      accountLines,
      usernameLines,
      groupLines,
      suspensionLines,
      arrestLines,
      aosLines,
      avatarUrl
    ] = await Promise.all([
      (async () => {
        try {
          const response = await axios.get(
            `https://users.roblox.com/v1/users/${robloxUserId}`,
            { timeout: 10000 }
          );
          if (!response.data?.created) return [];
          const created = new Date(response.data.created);
          const timestamp = Math.floor(created.getTime() / 1000);
          const ageDays = Math.floor((Date.now() - created.getTime()) / 86400000);
          return [
            `**Created:** <t:${timestamp}:D> • <t:${timestamp}:R>`,
            `**Account age:** ${ageDays.toLocaleString()} days`
          ];
        } catch (error) {
          console.warn('Background check account lookup failed:', error?.response?.status || error?.message || error);
          return ['⚠️ Account details are unavailable.'];
        }
      })(),
      (async () => {
        try {
          const response = await axios.get(
            `https://users.roblox.com/v1/users/${robloxUserId}/username-history`,
            { timeout: 10000 }
          );
          const names = Array.isArray(response.data?.data)
            ? response.data.data.map(item => item.name).filter(Boolean).slice(0, 8)
            : [];
          return [`**Previous usernames:** ${names.length ? names.map(name => `\`${name}\``).join(', ') : 'None'}`];
        } catch (error) {
          console.warn('Background check username history failed:', error?.response?.status || error?.message || error);
          return ['⚠️ Username history is unavailable.'];
        }
      })(),
      (async () => {
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
          if (!memberships.length) return ['No membership in tracked groups.'];
          return memberships.map(membership => {
            const groupId = membership.group.id;
            const groupName = String(membership.group?.name || 'Unknown group').slice(0, 100);
            const rankName = String(membership.role?.name || 'Unknown rank').slice(0, 100);
            return `• **[${groupName}](https://www.roblox.com/communities/${groupId})** — ${rankName}`;
          });
        } catch (error) {
          console.warn('Background check group lookup failed:', error?.response?.status || error?.message || error);
          return ['⚠️ Roblox group memberships are unavailable.'];
        }
      })(),
      (async () => {
        if (!boardId || !trelloKey || !trelloToken) return ['Trello search is not configured.'];
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
          const lines = [matches.length ? `**${matches.length} match(es)**` : 'No suspension records found.'];
          for (const card of matches.slice(0, 5)) {
            const title = String(card.name || 'Untitled').slice(0, 120);
            const labels = Array.isArray(card.labels)
              ? card.labels.map(label => label.name).filter(Boolean).join(', ').slice(0, 100)
              : '';
            const description = String(card.desc || '').replace(/\s+/g, ' ').trim().slice(0, 180);
            lines.push(`• [${title}](${card.url})${labels ? ` — ${labels}` : ''}${description ? `\n  ${description}` : ''}`);
          }
          if (matches.length > 5) lines.push(`Plus ${matches.length - 5} more.`);
          return lines;
        } catch (error) {
          console.warn('Background check suspension lookup failed:', error?.response?.status || error?.message || error);
          return ['⚠️ Suspension records are unavailable.'];
        }
      })(),
      (async () => {
        try {
          const arrests = await arrestStore.getArrestsByRoblox(robloxUsername);
          const lines = [arrests.length ? `**${arrests.length} record(s)**` : 'No arrest records found.'];
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
            lines.push(`• **Record ${arrest.id || ''}**${date}\n${details.length ? details.join(' • ') : 'No additional details.'}`);
          }
          if (arrests.length > 5) lines.push(`Plus ${arrests.length - 5} more.`);
          return lines;
        } catch (error) {
          console.warn('Background check arrest lookup failed:', error?.message || error);
          return ['⚠️ Arrest records are unavailable.'];
        }
      })(),
      (async () => {
        try {
          const cases = await findActiveAosByUsername(interaction.client, robloxUsername);
          const lines = [cases.length ? `**${cases.length} active case(s)**` : 'No active AoS cases found.'];
          for (const item of cases.slice(0, 5)) {
            lines.push(`• [${String(item.threadName || 'AoS case').slice(0, 140)}](${item.url})`);
          }
          if (cases.length > 5) lines.push(`Plus ${cases.length - 5} more.`);
          return lines;
        } catch (error) {
          console.warn('Background check AoS lookup failed:', error?.message || error);
          return ['⚠️ Active AoS cases are unavailable.'];
        }
      })(),
      (async () => {
        try {
          const response = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
            params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: 'false' },
            timeout: 10000
          });
          return response.data?.data?.[0]?.imageUrl || null;
        } catch (error) {
          console.warn('Background check avatar lookup failed:', error?.response?.status || error?.message || error);
          return null;
        }
      })()
    ]);

    profileLines.push(...accountLines, ...usernameLines);
    const groupSection = ['## Group Data', ...groupLines];
    const noSuspensions = suspensionLines.length === 1 && suspensionLines[0] === 'No suspension records found.';
    const noArrests = arrestLines.length === 1 && arrestLines[0] === 'No arrest records found.';
    const noActiveAosCases = aosLines.length === 1 && aosLines[0] === 'No active AoS cases found.';
    const recordSections = [];

    if (noSuspensions && noArrests && noActiveAosCases) {
      recordSections.push(['## Record Checks', 'No suspension records, arrests, or active AoS cases were found for this user.']);
    } else {
      if (!noSuspensions) recordSections.push(['## Suspensions', ...suspensionLines]);
      if (!noArrests) recordSections.push(['## Arrest records', ...arrestLines]);
      if (!noActiveAosCases) recordSections.push(['## Active AoS cases', ...aosLines]);
    }

    const container = new ContainerBuilder();
    if (avatarUrl) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(profileLines.join('\n').slice(0, 3900)))
          .setThumbnailAccessory(
            new ThumbnailBuilder()
              .setURL(avatarUrl)
              .setDescription(`${robloxUsername}'s Roblox avatar`)
          )
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(profileLines.join('\n').slice(0, 3900))
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(groupSection.join('\n').slice(0, 3900)));
    for (const section of recordSections) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(section.join('\n').slice(0, 3900)));
    }
    return interaction.editReply({ components: [container] });
  }
};