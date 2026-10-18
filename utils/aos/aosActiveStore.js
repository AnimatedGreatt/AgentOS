const config = require('../../config');

let db = null;
let enabled = false;

if (process.env.DATABASE_URL || config.DATABASE_URL) {
  try {
    db = require('../db/db');
    enabled = true;
  } catch (err) {
    console.warn('aosActiveStore: failed to load DB module, disabled:', err?.message || err);
    enabled = false;
  }
}

function getPool() {
  if (!enabled || !db || !db.pool) return null;
  return db.pool;
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function normalizeUrl(value) {
  const url = String(value || '').trim();
  return url || null;
}

function normalizeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  return out || null;
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const out = [];
  const seen = new Set();
  for (const tag of list) {
    const t = String(tag || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseTimestampMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function init() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_active_aos (
      thread_id TEXT PRIMARY KEY,
      guild_id TEXT,
      forum_channel_id TEXT,
      thread_name TEXT,
      thread_url TEXT,
      submitter TEXT,
      username TEXT NOT NULL,
      profile TEXT,
      victims TEXT,
      charges TEXT,
      summary TEXT,
      proof TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      calculated_time_minutes INTEGER,
      jail_minutes INTEGER,
      posted_by_bot BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );

  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS submitter TEXT`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS profile TEXT`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS victims TEXT`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS summary TEXT`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS proof TEXT`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS calculated_time_minutes INTEGER`);
  await pool.query(`ALTER TABLE bot_active_aos ADD COLUMN IF NOT EXISTS jail_minutes INTEGER`);

  await pool.query(
    `CREATE OR REPLACE FUNCTION notify_aos_field_updates()
     RETURNS trigger AS $$
     BEGIN
       IF NEW.charges IS DISTINCT FROM OLD.charges
          OR NEW.jail_minutes IS DISTINCT FROM OLD.jail_minutes
          OR NEW.username IS DISTINCT FROM OLD.username THEN
         PERFORM pg_notify(
           'aos_field_updates',
           json_build_object(
             'threadId', NEW.thread_id,
             'username', NEW.username,
             'oldUsername', OLD.username,
             'newUsername', NEW.username,
             'oldCharges', OLD.charges,
             'newCharges', NEW.charges,
             'oldJailMinutes', OLD.jail_minutes,
             'newJailMinutes', NEW.jail_minutes
           )::text
         );
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`
  );

  await pool.query(`DROP TRIGGER IF EXISTS trg_notify_aos_field_updates ON bot_active_aos`);
  await pool.query(
    `CREATE TRIGGER trg_notify_aos_field_updates
      AFTER UPDATE OF charges, jail_minutes, username ON bot_active_aos
     FOR EACH ROW
     EXECUTE FUNCTION notify_aos_field_updates()`
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_bot_active_aos_username
       ON bot_active_aos (LOWER(username))`
  );
}

async function upsertActiveAos(entry, options = {}) {
  const pool = getPool();
  if (!pool) return null;

  const threadId = String(entry?.threadId || '').trim();
  const username = normalizeUsername(entry?.username);
  if (!threadId || !username) return null;

  const postedByBot = options.postedByBot !== undefined
    ? !!options.postedByBot
    : true;

  const createdTimestamp = parseTimestampMs(entry?.createdTimestamp);
  const createdAtIso = createdTimestamp ? new Date(createdTimestamp).toISOString() : null;

  const res = await pool.query(
    `INSERT INTO bot_active_aos (
      thread_id,
      guild_id,
      forum_channel_id,
      thread_name,
      thread_url,
      submitter,
      username,
      profile,
      victims,
      charges,
      summary,
      proof,
      tags,
      calculated_time_minutes,
      jail_minutes,
      posted_by_bot,
      created_at,
      activated_at,
      last_seen_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
    ON CONFLICT (thread_id) DO UPDATE SET
      guild_id = COALESCE(EXCLUDED.guild_id, bot_active_aos.guild_id),
      forum_channel_id = COALESCE(EXCLUDED.forum_channel_id, bot_active_aos.forum_channel_id),
      thread_name = COALESCE(EXCLUDED.thread_name, bot_active_aos.thread_name),
      thread_url = COALESCE(EXCLUDED.thread_url, bot_active_aos.thread_url),
      submitter = COALESCE(EXCLUDED.submitter, bot_active_aos.submitter),
      username = COALESCE(NULLIF(EXCLUDED.username, ''), bot_active_aos.username),
      profile = COALESCE(EXCLUDED.profile, bot_active_aos.profile),
      victims = COALESCE(EXCLUDED.victims, bot_active_aos.victims),
      charges = COALESCE(EXCLUDED.charges, bot_active_aos.charges),
      summary = COALESCE(EXCLUDED.summary, bot_active_aos.summary),
      proof = COALESCE(EXCLUDED.proof, bot_active_aos.proof),
      tags = CASE
        WHEN jsonb_typeof(EXCLUDED.tags) = 'array' AND jsonb_array_length(EXCLUDED.tags) > 0 THEN EXCLUDED.tags
        ELSE bot_active_aos.tags
      END,
      calculated_time_minutes = COALESCE(EXCLUDED.calculated_time_minutes, bot_active_aos.calculated_time_minutes),
      jail_minutes = COALESCE(EXCLUDED.jail_minutes, bot_active_aos.jail_minutes),
      posted_by_bot = (bot_active_aos.posted_by_bot OR EXCLUDED.posted_by_bot),
      created_at = COALESCE(bot_active_aos.created_at, EXCLUDED.created_at),
      last_seen_at = NOW()
    RETURNING *`,
    [
      threadId,
      entry?.guildId ? String(entry.guildId) : null,
      entry?.forumChannelId ? String(entry.forumChannelId) : null,
      entry?.threadName ? String(entry.threadName) : null,
      normalizeUrl(entry?.url),
      normalizeText(entry?.submitter),
      username,
      normalizeText(entry?.profile),
      normalizeText(entry?.victims),
      entry?.charges ? String(entry.charges) : null,
      normalizeText(entry?.summary),
      normalizeText(entry?.proof),
      JSON.stringify(normalizeTags(entry?.tags)),
      normalizeInt(entry?.calculatedTimeMinutes),
      normalizeInt(entry?.jailMinutes),
      postedByBot,
      createdAtIso
    ]
  );

  return res.rows[0] || null;
}

async function upsertLegacyFromForumEntries(entries) {
  const pool = getPool();
  if (!pool) return { added: 0, skipped: 0 };

  let added = 0;
  let skipped = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const threadId = String(entry?.threadId || '').trim();
    const username = normalizeUsername(entry?.username);
    if (!threadId || !username) {
      skipped += 1;
      continue;
    }

    try {
      const existing = await pool.query('SELECT thread_id FROM bot_active_aos WHERE thread_id=$1', [threadId]);
      if (existing.rows[0]) {
        // Keep existing posted_by_bot value and refresh metadata.
        await upsertActiveAos(entry, { postedByBot: false });
        skipped += 1;
        continue;
      }

      await upsertActiveAos(entry, { postedByBot: false });
      added += 1;
    } catch (err) {
      console.warn('aosActiveStore: failed to seed legacy entry', threadId, err?.message || err);
      skipped += 1;
    }
  }

  return { added, skipped };
}

async function removeActiveAosByThreadId(threadId) {
  const pool = getPool();
  if (!pool) return null;

  const id = String(threadId || '').trim();
  if (!id) return null;

  const res = await pool.query(
    `DELETE FROM bot_active_aos
     WHERE thread_id=$1
     RETURNING *`,
    [id]
  );

  return res.rows[0] || null;
}

async function removeLegacyAosByThreadId(threadId) {
  const pool = getPool();
  if (!pool) return null;

  const id = String(threadId || '').trim();
  if (!id) return null;

  const res = await pool.query(
    `DELETE FROM bot_active_aos
     WHERE thread_id=$1 AND posted_by_bot=false
     RETURNING *`,
    [id]
  );

  return res.rows[0] || null;
}

async function listActiveAosRows() {
  const pool = getPool();
  if (!pool) return [];

  const res = await pool.query(
    `SELECT
      thread_id,
      guild_id,
      forum_channel_id,
      thread_name,
      thread_url,
      submitter,
      username,
      profile,
      victims,
      charges,
      summary,
      proof,
      tags,
      calculated_time_minutes,
      jail_minutes,
      posted_by_bot,
      created_at,
      activated_at,
      last_seen_at
    FROM bot_active_aos
    ORDER BY LOWER(username) ASC, activated_at DESC`
  );

  return (res.rows || []).map(row => ({
    threadId: row.thread_id,
    guildId: row.guild_id,
    forumChannelId: row.forum_channel_id,
    threadName: row.thread_name,
    url: row.thread_url,
    submitter: row.submitter,
    username: row.username,
    profile: row.profile,
    victims: row.victims,
    charges: row.charges,
    summary: row.summary,
    proof: row.proof,
    tags: Array.isArray(row.tags) ? row.tags : [],
    calculatedTimeMinutes: row.calculated_time_minutes,
    jailMinutes: row.jail_minutes,
    postedByBot: !!row.posted_by_bot,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at
  }));
}

async function listActiveAosRowsByUsername(username) {
  const pool = getPool();
  if (!pool) return [];

  const target = String(username || '').trim().toLowerCase();
  if (!target) return [];

  const res = await pool.query(
    `SELECT
      thread_id,
      guild_id,
      forum_channel_id,
      thread_name,
      thread_url,
      submitter,
      username,
      profile,
      victims,
      charges,
      summary,
      proof,
      tags,
      calculated_time_minutes,
      jail_minutes,
      posted_by_bot,
      created_at,
      activated_at,
      last_seen_at
    FROM bot_active_aos
    WHERE LOWER(username) = LOWER($1)
    ORDER BY activated_at DESC`,
    [target]
  );

  return (res.rows || []).map(row => ({
    threadId: row.thread_id,
    guildId: row.guild_id,
    forumChannelId: row.forum_channel_id,
    threadName: row.thread_name,
    url: row.thread_url,
    submitter: row.submitter,
    username: row.username,
    profile: row.profile,
    victims: row.victims,
    charges: row.charges,
    summary: row.summary,
    proof: row.proof,
    tags: Array.isArray(row.tags) ? row.tags : [],
    calculatedTimeMinutes: row.calculated_time_minutes,
    jailMinutes: row.jail_minutes,
    postedByBot: !!row.posted_by_bot,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at
  }));
}

async function syncActiveAosFromForum(client, options = {}) {
  const pool = getPool();
  if (!pool) return { synced: 0, found: 0, skipped: 0, reason: options.reason || 'unknown' };
  if (!client) return { synced: 0, found: 0, skipped: 0, reason: options.reason || 'unknown' };

  // Lazy import avoids circular dependency at module load time.
  const { listActiveAosEntries } = require('./aosForumLookup');
  const entries = await listActiveAosEntries(client);

  let synced = 0;
  let skipped = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const row = await upsertActiveAos(entry, { postedByBot: false });
      if (row) synced += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
    }
  }

  return {
    synced,
    found: Array.isArray(entries) ? entries.length : 0,
    skipped,
    reason: options.reason || 'unknown'
  };
}

module.exports = {
  init,
  isEnabled: () => enabled,
  upsertActiveAos,
  upsertLegacyFromForumEntries,
  removeActiveAosByThreadId,
  removeLegacyAosByThreadId,
  listActiveAosRows,
  listActiveAosRowsByUsername,
  syncActiveAosFromForum
};
