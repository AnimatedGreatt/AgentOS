const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const config = require('../config');
const arrestStore = require('../utils/arrestStore');
const { findActiveAosByUsername } = require('../utils/aos/aosForumLookup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('background-check')
    .setDescription('Run a background check on a Roblox username')
    .addStringOption(opt => opt.setName('username').setDescription('Roblox username to check').setRequired(true)),

  async execute(interaction) {
    const username = interaction.options.getString('username');
    await interaction.deferReply();

    try {
      // Resolve username -> userId
      let robloxUserId = null;
      try {
        const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [username], excludeBannedUsers: true });
        if (res.data && res.data.data && res.data.data[0]) robloxUserId = res.data.data[0].id;
      } catch (e) {
        // ignore
      }

      // Prepare embed (we'll use the author as the linked username with avatar at top-left)
      const embed = new EmbedBuilder().setColor(0x00aff1).setFooter({ text: robloxUserId ? `User ID: ${robloxUserId}` : `User: ${username}` });

      // Fetch Roblox user info (created date) and avatar
      let avatarUrl = null;
      try {
        if (robloxUserId) {
          const info = (await axios.get(`https://users.roblox.com/v1/users/${robloxUserId}`)).data || {};
          if (info.created) {
            const created = new Date(info.created);
            const now = new Date();
            const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
            const ts = Math.floor(created.getTime() / 1000);
            embed.addFields({ name: 'Account Age', value: `<t:${ts}:f> — ${ageDays} day(s)`, inline: false });
          }

          // username history
          try {
            const hist = (await axios.get(`https://users.roblox.com/v1/users/${robloxUserId}/username-history`)).data || {};
            const names = Array.isArray(hist.data) ? hist.data.map(h => h.name).slice(0, 8) : [];
            if (names.length) embed.addFields({ name: 'Previous Usernames', value: names.join('\n'), inline: false });
          } catch (e) { /* ignore */ }

          // avatar/headshot
          try {
            const thumb = (await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', { params: { userIds: robloxUserId, size: '150x150', format: 'Png', isCircular: 'false' } })).data;
            if (thumb && thumb.data && thumb.data[0] && thumb.data[0].imageUrl) avatarUrl = thumb.data[0].imageUrl;
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }

      // Groups: report SGC rank and which Division groups they are in (use same IDs as `checkgroups`)
      try {
        if (robloxUserId) {
          const groupsRes = (await axios.get(`https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`)).data || {};
          const groups = Array.isArray(groupsRes.data) ? groupsRes.data : [];
          const SGC_ID = config.TIME_SGC_GROUP_ID || 6762663;
          const DIVISION_IDS = [6762663,7001767,16348435,32481660,16242678,16242644,12327001];

          const sgc = groups.find(g => g.group && Number(g.group.id) === Number(SGC_ID));
          if (sgc) {
            embed.addFields({ name: 'Stargate Command', value: `Rank: ${sgc.role.name}`, inline: false });
          }

          // Find which division groups the user is in and show each as its own field (match SGC format)
          const divisions = groups.filter(g => g.group && DIVISION_IDS.includes(Number(g.group.id)) && Number(g.group.id) !== Number(SGC_ID));
          if (divisions.length) {
            for (const g of divisions) {
              const title = `${g.group.name}`;
              const value = `Rank: ${g.role.name}`;
              embed.addFields({ name: title, value, inline: false });
            }
          }
        }
      } catch (e) { /* ignore */ }

      // Suspensions board search (Trello)
      try {
        const BOARD_ID = config.TRELLO_SUSPENSIONS_BOARD_ID || process.env.TRELLO_SUSPENSIONS_BOARD_ID;
        const TRELLO_KEY = process.env.TRELLO_KEY;
        const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
        if (BOARD_ID && TRELLO_KEY && TRELLO_TOKEN && (username || robloxUserId)) {
          const cardsRes = await axios.get(`https://api.trello.com/1/boards/${BOARD_ID}/cards`, { params: { key: TRELLO_KEY, token: TRELLO_TOKEN, fields: 'name,desc,url,labels' } });
          const cards = Array.isArray(cardsRes.data) ? cardsRes.data : [];
          const qName = String(username || '').toLowerCase();
          const qId = robloxUserId ? String(robloxUserId) : '';
          const matches = cards.filter(c => {
            const hay = `${String(c.name||'')}\n${String(c.desc||'')}`.toLowerCase();
            if (qName && hay.includes(qName)) return true;
            if (qId && (String(c.name||'').includes(qId) || String(c.desc||'').includes(qId))) return true;
            return false;
          });
          if (matches.length) {
            const shown = matches.slice(0, 6).map(c => `• [${String(c.name||'untitled')}](${c.url})`).join('\n');
            embed.addFields({ name: 'Suspensions Board Results', value: shown.slice(0, 1000), inline: false });
          }
        }
      } catch (e) { /* ignore */ }

      // Arrest log DB
      try {
        const arrests = await arrestStore.getArrestsByRoblox(username);
        if (arrests && arrests.length) {
          const shown = arrests.slice(0, 6).map(a => {
              const idPart = a.id ? `ID ${a.id}` : '';
              const laws = a.charges || a.incident_summary || a.sentence || '(no laws listed)';
              return `• ${idPart} — ${String(laws).slice(0, 180)}`;
            }).join('\n');
          embed.addFields({ name: 'Arrest Log Matches', value: shown.slice(0, 1000), inline: false });
        }
      } catch (e) { /* ignore */ }

      // Active AoS forum matches
      try {
        const aosMatches = await findActiveAosByUsername(interaction.client, username);
        if (aosMatches && aosMatches.length) {
          const shown = aosMatches.slice(0, 6)
            .map(m => `• ${m.threadName} (${m.url})`)
            .join('\n');
          const more = aosMatches.length > 6 ? `\n+${aosMatches.length - 6} more` : '';
          embed.addFields({ name: 'Active AoS Matches', value: (shown + more).slice(0, 1000), inline: false });
        }
      } catch (e) { /* ignore */ }

      // Set author (top-left) to show linked username and avatar if available
      try {
        const profileUrl = robloxUserId ? `https://www.roblox.com/users/${robloxUserId}/profile` : undefined;
        const authorName = `BGC for ${username}:`;
        const authorOpts = { name: authorName };
        if (profileUrl) authorOpts.url = profileUrl;
        if (avatarUrl) authorOpts.iconURL = avatarUrl;
        embed.setAuthor(authorOpts);
      } catch (e) { /* ignore author set errors */ }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('background-check failed:', err);
      await interaction.editReply('⚠️ Failed to perform background check.');
    }
  }
};
