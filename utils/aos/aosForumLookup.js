const config = require('../../config');

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function stripOuterAsterisks(value) {
  let text = String(value || '').trim();
  while (text.length >= 2 && text.startsWith('*') && text.endsWith('*')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function parseFieldValue(content, fieldName) {
  const text = String(content || '').replace(/\r/g, '');
  const escaped = String(fieldName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const sameLine = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, 'i').exec(text);
  if (sameLine && sameLine[1]) return sameLine[1].trim();

  const nextLine = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*\\n+\\s*([^\\n]+)`, 'i').exec(text);
  if (nextLine && nextLine[1]) return nextLine[1].trim();

  // Fallback for non-bold field format: Username: value
  const plainSameLine = new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*([^\\n]+)`, 'i').exec(text);
  if (plainSameLine && plainSameLine[1]) return plainSameLine[1].trim();

  const plainNextLine = new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*\\n+\\s*([^\\n]+)`, 'i').exec(text);
  if (plainNextLine && plainNextLine[1]) return plainNextLine[1].trim();

  return null;
}

function parseUsernameField(content) {
  const parsed = parseFieldValue(content, 'Username');
  if (!parsed) return parsed;
  return stripOuterAsterisks(parsed);
}

function parseChargesField(content) {
  return parseFieldValue(content, 'Charges');
}

function parseSubmitterField(content) {
  return parseFieldValue(content, 'Submitter');
}

function parseProfileField(content) {
  return parseFieldValue(content, 'Profile');
}

function parseVictimsField(content) {
  return parseFieldValue(content, 'Victim(s)') || parseFieldValue(content, 'Victims');
}

function parseSummaryField(content) {
  return parseFieldValue(content, 'Summary');
}

function parseProofField(content) {
  return parseFieldValue(content, 'Proof');
}

function parseJailMinutes(content) {
  const text = String(content || '').replace(/\r/g, '');
  const match = text.match(/Jail\s*time\s*has\s*been\s*set\s*to\s*(\d+)\s*minutes?/i);
  if (!match || !match[1]) return null;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes;
}

function parseAosStarterData(content) {
  const text = String(content || '');
  const username = parseUsernameField(text) || null;
  const charges = parseChargesField(text) || null;
  const jailMinutes = parseJailMinutes(text);

  return {
    submitter: parseSubmitterField(text) || null,
    username,
    profile: parseProfileField(text) || null,
    victims: parseVictimsField(text) || null,
    charges,
    summary: parseSummaryField(text) || null,
    proof: parseProofField(text) || null,
    jailMinutes,
    calculatedTimeMinutes: jailMinutes
  };
}

function renderThreadUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

async function fetchCandidateThreads(forumChannel, maxThreads) {
  const bucket = [];

  try {
    const active = await forumChannel.threads.fetchActive();
    const activeThreads = Array.from((active && active.threads && active.threads.values()) || []);
    bucket.push(...activeThreads);
  } catch (err) {
    // ignore
  }

  try {
    const archived = await forumChannel.threads.fetchArchived({ type: 'public', fetchAll: false, limit: maxThreads });
    const archivedThreads = Array.from((archived && archived.threads && archived.threads.values()) || []);
    bucket.push(...archivedThreads);
  } catch (err) {
    // ignore
  }

  const dedup = new Map();
  for (const thread of bucket) {
    if (!thread || !thread.id) continue;
    dedup.set(thread.id, thread);
    if (dedup.size >= maxThreads) break;
  }

  return Array.from(dedup.values());
}

function applyTagMutations(current, { add = [], remove = [] }) {
  const next = new Set((current || []).map(String));
  for (const tagId of add) next.add(String(tagId));
  for (const tagId of remove) next.delete(String(tagId));
  return Array.from(next);
}

async function enforceAos30DayExpirationForThread(thread) {
  if (!thread || !thread.id) return false;
  const tags = Array.isArray(thread.appliedTags) ? thread.appliedTags.map(String) : [];
  const activeTagId = String(config.AOS_TAG_ACTIVE_WARRANT_ID || '');
  const tag30Day = String(config.AOS_TAG_30_DAY_ID || '');
  const inactiveTagId = String(config.AOS_TAG_INACTIVE_WARRANT_ID || '');
  const recalledTagId = String(config.AOS_TAG_RECALLED_ID || '1414717678156779752');
  const completedTagId = String(config.AOS_TAG_COMPLETED_ID || '');
  const approvedTagId = String(config.AOS_TAG_APPROVED_ID || '');

  if (!activeTagId || !tag30Day || !inactiveTagId || !recalledTagId) return false;
  if (!tags.includes(activeTagId) || !tags.includes(tag30Day)) return false;

  const createdAt = Number(thread.createdTimestamp);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  const isExpired = (Date.now() - createdAt) >= (30 * 24 * 60 * 60 * 1000);
  if (!isExpired) return false;

  const nextTags = applyTagMutations(tags, {
    add: [inactiveTagId, recalledTagId],
    remove: [activeTagId, completedTagId, approvedTagId]
  });

  await thread.setAppliedTags(nextTags);
  return true;
}

async function findActiveAosByUsername(client, username) {
  const target = normalizeUsername(username);
  if (!target) return [];

  try {
    const aosActiveStore = require('./aosActiveStore');
    if (aosActiveStore && typeof aosActiveStore.isEnabled === 'function' && aosActiveStore.isEnabled()) {
      const dbRows = await aosActiveStore.listActiveAosRowsByUsername(target).catch(() => []);
      if (Array.isArray(dbRows) && dbRows.length) {
        return dbRows.map(row => ({
          threadId: row.threadId,
          threadName: row.threadName || `AoS ${row.username || target}`,
          url: row.url || renderThreadUrl(row.guildId, row.threadId)
        }));
      }
    }
  } catch (err) {
    // ignore and continue with live fallback
  }

  const forumChannel = await client.channels.fetch(config.AOS_FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel) return [];

  const maxThreads = Number.isFinite(Number(config.AOS_LOOKUP_MAX_THREADS))
    ? Number(config.AOS_LOOKUP_MAX_THREADS)
    : 100;

  const threads = await fetchCandidateThreads(forumChannel, Math.max(1, maxThreads));
  const activeTagId = String(config.AOS_TAG_ACTIVE_WARRANT_ID || '');

  const matches = [];

  for (const thread of threads) {
    try {
      await enforceAos30DayExpirationForThread(thread);
    } catch (err) {
      // ignore mutation failures and continue lookup
    }

    const tags = Array.isArray(thread.appliedTags) ? thread.appliedTags.map(String) : [];
    if (!activeTagId || !tags.includes(activeTagId)) continue;

    let starter = null;
    try {
      starter = await thread.fetchStarterMessage();
    } catch (err) {
      starter = await thread.messages.fetch(thread.id).catch(() => null);
    }

    const parsedUsername = parseUsernameField(starter && starter.content ? starter.content : '');
    if (!parsedUsername) continue;

    if (normalizeUsername(parsedUsername) !== target) continue;

    matches.push({
      threadId: thread.id,
      threadName: thread.name || `AoS ${parsedUsername}`,
      url: renderThreadUrl(thread.guildId, thread.id)
    });
  }

  return matches;
}

async function listActiveAosEntries(client) {
  const forumChannel = await client.channels.fetch(config.AOS_FORUM_CHANNEL_ID).catch(() => null);
  if (!forumChannel) return [];

  const maxThreads = Number.isFinite(Number(config.AOS_LOOKUP_MAX_THREADS))
    ? Number(config.AOS_LOOKUP_MAX_THREADS)
    : 100;

  const threads = await fetchCandidateThreads(forumChannel, Math.max(1, maxThreads));
  const activeTagId = String(config.AOS_TAG_ACTIVE_WARRANT_ID || '');
  const entries = [];

  for (const thread of threads) {
    try {
      await enforceAos30DayExpirationForThread(thread);
    } catch (err) {
      // ignore mutation failures and continue listing
    }

    const tags = Array.isArray(thread.appliedTags) ? thread.appliedTags.map(String) : [];
    if (!activeTagId || !tags.includes(activeTagId)) continue;

    let starter = null;
    try {
      starter = await thread.fetchStarterMessage();
    } catch (err) {
      starter = await thread.messages.fetch(thread.id).catch(() => null);
    }

    const content = starter && starter.content ? starter.content : '';
    const parsed = parseAosStarterData(content);
    const username = parsed.username || 'Unknown';

    entries.push({
      threadId: thread.id,
      guildId: thread.guildId,
      forumChannelId: thread.parentId,
      threadName: thread.name || `AoS ${username}`,
      username,
      submitter: parsed.submitter,
      profile: parsed.profile,
      victims: parsed.victims,
      charges: parsed.charges || 'Unknown',
      summary: parsed.summary,
      proof: parsed.proof,
      jailMinutes: parsed.jailMinutes,
      calculatedTimeMinutes: parsed.calculatedTimeMinutes,
      tags,
      createdTimestamp: Number(thread.createdTimestamp) || null,
      url: renderThreadUrl(thread.guildId, thread.id)
    });
  }

  return entries;
}

module.exports = {
  parseFieldValue,
  parseUsernameField,
  parseChargesField,
  parseJailMinutes,
  parseAosStarterData,
  enforceAos30DayExpirationForThread,
  findActiveAosByUsername,
  listActiveAosEntries
};
