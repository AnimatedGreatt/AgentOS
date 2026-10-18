const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../../config');

const PRESET_TYPES = [
  { key: 'deployments', label: 'Deployment', defaultDescription: 'A Deployment has been hosted. Listen to the host for further instructions.' },
  { key: 'combat_trainings', label: 'Combat Training', defaultDescription: 'A Combat Training has been hosted. Join the provided server and VC and await further instructions.' },
  { key: 'mock_investigations', label: 'Mock Investigation', defaultDescription: 'A Mock Investigation has been hosted. Await further instructions.' },
  { key: 'court_martials', label: 'Court Martial', defaultDescription: 'A Court Martial has been hosted. Join the provided server and VC and await further instructions.' },
  { key: 'sting_operations', label: 'Sting Operation', defaultDescription: 'A Sting Operation has been hosted. Await further instructions.' }
];

function toUnix(input) {
  const ms = new Date(input).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function safe(value, fallback) {
  const v = String(value || '').trim();
  return v || fallback;
}

function sanitizeStars(value, fallback) {
  const base = safe(value, fallback);
  // Trim edge stars so wrapping with bold markers does not produce malformed output.
  return base.replace(/^\*+/, '').replace(/\*+$/, '').trim() || fallback;
}

function eventLine(event) {
  const ts = toUnix(event.nextRunAt || event.startAt);
  const when = ts ? `<t:${ts}:F> (<t:${ts}:R>)` : 'Unknown time';
  const recurrence = event.isRecurring ? ` | weekly ${String(event.recurringTimeUtc || '??:??')} UTC` : '';
  const title = sanitizeStars(event.title, 'Untitled Event');
  const hosts = sanitizeStars(event.hostsText, 'Not provided');
  const description = sanitizeStars(event.description, 'No description provided');
  return [
    `**${title}**`,
    `  **Time:** ${when}${recurrence}`,
    `  **Host(s):** ${hosts}`,
    `  **Description:** ${description}`
  ].join('\n');
}

function buildScheduleEmbed(events) {
  const body = events.length
    ? events.map(eventLine).join('\n\n')
    : 'No scheduled events right now.';

  return new EmbedBuilder()
    .setTitle('Event Schedule')
    .setColor(config.EMBED_COLOR || 0x00aff1)
    .setDescription(body.slice(0, 4096))
    .setFooter({ text: `Capacity ${events.length}/${Number(config.EVENT_SCHEDULE_MAX_ENTRIES || 20)}` })
    .setTimestamp(new Date());
}

function buildScheduleComponents() {
  const url = String(config.EVENT_PANEL_URL || '').trim();
  if (!url) return [];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Events Panel').setURL(url)
  );
  return [row];
}

function buildOperationsPanelEmbed(weeklyCount, weeklyByType) {
  const intro = [
    'This channel is intended to announce operations events.',
    'Authorized hosts may start preset operations below.',
    'End events when complete so weekly tracking stays accurate.'
  ].join('\n');

  const counts = weeklyByType && typeof weeklyByType === 'object' ? weeklyByType : {};
  const lines = PRESET_TYPES.map((preset) => {
    return `${preset.label}: ${Number(counts[preset.key] || 0)}`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle('Welcome to Operations')
    .setColor(config.EMBED_COLOR || 0x00aff1)
    .setDescription(`\`\`\`text\n${intro}\n\`\`\``)
    .addFields({ name: 'Weekly Events Completed', value: lines || 'No completed events yet.', inline: false })
    .setFooter({ text: 'Counter resets Monday 00:00 UTC' })
    .setTimestamp(new Date());
}

function buildOperationsPanelComponents() {
  const row = new ActionRowBuilder();
  for (const preset of PRESET_TYPES) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`event_preset:${preset.key}`)
        .setLabel(preset.label)
        .setStyle(ButtonStyle.Primary)
    );
  }
  return [row];
}

function buildLiveEventEmbed(payload) {
  const fields = [
    { name: 'Host', value: safe(payload.hostsText, payload.hostUserId ? `<@${payload.hostUserId}>` : 'Not provided'), inline: false },
    { name: 'Description', value: safe(payload.description, 'No description provided'), inline: false }
  ];

  if (String(payload.gameLink || '').trim()) {
    fields.push({ name: 'Game Link', value: String(payload.gameLink).trim(), inline: false });
  }

  if (String(payload.vcLink || '').trim()) {
    fields.push({ name: 'Voice Channel Link', value: String(payload.vcLink).trim(), inline: false });
  }

  const embed = new EmbedBuilder()
    .setTitle(safe(payload.eventTitle, 'Operations Event'))
    .setColor(config.EMBED_COLOR || 0x00aff1)
    .addFields(fields)
    .setTimestamp(new Date());

  if (payload.scheduledFor) {
    const ts = toUnix(payload.scheduledFor);
    if (ts) {
      embed.addFields({ name: 'Scheduled For', value: `<t:${ts}:F> (<t:${ts}:R>)`, inline: false });
    }
  }

  return embed;
}

function buildLiveEventComponents(liveEventId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event_live_end:${liveEventId}`).setLabel('End Event').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`event_live_edit:${liveEventId}`).setLabel('Edit Info').setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

function getPresetByKey(key) {
  return PRESET_TYPES.find((x) => x.key === key) || null;
}

module.exports = {
  PRESET_TYPES,
  getPresetByKey,
  buildScheduleEmbed,
  buildScheduleComponents,
  buildOperationsPanelEmbed,
  buildOperationsPanelComponents,
  buildLiveEventEmbed,
  buildLiveEventComponents
};
