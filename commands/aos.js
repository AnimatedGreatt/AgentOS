const { SlashCommandBuilder, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const config = require('../config');
const { computeJailTimeFromCharges } = require('../utils/aos/aosSentencing');
const { listActiveAosEntries, enforceAos30DayExpirationForThread, parseAosStarterData } = require('../utils/aos/aosForumLookup');
const aosActiveStore = require('../utils/aos/aosActiveStore');

const AOS_LIST_COOLDOWN_MS = 60 * 1000;
let nextAosListAllowedAt = 0;

function hasAnyAllowedRole(member, roleIds) {
  if (!member || !member.roles || !member.roles.cache) return false;
  if (!Array.isArray(roleIds) || roleIds.length === 0) return true;
  return roleIds.some(roleId => member.roles.cache.has(roleId));
}

function hasBannedRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  return !!config.AOS_BANNED_ROLE_ID && member.roles.cache.has(config.AOS_BANNED_ROLE_ID);
}

function getAosForumThread(interaction) {
  const channel = interaction.channel;
  if (!channel || typeof channel.isThread !== 'function' || !channel.isThread()) {
    return { error: '❌ This subcommand must be used inside an AoS forum post thread.' };
  }
  if (String(channel.parentId) !== String(config.AOS_FORUM_CHANNEL_ID)) {
    return { error: '❌ This thread is not inside the configured AoS forum channel.' };
  }
  return { thread: channel };
}

function buildAosBody({ submitter, username, profile, victims, charges, summary, proof, jailMinutes }) {
  const webViewUrl = buildAosWebUrlForUsername(username);
  return [
    '# <:osi:1448992108500357150> **AOS Order** <:osi:1448992108500357150>',
    `<@&${config.AOS_COMPLETE_PING_ROLE_ID}>`,
    webViewUrl ? `[**View in browser**](${webViewUrl})` : '*Error - Unable to generate web view link*',
    '',
    `**Submitter:** ${submitter}`,
    `**Username:** ${username}`,
    `**Profile:** ${profile}`,
    `**Victim(s):** ${victims}`,
    `**Charges:** ${charges}`,
    `**Summary:** ${summary}`,
    `**Proof:** ${proof}`,
    '',
    `**Jail time has been set to ${jailMinutes} minutes.**`
  ].join('\n');
}

function uniqueTags(tags) {
  return Array.from(new Set(tags.filter(Boolean).map(String)));
}

function applyTagMutations(current, { add = [], remove = [] }) {
  const next = new Set((current || []).map(String));
  for (const tagId of add) next.add(String(tagId));
  for (const tagId of remove) next.delete(String(tagId));
  return Array.from(next);
}

function clampForumTagsToLimit(tags, priority = [], max = 5) {
  const dedup = Array.from(new Set((tags || []).map(String).filter(Boolean)));
  if (dedup.length <= max) return dedup;

  const out = [];
  for (const p of priority.map(String)) {
    if (dedup.includes(p) && !out.includes(p)) out.push(p);
    if (out.length >= max) return out.slice(0, max);
  }

  for (const t of dedup) {
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }

  return out.slice(0, max);
}

function has30DayTagExpired(thread) {
  const tags = Array.isArray(thread && thread.appliedTags) ? thread.appliedTags.map(String) : [];
  const has30Day = tags.includes(String(config.AOS_TAG_30_DAY_ID || ''));
  if (!has30Day) return false;
  const createdAt = Number(thread && thread.createdTimestamp);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  return (Date.now() - createdAt) >= (30 * 24 * 60 * 60 * 1000);
}

function buildAosWebUrlForUsername(username) {
  const baseRaw = String(config.EXAM_WEB_BASE_URL || '').trim();
  if (!baseRaw) return null;

  const base = baseRaw.replace(/\/$/, '');
  const path = String(config.AOS_WEB_PATH || '/aos-profile').trim() || '/aos-profile';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const safeUsername = encodeURIComponent(String(username || '').trim());
  return `${base}${normalizedPath}?username=${safeUsername}`;
}

function extractEntryJailMinutes(entry) {
  const candidate = entry?.jailMinutes !== undefined && entry?.jailMinutes !== null
    ? entry.jailMinutes
    : entry?.calculatedTimeMinutes;
  const n = Number(candidate);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function sanitizeSingleLine(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

function safeDisplayName(username) {
  const oneLine = sanitizeSingleLine(username || 'Unknown') || 'Unknown';
  const clipped = oneLine.length > 64 ? `${oneLine.slice(0, 61)}...` : oneLine;
  return escapeMarkdown(clipped);
}

function groupEntriesByUsername(entries) {
  const grouped = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const username = sanitizeSingleLine(entry?.username || 'Unknown') || 'Unknown';
    const key = username.toLowerCase();
    const createdMs = Number(entry?.createdTimestamp)
      || (entry?.createdAt ? Date.parse(entry.createdAt) : NaN)
      || (entry?.activatedAt ? Date.parse(entry.activatedAt) : NaN)
      || NaN;

    if (!grouped.has(key)) {
      grouped.set(key, {
        username,
        count: 0,
        latestCreatedMs: Number.isFinite(createdMs) ? createdMs : null,
        linkUrl: null,
        totalJailMinutes: 0,
        missingJailCount: 0
      });
    }

    const bucket = grouped.get(key);
    bucket.count += 1;
    if (Number.isFinite(createdMs)) {
      if (!bucket.latestCreatedMs || createdMs > bucket.latestCreatedMs) {
        bucket.latestCreatedMs = createdMs;
      }
    }

    if (!bucket.linkUrl) {
      bucket.linkUrl = buildAosWebUrlForUsername(username) || String(entry?.url || '').trim() || null;
    }

    const entryMinutes = extractEntryJailMinutes(entry);
    if (entryMinutes === null) {
      bucket.missingJailCount += 1;
    } else {
      bucket.totalJailMinutes += entryMinutes;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const aMs = Number(a.latestCreatedMs || 0);
    const bMs = Number(b.latestCreatedMs || 0);
    if (bMs !== aMs) return bMs - aMs;
    return a.username.localeCompare(b.username);
  });
}

function buildAosListEmbed(grouped, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(grouped.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  const shown = grouped.slice(start, start + pageSize);
  const lines = [];

  for (const row of shown) {
    const label = `${row.count} Warrant${row.count === 1 ? '' : 's'}`;
    const linkedLabel = row.linkUrl ? `[${label}](${row.linkUrl})` : label;
    const missingPart = row.missingJailCount > 0
      ? ` (missing time on ${row.missingJailCount} warrant${row.missingJailCount === 1 ? '' : 's'} = 0m)`
      : '';
    const jailSummary = `${row.totalJailMinutes} Minutes${missingPart}`;
    lines.push(`**${safeDisplayName(row.username)}**`);
    lines.push(`${linkedLabel} | ${jailSummary}`);
    lines.push('');
  }

  const descriptionBody = lines.join('\n').trim() || 'No active warrants found.';
  return new EmbedBuilder()
    .setTitle('Active Warrants')
    .setColor(config.EMBED_COLOR || 0x00aff1)
    .setDescription(`Click on a warrant count to view on the website.\n\n${descriptionBody}`.slice(0, 4000))
    .setFooter({ text: `Page ${safePage + 1} of ${totalPages} • ${grouped.length} user${grouped.length === 1 ? '' : 's'}` });
}

function buildAosListComponents(token, page, totalPages) {
  const prev = new ButtonBuilder()
    .setCustomId(`${token}:prev`)
    .setLabel('◀ Prev')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page <= 0);
  const next = new ButtonBuilder()
    .setCustomId(`${token}:next`)
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page >= totalPages - 1);
  return [new ActionRowBuilder().addComponents(prev, next)];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('aos')
    .setDescription('Manage Arrest-On-Sight forum warrants')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Create a new AoS forum post')
        .addStringOption(opt => opt.setName('username').setDescription('Target Roblox username').setRequired(true))
        .addStringOption(opt => opt.setName('profile').setDescription('Profile link').setRequired(true))
        .addStringOption(opt => opt.setName('victims').setDescription('Victim username(s)').setRequired(true))
        .addStringOption(opt => opt.setName('charges').setDescription('Use format: 1x [1.1] Charge').setRequired(true))
        .addStringOption(opt => opt.setName('summary').setDescription('Summary of offense').setRequired(true))
        .addStringOption(opt => opt.setName('proof').setDescription('Proof link(s)').setRequired(true))
        .addStringOption(opt =>
          opt
            .setName('infraction')
            .setDescription('Optional infraction level tag (1)')
            .setRequired(false)
            .addChoices(
              { name: 'Light', value: 'light' },
              { name: 'Medium', value: 'medium' },
              { name: 'Heavy', value: 'heavy' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('infraction_2')
            .setDescription('Optional infraction level tag (2)')
            .setRequired(false)
            .addChoices(
              { name: 'Light', value: 'light' },
              { name: 'Medium', value: 'medium' },
              { name: 'Heavy', value: 'heavy' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('infraction_3')
            .setDescription('Optional infraction level tag (3)')
            .setRequired(false)
            .addChoices(
              { name: 'Light', value: 'light' },
              { name: 'Medium', value: 'medium' },
              { name: 'Heavy', value: 'heavy' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('reward')
            .setDescription('Optional reward tag')
            .setRequired(false)
            .addChoices(
              { name: 'Medal', value: 'medal' },
              { name: 'Requisition', value: 'requisition' }
            )
        )
        .addBooleanOption(opt =>
          opt
            .setName('expires_30_days')
            .setDescription('Apply the 30-day time limit tag')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('approve')
        .setDescription('Approve an AoS and ensure it is active')
        .addStringOption(opt =>
          opt
            .setName('status')
            .setDescription('Final decision for this AoS')
            .setRequired(true)
            .addChoices(
              { name: 'Approved', value: 'approved' },
              { name: 'Denied', value: 'denied' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('complete')
        .setDescription('Mark an active AoS as completed')
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List all currently active AoS entries')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand(false);
    if (sub === 'list') {
      const now = Date.now();
      if (now < nextAosListAllowedAt) {
        const waitSec = Math.max(1, Math.ceil((nextAosListAllowedAt - now) / 1000));
        await interaction.reply({ content: `⏳ /aos list is on cooldown. Please wait ${waitSec}s.`, ephemeral: false });
        return;
      }
      nextAosListAllowedAt = now + AOS_LIST_COOLDOWN_MS;
    }

    await interaction.deferReply({ ephemeral: false });

    if (!interaction.inGuild()) {
      await interaction.editReply('❌ This command can only be used in a server.');
      return;
    }

    const bannedRole = hasBannedRole(interaction.member);

    if (sub !== 'list' && bannedRole) {
      await interaction.editReply('❌ You are not allowed to use this AoS subcommand.');
      return;
    }

    if (sub === 'add') {
      if (!hasAnyAllowedRole(interaction.member, config.AOS_ADD_ROLE_IDS_LIST)) {
        await interaction.editReply('❌ You do not have permission to run /aos add.');
        return;
      }

      const username = interaction.options.getString('username', true).trim();
      const profile = interaction.options.getString('profile', true).trim();
      const victims = interaction.options.getString('victims', true).trim();
      const charges = interaction.options.getString('charges', true).trim();
      const summary = interaction.options.getString('summary', true).trim();
      const proof = interaction.options.getString('proof', true).trim();
      const infractionValues = [
        interaction.options.getString('infraction'),
        interaction.options.getString('infraction_2'),
        interaction.options.getString('infraction_3')
      ].filter(Boolean);
      const reward = interaction.options.getString('reward');
      const expires30Days = !!interaction.options.getBoolean('expires_30_days');

      const sentencing = computeJailTimeFromCharges(charges);
      const jailMinutes = sentencing.totalMinutes;

      const content = buildAosBody({
        submitter: `<@${interaction.user.id}>`,
        username,
        profile,
        victims,
        charges,
        summary,
        proof,
        jailMinutes
      });

      const forumChannel = await interaction.guild.channels.fetch(config.AOS_FORUM_CHANNEL_ID).catch(() => null);
      if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
        await interaction.editReply('❌ AoS forum channel is missing or not a forum channel.');
        return;
      }

      const optionalTags = [];
      for (const infraction of Array.from(new Set(infractionValues.map(String)))) {
        if (infraction === 'light') optionalTags.push(config.AOS_TAG_INFRACTION_LIGHT_ID);
        if (infraction === 'medium') optionalTags.push(config.AOS_TAG_INFRACTION_MEDIUM_ID);
        if (infraction === 'heavy') optionalTags.push(config.AOS_TAG_INFRACTION_HEAVY_ID);
      }
      if (reward === 'medal') optionalTags.push(config.AOS_TAG_MEDAL_REWARD_ID);
      if (reward === 'requisition') optionalTags.push(config.AOS_TAG_REQUISITION_REWARD_ID);
      if (expires30Days) optionalTags.push(config.AOS_TAG_30_DAY_ID);

      const threadName = `AOS - ${username}`.slice(0, 100);

      try {
        const created = await forumChannel.threads.create({
          name: threadName,
          message: { content },
          appliedTags: uniqueTags(optionalTags)
        });

        let response = `✅ AoS created: ${created.url || `https://discord.com/channels/${interaction.guildId}/${created.id}`}\nComputed jail time: ${jailMinutes} minute(s).`;
        if (sentencing.unknownCodes.length) {
          response += `\n⚠️ Unknown law codes (counted as 0): ${sentencing.unknownCodes.join(', ')}`;
        }

        await interaction.editReply(response);
      } catch (err) {
        console.error('aos add failed:', err);
        await interaction.editReply('⚠️ Failed to create AoS forum post.');
      }
      return;
    }

    if (sub === 'approve') {
      if (!hasAnyAllowedRole(interaction.member, config.AOS_APPROVE_ROLE_IDS_LIST)) {
        await interaction.editReply('❌ You do not have permission to run /aos approve.');
        return;
      }

      const status = interaction.options.getString('status', true);

      const ctx = getAosForumThread(interaction);
      if (ctx.error) {
        await interaction.editReply(ctx.error);
        return;
      }

      const thread = ctx.thread;
      if (has30DayTagExpired(thread)) {
        const changed = await enforceAos30DayExpirationForThread(thread).catch(() => false);
        if (changed) {
          await interaction.editReply('⚠️ This AoS exceeded 30 days and was automatically recalled (inactive + recalled tags applied).');
          return;
        }
      }
      const tags = (thread.appliedTags || []).map(String);
      const hasApproved = tags.includes(String(config.AOS_TAG_APPROVED_ID));
      const hasActive = tags.includes(String(config.AOS_TAG_ACTIVE_WARRANT_ID));
      const hasInactive = tags.includes(String(config.AOS_TAG_INACTIVE_WARRANT_ID));
      const hasCompleted = tags.includes(String(config.AOS_TAG_COMPLETED_ID));
      const hasRecalled = tags.includes(String(config.AOS_TAG_RECALLED_ID));

      if (status === 'denied') {
        if (hasInactive && hasRecalled && !hasActive) {
          await interaction.editReply('⚠️ This AoS is already denied (inactive + recalled).');
          return;
        }

        let denyTags = applyTagMutations(tags, {
          add: [config.AOS_TAG_INACTIVE_WARRANT_ID, config.AOS_TAG_RECALLED_ID],
          remove: [config.AOS_TAG_ACTIVE_WARRANT_ID, config.AOS_TAG_APPROVED_ID, config.AOS_TAG_COMPLETED_ID]
        });
        denyTags = clampForumTagsToLimit(denyTags, [
          config.AOS_TAG_INACTIVE_WARRANT_ID,
          config.AOS_TAG_RECALLED_ID,
          config.AOS_TAG_30_DAY_ID,
          config.AOS_TAG_INFRACTION_HEAVY_ID,
          config.AOS_TAG_INFRACTION_MEDIUM_ID,
          config.AOS_TAG_INFRACTION_LIGHT_ID,
          config.AOS_TAG_MEDAL_REWARD_ID,
          config.AOS_TAG_REQUISITION_REWARD_ID
        ], 5);

        try {
          await thread.setAppliedTags(denyTags);
          try {
            await aosActiveStore.removeActiveAosByThreadId(thread.id);
          } catch (storeErr) {
            console.warn('aos deny: failed to remove active AOS row:', storeErr?.message || storeErr);
          }
          await interaction.editReply('✅ AoS denied and set to inactive + recalled.');
        } catch (err) {
          console.error('aos deny failed:', err);
          await interaction.editReply('⚠️ Failed to update AoS tags.');
        }
        return;
      }

      if (hasApproved && hasActive && !hasInactive && !hasCompleted) {
        await interaction.editReply('⚠️ This AoS is already approved and active.');
        return;
      }

      let nextTags = applyTagMutations(tags, {
        add: [config.AOS_TAG_APPROVED_ID, config.AOS_TAG_ACTIVE_WARRANT_ID],
        remove: [config.AOS_TAG_INACTIVE_WARRANT_ID, config.AOS_TAG_COMPLETED_ID, config.AOS_TAG_RECALLED_ID]
      });
      nextTags = clampForumTagsToLimit(nextTags, [
        config.AOS_TAG_APPROVED_ID,
        config.AOS_TAG_ACTIVE_WARRANT_ID,
        config.AOS_TAG_30_DAY_ID,
        config.AOS_TAG_INFRACTION_HEAVY_ID,
        config.AOS_TAG_INFRACTION_MEDIUM_ID,
        config.AOS_TAG_INFRACTION_LIGHT_ID,
        config.AOS_TAG_MEDAL_REWARD_ID,
        config.AOS_TAG_REQUISITION_REWARD_ID
      ], 5);

      try {
        await thread.setAppliedTags(nextTags);
        await thread.send(`<@&${config.AOS_PING_ROLE_ID}>`).catch(() => null);
        try {
          let starter = null;
          try {
            starter = await thread.fetchStarterMessage();
          } catch (starterErr) {
            starter = await thread.messages.fetch(thread.id).catch(() => null);
          }
          const starterContent = String(starter?.content || '');
          const parsed = parseAosStarterData(starterContent);
          const parsedUsername = parsed.username || String(thread.name || '').replace(/^AOS\s*-\s*/i, '').trim() || thread.name;

          await aosActiveStore.upsertActiveAos({
            threadId: thread.id,
            guildId: interaction.guildId,
            forumChannelId: thread.parentId,
            threadName: thread.name,
            url: `https://discord.com/channels/${interaction.guildId}/${thread.id}`,
            submitter: parsed.submitter,
            username: parsedUsername,
            profile: parsed.profile,
            victims: parsed.victims,
            charges: parsed.charges,
            summary: parsed.summary,
            proof: parsed.proof,
            tags: nextTags,
            calculatedTimeMinutes: parsed.calculatedTimeMinutes,
            jailMinutes: parsed.jailMinutes,
            createdTimestamp: thread.createdTimestamp
          }, { postedByBot: true });
        } catch (storeErr) {
          console.warn('aos approve: failed to upsert active AOS row:', storeErr?.message || storeErr);
        }
        const reopened = hasInactive || hasCompleted;
        await interaction.editReply(reopened
          ? '✅ AoS approved and set to active (re-opened).'
          : '✅ AoS approved and marked active.');
      } catch (err) {
        console.error('aos approve failed:', err);
        await interaction.editReply('⚠️ Failed to update AoS tags.');
      }
      return;
    }

    if (sub === 'complete') {
      if (!hasAnyAllowedRole(interaction.member, config.AOS_COMPLETE_ROLE_IDS_LIST)) {
        await interaction.editReply('❌ You do not have permission to run /aos complete.');
        return;
      }

      const ctx = getAosForumThread(interaction);
      if (ctx.error) {
        await interaction.editReply(ctx.error);
        return;
      }

      const thread = ctx.thread;
      const tags = (thread.appliedTags || []).map(String);
      const hasActive = tags.includes(String(config.AOS_TAG_ACTIVE_WARRANT_ID));

      if (!hasActive) {
        await interaction.editReply('❌ This AoS is not active, so it cannot be marked complete.');
        return;
      }

      let nextTags = applyTagMutations(tags, {
        add: [config.AOS_TAG_INACTIVE_WARRANT_ID, config.AOS_TAG_COMPLETED_ID],
        remove: [config.AOS_TAG_ACTIVE_WARRANT_ID, config.AOS_TAG_APPROVED_ID]
      });
      nextTags = clampForumTagsToLimit(nextTags, [
        config.AOS_TAG_INACTIVE_WARRANT_ID,
        config.AOS_TAG_COMPLETED_ID,
        config.AOS_TAG_RECALLED_ID,
        config.AOS_TAG_30_DAY_ID,
        config.AOS_TAG_INFRACTION_HEAVY_ID,
        config.AOS_TAG_INFRACTION_MEDIUM_ID,
        config.AOS_TAG_INFRACTION_LIGHT_ID,
        config.AOS_TAG_MEDAL_REWARD_ID,
        config.AOS_TAG_REQUISITION_REWARD_ID
      ], 5);

      try {
        await thread.setAppliedTags(nextTags);
        try {
          await aosActiveStore.removeActiveAosByThreadId(thread.id);
        } catch (storeErr) {
          console.warn('aos complete: failed to remove active AOS row:', storeErr?.message || storeErr);
        }
        await thread.send(`✅ AoS marked complete by <@${interaction.user.id}>.`).catch(() => null);
        await thread.send(`<@&${config.AOS_COMPLETE_PING_ROLE_ID}>`).catch(() => null);
        await interaction.editReply('✅ AoS marked complete.');
      } catch (err) {
        console.error('aos complete failed:', err);
        await interaction.editReply('⚠️ Failed to update AoS tags.');
      }
      return;
    }

    if (sub === 'list') {
      if (!bannedRole && !hasAnyAllowedRole(interaction.member, config.AOS_ADD_ROLE_IDS_LIST)) {
        await interaction.editReply('❌ You do not have permission to run /aos list.');
        return;
      }

      try {
        let entries = [];
        if (aosActiveStore.isEnabled()) {
          entries = await aosActiveStore.listActiveAosRows().catch(() => []);
          if (!entries.length) {
            const syncResult = await aosActiveStore.syncActiveAosFromForum(interaction.client, {
              reason: 'aos-list-empty-db'
            }).catch(() => null);
            if (syncResult) {
              console.info('aos list: db warm sync completed', syncResult);
            }
            entries = await aosActiveStore.listActiveAosRows().catch(() => []);
          }
        } else {
          entries = await listActiveAosEntries(interaction.client);
        }

        if (!entries.length) {
          await interaction.editReply('No active AoS entries found.');
          return;
        }

        const grouped = groupEntriesByUsername(entries);
        const pageSize = 10;
        const totalPages = Math.max(1, Math.ceil(grouped.length / pageSize));
        let page = 0;

        const token = `aos_${Date.now().toString(36)}_${interaction.id}`;
        const embed = buildAosListEmbed(grouped, page, pageSize);
        const components = buildAosListComponents(token, page, totalPages);

        await interaction.editReply({ embeds: [embed], components: totalPages > 1 ? components : [] });

        if (totalPages <= 1) return;

        const replyMessage = await interaction.fetchReply();
        const filter = (i) => i.isButton() && typeof i.customId === 'string' && i.customId.startsWith(`${token}:`);
        const collector = replyMessage.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 10 * 60 * 1000 });

        collector.on('collect', async (btnInt) => {
          try {
            if (btnInt.user.id !== interaction.user.id) {
              await btnInt.reply({ content: 'Only the command user can control these pages.', ephemeral: true });
              return;
            }

            await btnInt.deferUpdate();
            const action = btnInt.customId.split(':')[1];
            if (action === 'prev' && page > 0) page -= 1;
            if (action === 'next' && page < totalPages - 1) page += 1;

            const newEmbed = buildAosListEmbed(grouped, page, pageSize);
            const newComponents = buildAosListComponents(token, page, totalPages);
            await replyMessage.edit({ embeds: [newEmbed], components: newComponents });
          } catch (collectErr) {
            console.error('aos list pagination collect failed:', collectErr);
          }
        });

        collector.on('end', async () => {
          try {
            const disabled = [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('aos_prev_disabled').setLabel('◀ Prev').setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId('aos_next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(true)
            )];
            await replyMessage.edit({ components: disabled });
          } catch (endErr) {
            // ignore cleanup failures
          }
        });
      } catch (err) {
        console.error('aos list failed:', err);
        await interaction.editReply('⚠️ Failed to fetch active AoS entries.');
      }
      return;
    }

    await interaction.editReply('⚠️ Unknown subcommand.');
  }
};
