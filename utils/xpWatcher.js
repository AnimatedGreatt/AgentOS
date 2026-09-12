const config = require('../config');
const { EmbedBuilder } = require('discord.js');
const { listActiveAosEntries } = require('./aosForumLookup');
const aosActiveStore = require('./aosActiveStore');
const { getState } = require('./adminState');

const recentAlerts = new Map();
let lastPruneAt = 0;
let aosEntriesCache = null;
let aosEntriesCacheExpiresAt = 0;
let aosEntriesInFlight = null;
let lastChannelMismatchLogAt = 0;
let adminDebugModeCached = false;
let adminDebugModeCheckedAt = 0;
let adminDebugModeInFlight = null;

const ADMIN_DEBUG_CACHE_MS = 5000;

async function refreshAdminDebugMode() {
  const now = Date.now();
  if ((now - adminDebugModeCheckedAt) < ADMIN_DEBUG_CACHE_MS) {
    return adminDebugModeCached;
  }

  if (adminDebugModeInFlight) return adminDebugModeInFlight;

  adminDebugModeInFlight = getState()
    .then((state) => {
      adminDebugModeCached = !!(state && state.debugMode);
      adminDebugModeCheckedAt = Date.now();
      return adminDebugModeCached;
    })
    .catch(() => {
      adminDebugModeCheckedAt = Date.now();
      return adminDebugModeCached;
    })
    .finally(() => {
      adminDebugModeInFlight = null;
    });

  return adminDebugModeInFlight;
}

function isVerbose() {
  return !!config.XP_ALERT_VERBOSE || adminDebugModeCached;
}

function debugLog(message, data) {
  if (!isVerbose()) return;
  try {
    if (data !== undefined) {
      console.info(`[xpWatcher] ${message}`, data);
    } else {
      console.info(`[xpWatcher] ${message}`);
    }
  } catch (e) {
    // ignore logging issues
  }
}

function looksLikeXpAuditMessage(message) {
  const parts = [];
  if (message && typeof message.content === 'string') parts.push(message.content);
  if (message && Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (!embed) continue;
      if (embed.title) parts.push(String(embed.title));
      if (embed.description) parts.push(String(embed.description));
      if (Array.isArray(embed.fields)) {
        for (const f of embed.fields) {
          if (f && f.name) parts.push(String(f.name));
          if (f && f.value) parts.push(String(f.value));
        }
      }
    }
  }
  const text = parts.join('\n').toLowerCase();
  return text.includes('xp') && (text.includes('changed') || text.includes('updated') || text.includes('audit'));
}

function warnLog(message, data) {
  try {
    if (data !== undefined) {
      console.warn(`[xpWatcher] ${message}`, data);
    } else {
      console.warn(`[xpWatcher] ${message}`);
    }
  } catch (e) {
    // ignore logging issues
  }
}

function getAosCacheTtlMs() {
  const raw = Number(config.XP_AOS_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 60 * 1000;
}

async function getCachedAosEntries(client) {
  const now = Date.now();
  if (Array.isArray(aosEntriesCache) && now < aosEntriesCacheExpiresAt) {
    return aosEntriesCache;
  }

  if (aosEntriesInFlight) return aosEntriesInFlight;

  const sourcePromise = aosActiveStore.isEnabled()
    ? aosActiveStore.listActiveAosRows().catch(() => [])
    : listActiveAosEntries(client);

  aosEntriesInFlight = sourcePromise
    .then((entries) => {
      const safeEntries = Array.isArray(entries) ? entries : [];
      aosEntriesCache = safeEntries;
      aosEntriesCacheExpiresAt = Date.now() + getAosCacheTtlMs();
      debugLog('AoS cache refreshed', { count: safeEntries.length, ttlMs: getAosCacheTtlMs() });
      return safeEntries;
    })
    .catch((err) => {
      // On fetch errors, keep behavior non-breaking by returning empty list.
      debugLog('AoS lookup failed', { error: err && (err.message || err) });
      return [];
    })
    .finally(() => {
      aosEntriesInFlight = null;
    });

  return aosEntriesInFlight;
}

function pruneRecentAlerts(now, dedupMinutes) {
  const dedupMs = Math.max(1, Number(dedupMinutes) || 10) * 60 * 1000;
  // Avoid pruning too frequently under heavy message throughput.
  if (now - lastPruneAt < 60 * 1000) return;
  lastPruneAt = now;

  for (const [k, ts] of recentAlerts.entries()) {
    if (!Number.isFinite(Number(ts)) || (now - Number(ts)) >= dedupMs) {
      recentAlerts.delete(k);
    }
  }

  // Hard cap to protect memory in unusually high-cardinality username streams.
  const maxEntries = 5000;
  while (recentAlerts.size > maxEntries) {
    const firstKey = recentAlerts.keys().next().value;
    if (!firstKey) break;
    recentAlerts.delete(firstKey);
  }
}

function normalizeUsername(value) {
  let text = String(value || '').trim();
  while (text.length >= 2 && text.startsWith('*') && text.endsWith('*')) {
    text = text.slice(1, -1).trim();
  }
  return text.toLowerCase();
}

function getAlertKey(username) {
  return normalizeUsername(username);
}

function extractUsernameFromAuditMessage(message) {
  const textParts = [];

  if (message && typeof message.content === 'string') textParts.push(message.content);
  if (message && Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (!embed) continue;
      if (embed.title) textParts.push(embed.title);
      if (embed.description) textParts.push(embed.description);
      if (Array.isArray(embed.fields)) {
        for (const field of embed.fields) {
          if (field && field.name) textParts.push(`${field.name}: ${field.value || ''}`);
        }
      }
    }
  }

  const text = textParts.join('\n');
  const patterns = [
    /Changed\s+(.+?)'s\s+XP\s+from\s+/i,
    /Changed\s+XP\s+for\s+(.+?)\s+from\s+/i,
    /Updated\s+(.+?)'s\s+XP\s+(?:from|to)\s+/i,
    /\bUser(?:name)?\s*[:|-]\s*([^\n]+)/i,
    /\bTarget\s*[:|-]\s*([^\n]+)/i,
    /\bPlayer\s*[:|-]\s*([^\n]+)/i
  ];
  for (const rx of patterns) {
    const match = text.match(rx);
    if (match && match[1]) return match[1].trim();
  }

  if (message && Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (!embed || !Array.isArray(embed.fields)) continue;
      for (const field of embed.fields) {
        const name = String((field && field.name) || '').toLowerCase().trim();
        const value = String((field && field.value) || '').trim();
        if (!value) continue;
        if (/^(username|user|user name|target|player|roblox username)$/.test(name)) {
          return value;
        }
      }
    }
  }

  return null;
}

function formatDiscordTimestamp(date, style = 'f') {
  const time = date instanceof Date ? date : new Date();
  const unixSeconds = Math.floor(time.getTime() / 1000);
  return `<t:${unixSeconds}:${style}>`;
}

async function initXpWatcherDiagnostics(client) {
  try {
    await refreshAdminDebugMode();
    if (!client) return;
    const guilds = Array.from((client.guilds && client.guilds.cache && client.guilds.cache.values()) || []);
    const guildSummary = guilds.map(g => `${g.name}(${g.id})`).slice(0, 25);
    console.info('[xpWatcher] Startup diagnostics', {
      guildCount: guilds.length,
      guilds: guildSummary,
      configuredXpLogChannelId: String(config.XP_LOG_CHANNEL_ID || ''),
      configuredXpAlertChannelId: String(config.XP_ALERT_CHANNEL_ID || '')
    });

    const xpLogCh = await client.channels.fetch(config.XP_LOG_CHANNEL_ID).catch(() => null);
    if (!xpLogCh) {
      warnLog('Configured XP log channel could not be fetched', { channelId: String(config.XP_LOG_CHANNEL_ID || '') });
    } else {
      console.info('[xpWatcher] XP log channel resolved', {
        channelId: xpLogCh.id,
        guildId: xpLogCh.guildId || null,
        guildName: (xpLogCh.guild && xpLogCh.guild.name) || null,
        type: xpLogCh.type
      });
    }

    const xpAlertCh = await client.channels.fetch(config.XP_ALERT_CHANNEL_ID).catch(() => null);
    if (!xpAlertCh) {
      warnLog('Configured XP alert channel could not be fetched', { channelId: String(config.XP_ALERT_CHANNEL_ID || '') });
    } else {
      console.info('[xpWatcher] XP alert channel resolved', {
        channelId: xpAlertCh.id,
        guildId: xpAlertCh.guildId || null,
        guildName: (xpAlertCh.guild && xpAlertCh.guild.name) || null,
        type: xpAlertCh.type
      });
    }
  } catch (e) {
    warnLog('Startup diagnostics failed', { error: e && (e.message || e) });
  }
}

async function handleXpAuditLogMessage(message, client) {
  await refreshAdminDebugMode();
  if (!message || !message.channel) return;
  const inXpChannel = String(message.channel.id) === String(config.XP_LOG_CHANNEL_ID);
  if (!inXpChannel) {
    if (looksLikeXpAuditMessage(message)) {
      const now = Date.now();
      // Prevent noisy logs if many audit messages are flowing in the wrong channel.
      if (now - lastChannelMismatchLogAt > 60 * 1000) {
        lastChannelMismatchLogAt = now;
        warnLog('XP-like message seen outside configured XP_LOG_CHANNEL_ID', {
          messageChannelId: message.channel.id,
          configuredXpLogChannelId: String(config.XP_LOG_CHANNEL_ID)
        });
      }
    }
    return;
  }

  const username = extractUsernameFromAuditMessage(message);
  if (!username) {
    debugLog('No username parsed from XP log message', { messageId: message.id });
    return;
  }

  const key = getAlertKey(username);
  const dedupMinutes = Number.isFinite(Number(config.XP_ALERT_DEDUP_MINUTES)) ? Number(config.XP_ALERT_DEDUP_MINUTES) : 10;
  const now = Date.now();
  pruneRecentAlerts(now, dedupMinutes);
  const lastSeen = recentAlerts.get(key);
  if (lastSeen && (now - lastSeen) < dedupMinutes * 60 * 1000) {
    debugLog('Alert suppressed by dedupe window', { username, dedupMinutes });
    return;
  }

  const aosEntries = await getCachedAosEntries(client);
  const matches = aosEntries.filter(entry => normalizeUsername(entry.username) === key);
  if (!matches.length) {
    debugLog('No active AoS match for parsed username', { username, cachedEntries: aosEntries.length });
    return;
  }

  recentAlerts.set(key, now);

  const alertChannel = await client.channels.fetch(config.XP_ALERT_CHANNEL_ID).catch(() => null);
  if (!alertChannel) {
    warnLog('Alert channel not found', { channelId: config.XP_ALERT_CHANNEL_ID });
    return;
  }

  const count = matches.length;
  const currentTime = formatDiscordTimestamp(new Date(), 'f');
  const primaryMatch = matches.find((entry) => typeof entry?.profile === 'string' && /^https?:\/\//i.test(entry.profile.trim())) || matches[0];
  const aosPageUrl = String((primaryMatch && (primaryMatch.profile || primaryMatch.url)) || '').trim();

  const embed = new EmbedBuilder()
    .setTitle('AOS Alert')
    .setColor(0xed4245)
    .setDescription(`User [${username}](${aosPageUrl || 'https://animatedgreatt.github.io/dashboard.html'}) with ${count} outstanding warrant${count === 1 ? '' : 's'} has been detected online at ${currentTime}. Please respond.`)
    .setFooter('XP Monitor');

  if (aosPageUrl) embed.setURL(aosPageUrl);

  await alertChannel.send({ embeds: [embed] }).catch((err) => {
    warnLog('Failed to send AoS alert', { error: err && (err.message || err) });
    return null;
  });
  console.info('[xpWatcher] AoS alert sent', { username, warrants: count, channelId: alertChannel.id });
}

module.exports = {
  initXpWatcherDiagnostics,
  handleXpAuditLogMessage,
  extractUsernameFromAuditMessage
};
