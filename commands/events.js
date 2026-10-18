const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const eventStore = require('../utils/events/eventStore');
const eventSystem = require('../utils/events/eventSystem');
const eventScheduler = require('../utils/events/eventScheduler');

const WEEKDAY_CHOICES = [
  { name: 'Sunday', value: '0' },
  { name: 'Monday', value: '1' },
  { name: 'Tuesday', value: '2' },
  { name: 'Wednesday', value: '3' },
  { name: 'Thursday', value: '4' },
  { name: 'Friday', value: '5' },
  { name: 'Saturday', value: '6' }
];

function parseDateInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  // Discord timestamp mention format: <t:unix[:style]>
  const discordTs = value.match(/^<t:(\d{1,13})(?::[tTdDfFR])?>$/);
  if (discordTs) {
    const unix = Number(discordTs[1]);
    const dt = new Date(unix > 9999999999 ? unix : unix * 1000);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }

  // Simple format: DD/MM/YYYY, HH:mm (interpreted as UTC)
  const simple = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*([01]?\d|2[0-3]):([0-5]\d)$/);
  if (simple) {
    const day = Number(simple[1]);
    const month = Number(simple[2]);
    const year = Number(simple[3]);
    const hour = Number(simple[4]);
    const minute = Number(simple[5]);

    const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    // Reject invalid rollover dates such as 31/02/2026.
    if (
      dt.getUTCFullYear() !== year ||
      (dt.getUTCMonth() + 1) !== month ||
      dt.getUTCDate() !== day
    ) {
      return null;
    }
    return dt;
  }

  return null;
}

function requireCorrectGuild(interaction) {
  const targetGuild = String(config.EVENT_GUILD_ID || '').trim();
  if (!targetGuild) return true;
  return String(interaction.guildId || '') === targetGuild;
}

function dbNotConfiguredReply(interaction) {
  return interaction.editReply({ content: 'Events database is not configured. Set DATABASE_URL before using /events.' });
}

function uniquePush(target, value) {
  const v = String(value || '').trim();
  if (!v) return;
  if (!target.includes(v)) target.push(v);
}

function extractMentionIds(text, regex) {
  const ids = [];
  if (!text) return ids;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m[1]) ids.push(String(m[1]));
  }
  return Array.from(new Set(ids));
}

async function resolveHostsDisplayText(interaction, hostsRaw) {
  const text = String(hostsRaw || '').trim();
  if (!text) return interaction.user.username || interaction.user.tag || 'Unknown';

  const result = [];
  const userIds = extractMentionIds(text, /<@!?(\d+)>/g);
  const roleIds = extractMentionIds(text, /<@&(\d+)>/g);

  for (const userId of userIds) {
    let name = null;
    try {
      const member = interaction.guild ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
      if (member && member.user) name = member.user.username || member.displayName || null;
    } catch (e) {}
    if (!name) {
      try {
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        if (user) name = user.username || user.tag || null;
      } catch (e) {}
    }
    uniquePush(result, name || userId);
  }

  for (const roleId of roleIds) {
    let roleName = null;
    try {
      const role = interaction.guild ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
      if (role) roleName = role.name;
    } catch (e) {}
    uniquePush(result, roleName || roleId);
  }

  const plain = text
    .replace(/<@!?(\d+)>/g, ' ')
    .replace(/<@&(\d+)>/g, ' ')
    .split(/[,\n|]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const token of plain) uniquePush(result, token);

  if (!result.length) {
    uniquePush(result, interaction.user.username || interaction.user.tag || 'Unknown');
  }

  return result.join(', ').slice(0, 1000);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('events')
    .setDescription('Manage scheduled events and operations setup')
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Add a scheduled event')
      .addStringOption((opt) => opt.setName('title').setDescription('Event title').setRequired(true))
      .addStringOption((opt) => opt.setName('hosts').setDescription('Host mentions or labels').setRequired(true))
      .addStringOption((opt) => opt.setName('description').setDescription('Event description').setRequired(true))
      .addStringOption((opt) => opt.setName('start').setDescription('One-off start: <t:unix> or DD/MM/YYYY, HH:mm').setRequired(false))
      .addBooleanOption((opt) => opt.setName('recurring').setDescription('Make this event recurring weekly').setRequired(false))
      .addStringOption((opt) => {
        opt.setName('weekday').setDescription('Recurring weekday (required when recurring=true)').setRequired(false);
        for (const c of WEEKDAY_CHOICES) opt.addChoices(c);
        return opt;
      })
      .addStringOption((opt) => opt.setName('time_utc').setDescription('Recurring UTC time HH:mm').setRequired(false))
      .addStringOption((opt) => opt.setName('game_link').setDescription('Optional game link for the scheduled event').setRequired(false))
      .addStringOption((opt) => opt.setName('vc_link').setDescription('Optional VC link for the scheduled event').setRequired(false))
      .addRoleOption((opt) => opt.setName('custom_ping_role').setDescription('Optional ping role override').setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('edit')
      .setDescription('Edit an existing scheduled event')
      .addStringOption((opt) => opt.setName('id').setDescription('Event ID').setRequired(true))
      .addStringOption((opt) => opt.setName('title').setDescription('New title').setRequired(false))
      .addStringOption((opt) => opt.setName('hosts').setDescription('New host mentions or labels').setRequired(false))
      .addStringOption((opt) => opt.setName('description').setDescription('New description').setRequired(false))
      .addStringOption((opt) => opt.setName('start').setDescription('New one-off start: <t:unix> or DD/MM/YYYY, HH:mm').setRequired(false))
      .addBooleanOption((opt) => opt.setName('recurring').setDescription('Set recurring mode').setRequired(false))
      .addStringOption((opt) => {
        opt.setName('weekday').setDescription('Recurring weekday').setRequired(false);
        for (const c of WEEKDAY_CHOICES) opt.addChoices(c);
        return opt;
      })
      .addStringOption((opt) => opt.setName('time_utc').setDescription('Recurring UTC time HH:mm').setRequired(false))
      .addStringOption((opt) => opt.setName('game_link').setDescription('Optional game link for the scheduled event').setRequired(false))
      .addStringOption((opt) => opt.setName('vc_link').setDescription('Optional VC link for the scheduled event').setRequired(false))
      .addRoleOption((opt) => opt.setName('custom_ping_role').setDescription('Optional ping role override').setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove a scheduled event')
      .addStringOption((opt) => opt.setName('id').setDescription('Event ID').setRequired(true))),

  guildOnly: String(config.EVENT_GUILD_ID || '').trim() || undefined,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!requireCorrectGuild(interaction)) {
      await interaction.editReply({ content: 'This command is only available in the configured event guild.' });
      return;
    }

    if (!eventSystem.canManageEvents(interaction.member, interaction.user.id)) {
      await interaction.editReply({ content: 'You do not have permission to manage events.' });
      return;
    }

    const sub = interaction.options.getSubcommand();

    try {
      await eventStore.ensureTables();
    } catch (err) {
      if (err && err.code === 'events_db_not_configured') {
        await dbNotConfiguredReply(interaction);
        return;
      }
      throw err;
    }

    if (sub === 'add') {
      const title = interaction.options.getString('title', true);
      const hosts = interaction.options.getString('hosts', true);
      const description = interaction.options.getString('description', true);
      const recurring = interaction.options.getBoolean('recurring') || false;
      const weekdayRaw = interaction.options.getString('weekday');
      const timeUtcRaw = interaction.options.getString('time_utc');
      const startRaw = interaction.options.getString('start');
      const gameLink = interaction.options.getString('game_link');
      const vcLink = interaction.options.getString('vc_link');
      const customPingRole = interaction.options.getRole('custom_ping_role');
      const hostsDisplay = await resolveHostsDisplayText(interaction, hosts);

      let startAt = null;
      let nextRunAt = null;
      let recurringWeekday = null;
      let recurringTimeUtc = null;

      // If a non-recurring event has no start value, post it immediately to Operations.
      if (!recurring && !startRaw) {
        const live = await eventSystem.postLiveEvent(interaction.client, {
          source: 'scheduled',
          eventId: null,
          guildId: interaction.guildId,
          eventTitle: title,
          hostsText: hosts,
          startedByUserId: interaction.user.id,
          description,
          gameLink: gameLink || '',
          vcLink: vcLink || '',
          eventTypeKey: 'custom',
          pingRoleId: customPingRole ? customPingRole.id : null,
          scheduledFor: new Date().toISOString(),
          autoEndAt: null
        });
        await interaction.editReply({ content: `No start provided, so the event was started immediately. Live event ID: ${live.id}` });
        return;
      }

      const count = await eventStore.countScheduledEvents(interaction.guildId);
      const cap = Number(config.EVENT_SCHEDULE_MAX_ENTRIES || 20);
      if (count >= cap) {
        await interaction.editReply({ content: `Schedule is full (${count}/${cap}). Remove an event before adding another.` });
        return;
      }

      if (recurring) {
        if (weekdayRaw === null || !timeUtcRaw) {
          await interaction.editReply({ content: 'Recurring events require both weekday and time_utc.' });
          return;
        }
        recurringWeekday = Number(weekdayRaw);
        recurringTimeUtc = eventSystem.parseTimeUtc(timeUtcRaw);
        if (!recurringTimeUtc) {
          await interaction.editReply({ content: 'time_utc must be in HH:mm format (UTC).' });
          return;
        }
        const next = eventSystem.computeNextWeeklyRunAt(recurringWeekday, recurringTimeUtc, new Date());
        if (!next) {
          await interaction.editReply({ content: 'Failed to compute next recurring run time.' });
          return;
        }
        nextRunAt = next.toISOString();
      } else {
        const parsed = parseDateInput(startRaw);
        if (!parsed) {
          await interaction.editReply({ content: 'Invalid start time. Use <t:unix> or DD/MM/YYYY, HH:mm.' });
          return;
        }
        if (parsed.getTime() <= Date.now()) {
          await interaction.editReply({ content: 'Start time must be in the future.' });
          return;
        }
        startAt = parsed.toISOString();
        nextRunAt = parsed.toISOString();
      }

      const created = await eventStore.createEvent({
        guildId: interaction.guildId,
        title,
        description,
        hostsText: hosts,
        gameLink: gameLink || '',
        vcLink: vcLink || '',
        startAt,
        isRecurring: recurring,
        recurringWeekday,
        recurringTimeUtc,
        nextRunAt,
        pingRoleId: customPingRole ? customPingRole.id : null,
        createdBy: interaction.user.id,
        createdByUsername: hostsDisplay,
        status: 'scheduled'
      });

      await eventSystem.refreshScheduleMessage(interaction.client, interaction.guildId);
      await eventScheduler.resyncAll();
      await interaction.editReply({ content: `Scheduled event created: ${created.id}` });
      return;
    }

    if (sub === 'edit') {
      const id = interaction.options.getString('id', true).trim();
      const event = await eventStore.getEventById(id);
      if (!event || event.guildId !== interaction.guildId || event.status !== 'scheduled') {
        await interaction.editReply({ content: 'Scheduled event not found.' });
        return;
      }

      const title = interaction.options.getString('title');
      const hosts = interaction.options.getString('hosts');
      const description = interaction.options.getString('description');
      const recurringOpt = interaction.options.getBoolean('recurring');
      const weekdayRaw = interaction.options.getString('weekday');
      const timeUtcRaw = interaction.options.getString('time_utc');
      const startRaw = interaction.options.getString('start');
      const gameLink = interaction.options.getString('game_link');
      const vcLink = interaction.options.getString('vc_link');
      const customPingRole = interaction.options.getRole('custom_ping_role');

      const updates = {};
      if (title !== null) updates.title = title;
      if (hosts !== null) {
        updates.hostsText = hosts;
        updates.createdByUsername = await resolveHostsDisplayText(interaction, hosts);
      }
      if (description !== null) updates.description = description;
      if (gameLink !== null) updates.gameLink = gameLink;
      if (vcLink !== null) updates.vcLink = vcLink;
      if (customPingRole) updates.pingRoleId = customPingRole.id;

      const willRecurring = recurringOpt === null ? event.isRecurring : recurringOpt;
      updates.isRecurring = willRecurring;

      if (willRecurring) {
        const weekday = weekdayRaw !== null ? Number(weekdayRaw) : event.recurringWeekday;
        const timeUtc = timeUtcRaw !== null ? eventSystem.parseTimeUtc(timeUtcRaw) : event.recurringTimeUtc;
        if (weekday === null || weekday === undefined || !timeUtc) {
          await interaction.editReply({ content: 'Recurring event requires weekday and time_utc (existing or new).' });
          return;
        }
        const next = eventSystem.computeNextWeeklyRunAt(weekday, timeUtc, new Date());
        if (!next) {
          await interaction.editReply({ content: 'Failed to compute next recurring run time.' });
          return;
        }
        updates.recurringWeekday = weekday;
        updates.recurringTimeUtc = timeUtc;
        updates.startAt = null;
        updates.nextRunAt = next.toISOString();
      } else {
        const startInput = startRaw || event.nextRunAt || event.startAt;
        const parsed = parseDateInput(startInput);
        if (!parsed) {
          await interaction.editReply({ content: 'A valid one-off start time is required. Use <t:unix> or DD/MM/YYYY, HH:mm.' });
          return;
        }
        if (parsed.getTime() <= Date.now()) {
          await interaction.editReply({ content: 'One-off start time must be in the future.' });
          return;
        }
        updates.recurringWeekday = null;
        updates.recurringTimeUtc = null;
        updates.startAt = parsed.toISOString();
        updates.nextRunAt = parsed.toISOString();
      }

      const updated = await eventStore.updateEvent(id, updates);
      if (!updated) {
        await interaction.editReply({ content: 'Failed to update event.' });
        return;
      }

      await eventSystem.refreshScheduleMessage(interaction.client, interaction.guildId);
      await eventScheduler.resyncAll();
      await interaction.editReply({ content: `Scheduled event updated: ${updated.id}` });
      return;
    }

    if (sub === 'remove') {
      const id = interaction.options.getString('id', true).trim();
      const removed = await eventStore.removeEvent(id, interaction.guildId);
      if (!removed) {
        await interaction.editReply({ content: 'Scheduled event not found.' });
        return;
      }

      await eventSystem.refreshScheduleMessage(interaction.client, interaction.guildId);
      await eventScheduler.resyncAll();
      await interaction.editReply({ content: `Scheduled event removed: ${id}` });
      return;
    }

    await interaction.editReply({ content: 'Unknown subcommand.' });
  }
};
