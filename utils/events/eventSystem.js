const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder
} = require('discord.js');
const config = require('../../config');
const eventStore = require('./eventStore');
const renderer = require('./eventRenderer');
const { getState } = require('../adminState');

function toRoleList(listLike) {
  if (Array.isArray(listLike)) return listLike.map((x) => String(x).trim()).filter(Boolean);
  return String(listLike || '').split(',').map((x) => String(x).trim()).filter(Boolean);
}

function hasAnyRole(member, roleIds) {
  if (!member || !member.roles) return false;

  // GuildMember shape
  if (member.roles.cache && typeof member.roles.cache.has === 'function') {
    return roleIds.some((roleId) => member.roles.cache.has(roleId));
  }

  // APIInteractionGuildMember shape
  if (Array.isArray(member.roles)) {
    const set = new Set(member.roles.map((x) => String(x)));
    return roleIds.some((roleId) => set.has(String(roleId)));
  }

  return false;
}

function isWhitelistedUser(userId) {
  const whitelist = Array.isArray(config.ADMIN_WHITELIST) ? config.ADMIN_WHITELIST : [];
  return whitelist.includes(String(userId));
}

function canManageEvents(member, userId) {
  if (isWhitelistedUser(userId)) return true;
  const creatorRoles = toRoleList(config.EVENT_CREATOR_ROLE_IDS_LIST || config.EVENT_CREATOR_ROLE_IDS);
  if (creatorRoles.length === 0) return false;
  return hasAnyRole(member, creatorRoles);
}

function canHostEvents(member, userId) {
  // Hosting is intentionally role-gated only.
  const hostRoles = toRoleList(config.EVENT_HOST_ROLE_IDS_LIST || config.EVENT_HOST_ROLE_IDS);
  if (hostRoles.length === 0) return false;
  return hasAnyRole(member, hostRoles);
}

function getPresetHostRoles(presetKey) {
  const key = String(presetKey || '').trim();
  if (!key) return [];

  const map = config.EVENT_PRESET_HOST_ROLE_IDS_MAP && typeof config.EVENT_PRESET_HOST_ROLE_IDS_MAP === 'object'
    ? config.EVENT_PRESET_HOST_ROLE_IDS_MAP
    : {};

  const fromMap = toRoleList(map[key]);
  const courtOnly = key === 'court_martials'
    ? toRoleList(config.EVENT_COURT_MARTIAL_HOST_ROLE_IDS_LIST || config.EVENT_COURT_MARTIAL_HOST_ROLE_IDS)
    : [];

  return Array.from(new Set([...fromMap, ...courtOnly]));
}

function canHostPreset(member, userId, presetKey) {
  if (canHostEvents(member, userId)) return true;
  const presetRoles = getPresetHostRoles(presetKey);
  if (presetRoles.length === 0) return false;
  return hasAnyRole(member, presetRoles);
}

async function canHostEventsForInteraction(interaction, presetKey) {
  if (!interaction || !interaction.user) return false;

  const targetGuild = String(config.EVENT_GUILD_ID || '').trim();
  if (targetGuild && String(interaction.guildId || '') !== targetGuild) return false;

  // Prefer a fresh guild-member fetch so permissions cannot be bypassed by stale/partial interaction payloads.
  let memberForCheck = interaction.member || null;
  try {
    if (interaction.guild && interaction.user && interaction.user.id) {
      const fetched = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (fetched) memberForCheck = fetched;
    }
  } catch (e) {}

  if (presetKey) {
    return canHostPreset(memberForCheck, interaction.user.id, presetKey);
  }

  return canHostEvents(memberForCheck, interaction.user.id);
}

function parseTimeUtc(value) {
  const raw = String(value || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) return null;
  return raw;
}

function computeNextWeeklyRunAt(weekday, timeUtc, fromDate = new Date()) {
  const hhmm = parseTimeUtc(timeUtc);
  if (!hhmm) return null;
  const targetWeekday = Number(weekday);
  if (!Number.isInteger(targetWeekday) || targetWeekday < 0 || targetWeekday > 6) return null;

  const [hh, mm] = hhmm.split(':').map((x) => Number(x));
  const base = new Date(fromDate);
  const currentDay = base.getUTCDay();
  let addDays = (targetWeekday - currentDay + 7) % 7;

  const candidate = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + addDays,
    hh,
    mm,
    0,
    0
  ));

  if (candidate.getTime() <= base.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }

  return candidate;
}

function weekResetKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function fetchTextChannel(client, id) {
  if (!id) return null;
  const ch = await client.channels.fetch(String(id)).catch(() => null);
  if (!ch || !ch.isTextBased || !ch.isTextBased()) return null;
  return ch;
}

async function upsertManagedMessage(channel, messageId, payload) {
  if (messageId) {
    const existing = await channel.messages.fetch(String(messageId)).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return existing;
    }
  }
  return channel.send(payload);
}

async function refreshScheduleMessage(client, guildId) {
  await eventStore.ensureTables();
  const state = await eventStore.getSystemState();
  if (!state || !state.scheduleChannelId) return null;

  const ch = await fetchTextChannel(client, state.scheduleChannelId);
  if (!ch) return null;

  const events = await eventStore.listScheduledEvents(guildId);
  const embed = renderer.buildScheduleEmbed(events);
  const components = renderer.buildScheduleComponents();
  const message = await upsertManagedMessage(ch, state.scheduleMessageId, { embeds: [embed], components });

  await eventStore.upsertSystemState({
    scheduleChannelId: String(ch.id),
    scheduleMessageId: String(message.id)
  });

  return message;
}

async function refreshOperationsPanelMessage(client) {
  await eventStore.ensureTables();
  const state = await eventStore.getSystemState();
  if (!state || !state.operationsChannelId) return null;

  const ch = await fetchTextChannel(client, state.operationsChannelId);
  if (!ch) return null;

  const embed = renderer.buildOperationsPanelEmbed(state.weeklyCompletedCount || 0, state.weeklyCompletedByType || {});
  const components = renderer.buildOperationsPanelComponents();
  const message = await upsertManagedMessage(ch, state.operationsMessageId, { embeds: [embed], components });

  await eventStore.upsertSystemState({
    operationsChannelId: String(ch.id),
    operationsMessageId: String(message.id)
  });

  return message;
}

async function setupEventMessages(client, guildId) {
  await eventStore.ensureTables();
  const state = await eventStore.getSystemState();

  const scheduleChannelId = String(config.EVENT_SCHEDULE_CHANNEL_ID || '').trim();
  const operationsChannelId = String(config.EVENT_OPERATIONS_CHANNEL_ID || '').trim();

  const scheduleChannel = await fetchTextChannel(client, scheduleChannelId);
  const operationsChannel = await fetchTextChannel(client, operationsChannelId);

  if (!scheduleChannel) throw new Error('event_schedule_channel_not_found');
  if (!operationsChannel) throw new Error('event_operations_channel_not_found');

  await eventStore.upsertSystemState({
    scheduleChannelId: scheduleChannel.id,
    operationsChannelId: operationsChannel.id,
    scheduleMessageId: state && state.scheduleMessageId ? state.scheduleMessageId : null,
    operationsMessageId: state && state.operationsMessageId ? state.operationsMessageId : null,
    lastWeekResetKey: (state && state.lastWeekResetKey) || weekResetKey(new Date())
  });

  const scheduleMessage = await refreshScheduleMessage(client, guildId);
  const operationsMessage = await refreshOperationsPanelMessage(client);

  return { scheduleMessage, operationsMessage };
}

async function postLiveEvent(client, payload) {
  await eventStore.ensureTables();
  const state = await eventStore.getSystemState();
  const operationsChannelId = String((state && state.operationsChannelId) || config.EVENT_OPERATIONS_CHANNEL_ID || '').trim();
  const ch = await fetchTextChannel(client, operationsChannelId);
  if (!ch) throw new Error('event_operations_channel_not_found');

  const created = await eventStore.createLiveEvent({
    source: payload.source || 'scheduled',
    eventId: payload.eventId || null,
    guildId: payload.guildId,
    eventTitle: payload.eventTitle,
    hostsText: payload.hostsText || '',
    hostUserId: payload.hostUserId || null,
    description: payload.description || '',
    gameLink: payload.gameLink || '',
    vcLink: payload.vcLink || '',
    eventTypeKey: payload.eventTypeKey || null,
    pingRoleId: payload.pingRoleId || null,
    scheduledFor: payload.scheduledFor || null,
    autoEndAt: payload.autoEndAt || null,
    status: 'active'
  });

  const embed = renderer.buildLiveEventEmbed({
    eventTitle: created.eventTitle,
    hostsText: created.hostsText,
    hostUserId: created.hostUserId,
    description: created.description,
    gameLink: created.gameLink,
    vcLink: created.vcLink,
    scheduledFor: created.scheduledFor
  });
  const components = renderer.buildLiveEventComponents(created.id);

  const msg = await ch.send({ embeds: [embed], components });
  const liveEventPatch = { channelId: ch.id, messageId: msg.id };

  const pingRoleId = created.pingRoleId || String(config.EVENT_DEFAULT_PING_ROLE_ID || '').trim() || null;
  const startedByUserId = String(payload.startedByUserId || payload.hostUserId || '').trim() || null;
  let skipPing = false;
  if (startedByUserId && String(config.EVENT_DEBUG_NO_PING_USER_ID || '').trim() === startedByUserId) {
    try {
      const state = await getState();
      skipPing = !!(state && state.debugMode);
    } catch (e) {
      skipPing = false;
    }
  }

  if (pingRoleId && !skipPing) {
    const pingMessage = await ch.send({ content: `<@&${pingRoleId}>`, allowedMentions: { roles: [pingRoleId] } }).catch(() => null);
    if (pingMessage) {
      liveEventPatch.pingMessageId = pingMessage.id;
    }
  }

  await eventStore.updateLiveEvent(created.id, liveEventPatch);

  return eventStore.getLiveEventById(created.id);
}

async function endLiveEvent(client, liveEventId, actorUserId, reason) {
  await eventStore.ensureTables();
  const live = await eventStore.getLiveEventById(liveEventId);
  if (!live) throw new Error('live_event_not_found');
  if (live.status !== 'active') return live;

  const ended = await eventStore.updateLiveEvent(live.id, {
    status: 'ended',
    endedAt: new Date().toISOString(),
    endedBy: actorUserId ? String(actorUserId) : null,
    endReason: reason || 'manual'
  });

  try {
    const ch = await fetchTextChannel(client, live.channelId);
    if (ch) {
      if (live.messageId) {
        const msg = await ch.messages.fetch(live.messageId).catch(() => null);
        if (msg) {
          const deleted = await msg.delete().then(() => true).catch(() => false);
          if (!deleted) {
            const rows = [];
            for (const comp of msg.components || []) {
              const row = new ActionRowBuilder();
              for (const child of comp.components || []) {
                row.addComponents(ButtonBuilder.from(child).setDisabled(true));
              }
              rows.push(row);
            }
            await msg.edit({ components: rows }).catch(() => null);
          }
        }
      }

      if (live.pingMessageId) {
        const pingMsg = await ch.messages.fetch(live.pingMessageId).catch(() => null);
        if (pingMsg) {
          await pingMsg.delete().catch(() => null);
        }
      }
    }
  } catch (e) {
    console.warn('Failed to clean up ended event message:', e && e.message ? e.message : e);
  }

  await eventStore.incrementWeeklyCounter(live.eventTypeKey || null);
  await refreshOperationsPanelMessage(client);
  return ended;
}

async function maybeResetWeeklyCounter(client) {
  await eventStore.ensureTables();
  const state = await eventStore.getSystemState();
  const key = weekResetKey(new Date());
  if (!state || state.lastWeekResetKey === key) return false;

  await eventStore.upsertSystemState({
    weeklyCompletedCount: 0,
    weeklyCompletedByType: {},
    lastWeekResetKey: key
  });
  await refreshOperationsPanelMessage(client);
  return true;
}

async function handlePresetButton(interaction, client) {
  const key = String(interaction.customId || '').split(':')[1] || '';
  const preset = renderer.getPresetByKey(key);
  if (!preset) {
    await interaction.reply({ content: 'Invalid event preset.', ephemeral: true });
    return;
  }

  if (!await canHostEventsForInteraction(interaction, preset.key)) {
    await interaction.reply({ content: 'You do not have permission to host operations events.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder().setCustomId(`event_preset_modal:${preset.key}`).setTitle(`Start ${preset.label}`);
  const description = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  const gameLink = new TextInputBuilder()
    .setCustomId('game_link')
    .setLabel('Game Link')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  const vcLink = new TextInputBuilder()
    .setCustomId('vc_link')
    .setLabel('Voice Channel Link')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(gameLink),
    new ActionRowBuilder().addComponents(vcLink)
  );

  await interaction.showModal(modal);
}

async function handlePresetModal(interaction, client) {
  const key = String(interaction.customId || '').split(':')[1] || '';
  const preset = renderer.getPresetByKey(key);
  if (!preset) {
    await interaction.reply({ content: 'Invalid event preset.', ephemeral: true });
    return;
  }

  if (!await canHostEventsForInteraction(interaction, preset.key)) {
    await interaction.reply({ content: 'You do not have permission to host operations events.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const descriptionRaw = interaction.fields.getTextInputValue('description') || '';
  const gameLink = interaction.fields.getTextInputValue('game_link') || '';
  const vcLink = interaction.fields.getTextInputValue('vc_link') || '';

  const created = await postLiveEvent(client, {
    source: 'preset',
    guildId: interaction.guildId,
    eventTitle: preset.label,
    hostsText: `<@${interaction.user.id}>`,
    hostUserId: interaction.user.id,
    startedByUserId: interaction.user.id,
    description: String(descriptionRaw).trim() || preset.defaultDescription,
    gameLink,
    vcLink,
    eventTypeKey: preset.key,
    pingRoleId: String(config.EVENT_DEFAULT_PING_ROLE_ID || '').trim() || null,
    autoEndAt: null
  });

  await interaction.editReply({ content: `Started ${preset.label}. Live event ID: ${created.id}` });
}

async function handleLiveEventButton(interaction, client) {
  const raw = String(interaction.customId || '');
  let action = null;
  if (raw.startsWith('event_live_end:')) action = 'end';
  if (raw.startsWith('event_live_edit:')) action = 'edit';
  const liveId = raw.includes(':') ? raw.split(':')[1] : null;

  if (!action || !liveId) {
    await interaction.reply({ content: 'Invalid event action.', ephemeral: true });
    return;
  }

  const live = await eventStore.getLiveEventById(liveId);
  if (!live || live.status !== 'active') {
    await interaction.reply({ content: 'Active event not found.', ephemeral: true });
    return;
  }

  if (!await canHostEventsForInteraction(interaction, live.eventTypeKey || null)) {
    await interaction.reply({ content: 'You do not have permission for this action.', ephemeral: true });
    return;
  }

  if (action === 'end') {
    await interaction.deferReply({ ephemeral: true });
    const ended = await endLiveEvent(client, liveId, interaction.user.id, 'manual');
    await interaction.editReply({ content: ended && ended.status === 'ended' ? 'Event ended.' : 'Event was already ended.' });
    return;
  }

  if (action === 'edit') {
    const modal = new ModalBuilder().setCustomId(`event_live_edit_modal:${liveId}`).setTitle('Edit Event Info');
    const description = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setValue(String(live.description || '').slice(0, 4000));
    const gameLink = new TextInputBuilder()
      .setCustomId('game_link')
      .setLabel('Game Link')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(live.gameLink || '').slice(0, 1000));
    const vcLink = new TextInputBuilder()
      .setCustomId('vc_link')
      .setLabel('Voice Channel Link')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(live.vcLink || '').slice(0, 1000));

    modal.addComponents(
      new ActionRowBuilder().addComponents(description),
      new ActionRowBuilder().addComponents(gameLink),
      new ActionRowBuilder().addComponents(vcLink)
    );
    await interaction.showModal(modal);
    return;
  }

  await interaction.reply({ content: 'Unsupported event action.', ephemeral: true });
}

async function handleLiveEventEditModal(interaction) {
  const liveId = String(interaction.customId || '').split(':')[1] || '';
  const live = await eventStore.getLiveEventById(liveId);
  if (!live || live.status !== 'active') {
    await interaction.reply({ content: 'Active event not found.', ephemeral: true });
    return;
  }

  if (!await canHostEventsForInteraction(interaction, live.eventTypeKey || null)) {
    await interaction.reply({ content: 'You do not have permission for this action.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const description = interaction.fields.getTextInputValue('description') || '';
  const gameLink = interaction.fields.getTextInputValue('game_link') || '';
  const vcLink = interaction.fields.getTextInputValue('vc_link') || '';

  const updated = await eventStore.updateLiveEvent(liveId, { description, gameLink, vcLink });

  try {
    const ch = await fetchTextChannel(interaction.client, updated.channelId);
    if (ch && updated.messageId) {
      const msg = await ch.messages.fetch(updated.messageId).catch(() => null);
      if (msg) {
        const embed = renderer.buildLiveEventEmbed({
          eventTitle: updated.eventTitle,
          hostsText: updated.hostsText,
          hostUserId: updated.hostUserId,
          description: updated.description,
          gameLink: updated.gameLink,
          vcLink: updated.vcLink,
          scheduledFor: updated.scheduledFor
        });
        await msg.edit({ embeds: [embed] });
      }
    }
  } catch (e) {
    console.warn('Failed to update live event message embed:', e && e.message ? e.message : e);
  }

  await interaction.editReply({ content: 'Event info updated.' });
}

module.exports = {
  canManageEvents,
  canHostEvents,
  canHostPreset,
  parseTimeUtc,
  computeNextWeeklyRunAt,
  weekResetKey,
  setupEventMessages,
  refreshScheduleMessage,
  refreshOperationsPanelMessage,
  postLiveEvent,
  endLiveEvent,
  maybeResetWeeklyCounter,
  handlePresetButton,
  handlePresetModal,
  handleLiveEventButton,
  handleLiveEventEditModal
};
