const { getIndexEmbed } = require("./errorCodes");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require("discord.js");
const { randomInt } = require('crypto');
const config = require("../config");
const agentosStore = require('./agentosStore');
const { getChangelog, setChangelog } = require("./changelogStore");
const { getState, setState } = require("./adminState");
const verificationStore = require('./verificationStore');
const eventSystem = require('./eventSystem');
const topTexts = require('../data/top-texts.json');

let lastTopTextIndex = -1;

function pickTopTextIndex(length) {
  if (!Number.isFinite(length) || length <= 0) return -1;
  if (length === 1) return 0;

  let idx = randomInt(0, length);
  if (idx === lastTopTextIndex) {
    // Force a different index to avoid back-to-back repeats.
    idx = (idx + 1 + randomInt(0, length - 1)) % length;
  }
  lastTopTextIndex = idx;
  return idx;
}

async function handleMessageCommands(message, client) {
  // Ignore bots
  if (message.author.bot) return;

  const content = message.content || "";

  // Only respond when the bot is mentioned and the message contains a ! command
  const mention = message.mentions && message.mentions.users && message.mentions.users.has(client.user.id);
  if (!mention) return;

  const lower = content.toLowerCase();

  if (/(^|\s)!top(\s|$)/i.test(content) || /(^|\s)!tøp(\s|$)/i.test(content)) {
    try {
      if (!Array.isArray(topTexts) || topTexts.length === 0) {
        await message.reply('No entries are configured for !top yet.');
        return;
      }

      const idx = pickTopTextIndex(topTexts.length);
      if (idx < 0) {
        await message.reply('No entries are configured for !top yet.');
        return;
      }
      const quote = String(topTexts[idx]);
      const embed = new EmbedBuilder()
        .setTitle('Twenty One Pilots Quote')
        .setColor(config.EMBED_COLOR || 0x00aff1)
        .setDescription(`"${quote}"\n\n|-/`);

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to handle !top message command:', err);
      try { await message.reply('Failed to fetch a random top text.'); } catch (e) {}
    }
    return;
  }

  if (lower.includes("!errorindex")) {
    const embed = getIndexEmbed();
    try {
      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error("Failed to send error index reply:", err);
    }
  }

  if (lower.includes("!ping")) {
    // Measure latency: difference between message created time and now, plus API RTT
    const sent = Date.now();
    try {
      const reply = await message.reply({ content: "Pinging..." });
      const rcv = Date.now();
      const messageLatency = rcv - message.createdTimestamp;
      const replyLatency = rcv - sent;
      const embed = new EmbedBuilder()
        .setTitle("Pong!")
        .setColor(0x57f287)
        .setDescription(`Message latency: ${messageLatency} ms\nAPI/response time: ${replyLatency} ms`)
        .setFooter({ text: `User: ${message.author.tag}` });

      await reply.edit({ content: null, embeds: [embed] }).catch(() => null);
    } catch (err) {
      console.error("Failed to respond to ping:", err);
    }
  }

  if (lower.includes("!roleid")) {
    try {
      if (!message.guild) return; // must be in a server to resolve roles
      const idx = lower.indexOf("!roleid");
      const after = message.content.slice(idx + "!roleid".length).trim();
      const m = String(after).match(/(\d{16,20})/);
      const roleId = m ? m[1] : null;
      if (!roleId) {
        await message.reply('Usage: `@Bot !roleID <roleId or role mention>` — provide a numeric role ID or mention.');
        return;
      }

      let role = message.guild.roles.cache.get(roleId);
      if (!role) {
        try { role = await message.guild.roles.fetch(roleId); } catch (e) { role = null; }
      }
      if (!role) {
        await message.reply(`Role not found for ID ${roleId}.`);
        return;
      }

      await message.reply({ content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } });
    } catch (err) {
      console.error('Failed to handle !roleid message command:', err);
      try { await message.reply('An error occurred while resolving that role.'); } catch (e) {}
    }
  }

  if (lower.includes("!help")) {
    try {
      const adminWhitelist = config.ADMIN_WHITELIST || [];
      const adminLabel = adminWhitelist.length > 0 ? 'Admin (whitelist)' : 'Admin';
      const eventSetupRoles = Array.isArray(config.EVENT_CREATOR_ROLE_IDS_LIST)
        ? config.EVENT_CREATOR_ROLE_IDS_LIST
        : [];
      const eventSetupAuth = eventSetupRoles.length
        ? `Role-gated (${eventSetupRoles.join(', ')})`
        : 'Role-gated (EVENT_CREATOR_ROLE_IDS not configured)';
      const commands = [
        { name: '!ping', auth: 'Public' },
        { name: '!top / !tøp', auth: 'Public' },
        { name: '!help', auth: 'Public' },
        { name: '!changelog', auth: 'Public' },
        { name: '!errorindex', auth: 'Public' },
        { name: '!events-setup', auth: 'Role-gated' },
        { name: '@AgentOS <question> / /ask', auth: 'Public (AI assistant). Add --ai to mention the bot without an AI reply.' },
        { name: '!admin', auth: adminLabel },
        { name: '!ai', auth: adminLabel },
        { name: '!agentoslog', auth: adminLabel },
        { name: '!roleid', auth: adminLabel },
        { name: '!verifylist', auth: adminLabel }
      ];

      const embed = new EmbedBuilder()
        .setTitle('Help — Message Commands')
        .setColor(config.EMBED_COLOR || 0x00aff1)
        .setFooter({ text: `User: ${message.author.tag}` });

      for (const c of commands) {
        embed.addFields({ name: c.name, value: `Authorization: ${c.auth}`, inline: false });
      }

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to send help reply:', err);
    }
  }

  if (lower.includes("!admin")) {
    const authorId = message.author.id;
    const whitelist = config.ADMIN_WHITELIST || [];
    if (!whitelist.includes(authorId)) {
      try {
        await message.reply({ content: "You are not authorized to use this command." });
      } catch (e) {}
      return;
    }

    const state = await getState();
    const embed = new EmbedBuilder()
      .setTitle("Admin Menu")
      .setColor(config.EMBED_COLOR)
      .setDescription(`Paused Applications: ${state.pausedApplications}\nDebug Mode: ${state.debugMode}\nPaused Time Logging: ${state.pauseTimeLogging}`)
      .setFooter({ text: `User: ${message.author.tag}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_toggle_pause').setStyle(ButtonStyle.Secondary).setLabel('Toggle Pause'),
      new ButtonBuilder().setCustomId('admin_toggle_debug').setStyle(ButtonStyle.Secondary).setLabel('Toggle Debug'),
      new ButtonBuilder().setCustomId('admin_toggle_time_logging').setStyle(ButtonStyle.Secondary).setLabel('Toggle Time Logging'),
      new ButtonBuilder().setCustomId('admin_show_changelog').setStyle(ButtonStyle.Primary).setLabel('Show Changelog'),
      new ButtonBuilder().setCustomId('admin_edit_changelog').setStyle(ButtonStyle.Primary).setLabel('Edit Changelog')
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_manage_commands').setStyle(ButtonStyle.Primary).setLabel('Manage Commands')
    );

    try {
      await message.reply({ embeds: [embed], components: [row, row2] });
    } catch (e) {
      console.error('Failed to send admin menu:', e);
    }
  }

  if (lower.includes('!events-setup')) {
    try {
      if (!message.guild) {
        await message.reply('This command can only run in a server.');
        return;
      }

      const allowed = eventSystem.canManageEvents(message.member, message.author.id);
      if (!allowed) {
        await message.reply({ content: 'You are not authorized to use this command.' });
        return;
      }

      await eventSystem.setupEventMessages(client, message.guild.id);
      await message.reply('Event schedule and operations panel have been set up or refreshed.');
    } catch (err) {
      console.error('Failed to run !events-setup:', err);
      const msg = (err && err.code === 'events_db_not_configured')
        ? 'Events database is not configured. Set DATABASE_URL first.'
        : 'Failed to set up event messages.';
      try { await message.reply(msg); } catch (e) {}
    }
    return;
  }

  if (lower.includes("!changelog")) {
    const cl = await getChangelog();
    const embed = new EmbedBuilder()
      .setTitle(`Changelog ${cl.version || ''}`)
        .setColor(config.EMBED_COLOR)
      .addFields(
        { name: 'Additions', value: cl.additions || 'None', inline: false },
        { name: 'Notes', value: cl.notes || 'None', inline: false }
      )
      .setFooter({ text: `Updated: ${cl.updatedAt || 'never'}` });
    try {
      await message.reply({ embeds: [embed] });
    } catch (e) { console.error('Failed to send changelog:', e); }
  }

  if (lower.includes("!agentoslog")) {
    const authorId = message.author.id;
    const whitelist = config.ADMIN_WHITELIST || [];
    if (!whitelist.includes(authorId)) {
      try { await message.reply({ content: 'You are not authorized to use this command.' }); } catch (e) {}
      return;
    }
    try {
      const entries = await agentosStore.listEntries(10);
      const embed = new EmbedBuilder().setTitle('AgentOS — Recent Commands').setColor(config.EMBED_COLOR || 0x00aff1).setTimestamp(new Date());
      if (!entries || entries.length === 0) {
        embed.setDescription('No recent AgentOS commands found.');
      } else {
        for (const e of entries) {
          const time = e.createdAt ? new Date(e.createdAt).toLocaleString() : 'unknown';
          const who = e.userTag || e.userId || 'unknown';
          const name = `${e.command} — ${who} — ${time}`;
          let params = e.params || '(no params)';
          if (params.length > 1020) params = params.slice(0, 1017) + '...';
          embed.addFields({ name, value: params, inline: false });
        }
      }
      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('Failed to fetch AgentOS entries:', err);
      try { await message.reply({ content: 'Failed to fetch AgentOS entries.' }); } catch (e) {}
    }
  }

  if (lower.includes("!verifylist")) {
    try {
      if (!message.guild) return;
      // Load verified discord IDs from the DB (may be empty if DB not configured)
      const verifiedIds = new Set((await verificationStore.listAllDiscordIds().catch(() => [])) || []);
      // Role tokens configured to be excluded from verifylist (IDs, mentions, or names)
      const excludeTokens = Array.isArray(config.VERIFYLIST_EXCLUDE_ROLE_IDS_LIST) ? config.VERIFYLIST_EXCLUDE_ROLE_IDS_LIST : (config.VERIFYLIST_EXCLUDE_ROLE_IDS_LIST ? [config.VERIFYLIST_EXCLUDE_ROLE_IDS_LIST] : []);
      const excludeRoleIds = new Set();
      try {
        for (const tok of excludeTokens) {
          if (!tok) continue;
          const t = String(tok).trim();
          // exact numeric id
          const idExact = t.match(/^(\d{5,20})$/);
          if (idExact) { excludeRoleIds.add(idExact[1]); continue; }

          // mention formats like <@&12345> or plain numbers embedded
          const mentionMatch = t.match(/<@&?(\d{5,20})>|(\d{5,20})/);
          const id = mentionMatch ? (mentionMatch[1] || mentionMatch[2]) : null;
          if (id) {
            excludeRoleIds.add(id);
            continue;
          }

          // try to resolve by name in this guild (case-insensitive)
          if (message.guild) {
            // prefer exact name match in cache
            const nameLower = t.toLowerCase();
            let roleByName = message.guild.roles.cache.find(r => r.name && r.name.toLowerCase() === nameLower);
            if (!roleByName) {
              // try partial match or display name fallback
              roleByName = message.guild.roles.cache.find(r => r.name && r.name.toLowerCase().includes(nameLower));
            }
            if (roleByName) { excludeRoleIds.add(roleByName.id); continue; }

            // As a last resort, attempt to fetch role by id if t contains digits
            const maybeId = (t.match(/(\d{5,20})/)||[])[1];
            if (maybeId) {
              try {
                const fetched = await message.guild.roles.fetch(maybeId).catch(() => null);
                if (fetched) { excludeRoleIds.add(fetched.id); continue; }
              } catch (e) {}
            }
          }
        }
      } catch (e) { /* ignore resolution errors */ }
      // Check admin state early so we can avoid building mention syntax when needed
      let state = { debugMode: false };
      try { state = await getState(); } catch (e) { /* ignore */ }
      const disablePings = !!(state && state.debugMode);

      const members = await message.guild.members.fetch();
      const unverified = [];
      for (const [id, member] of members) {
        if (!member || member.user.bot) continue;
        // Skip members who have any excluded role
        try {
          // Ensure we have an up-to-date member object (avoid stale cache)
          let freshMember = member;
          try { freshMember = await message.guild.members.fetch(member.id); } catch (e) { /* fallback to cached member */ }
          if (freshMember.roles && freshMember.roles.cache && freshMember.roles.cache.some(r => excludeRoleIds.has(r.id))) continue;
        } catch (e) {}
        if (!verifiedIds.has(id)) {
          if (disablePings) unverified.push(`${member.user.tag} (${id})`);
          else unverified.push(`${member.user.tag} (<@${id}>)`);
        }
      }

      if (unverified.length === 0) {
        await message.reply('All server members appear to be verified.');
        return;
      }

      const max = 50;
      const shown = unverified.slice(0, max).join('\n');
      const more = unverified.length > max ? `\n…and ${unverified.length - max} more` : '';
      const content = `Unverified members (${unverified.length}):\n${shown}${more}`;
      // Respect admin debug mode or explicit config: if pings are disabled, also set allowedMentions
      const allowedMentions = disablePings ? { parse: [] } : undefined;
      await message.reply({ content, allowedMentions });
    } catch (err) {
      console.error('Failed to handle !verifylist:', err);
      try { await message.reply({ content: 'Failed to generate verify list.' }); } catch (e) {}
    }
  }

  
}

module.exports = { handleMessageCommands };
