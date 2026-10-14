const { pool } = require('../db');

// Persistence for the AI assistant: staff correction notes, query log (for
// feedback + cost tracking) and a small key/value cache (image descriptions,
// wiki edit dates, wiki exclusions). Every function degrades to a no-op when
// DATABASE_URL is not configured so the bot can still run locally.

let schemaPromise = null;

function hasDb() {
  return !!process.env.DATABASE_URL;
}

async function ensureSchema() {
  if (!hasDb()) return false;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ai_notes (
          id SERIAL PRIMARY KEY,
          text TEXT NOT NULL,
          author_id TEXT,
          author_tag TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ai_queries (
          id SERIAL PRIMARY KEY,
          user_id TEXT,
          user_tag TEXT,
          guild_id TEXT,
          channel_id TEXT,
          message_url TEXT,
          source TEXT,
          question TEXT,
          answer TEXT,
          input_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          latency_ms INTEGER,
          reported BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ai_kb_cache (
          key TEXT PRIMARY KEY,
          value JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`
      );
      return true;
    })().catch(err => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// --- Correction notes ---

async function listNotes() {
  if (!(await ensureSchema())) return [];
  const res = await pool.query('SELECT id, text, author_tag, created_at FROM ai_notes ORDER BY id ASC');
  return res.rows;
}

async function addNote(text, authorId, authorTag) {
  if (!(await ensureSchema())) throw new Error('Database not configured');
  const res = await pool.query(
    'INSERT INTO ai_notes (text, author_id, author_tag) VALUES ($1, $2, $3) RETURNING id',
    [text, authorId, authorTag]
  );
  return res.rows[0].id;
}

async function removeNote(id) {
  if (!(await ensureSchema())) return false;
  const res = await pool.query('DELETE FROM ai_notes WHERE id = $1', [id]);
  return res.rowCount > 0;
}

// --- Query log ---

async function logQuery(q) {
  if (!(await ensureSchema())) return null;
  const res = await pool.query(
    `INSERT INTO ai_queries (user_id, user_tag, guild_id, channel_id, message_url, source, question, answer,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [q.userId, q.userTag, q.guildId, q.channelId, q.messageUrl || null, q.source, q.question, q.answer,
      q.usage.input_tokens || 0, q.usage.cache_read_input_tokens || 0, q.usage.cache_creation_input_tokens || 0,
      q.usage.output_tokens || 0, q.latencyMs || null]
  );
  return res.rows[0].id;
}

async function setQueryMessageUrl(id, url) {
  if (!id || !(await ensureSchema())) return;
  await pool.query('UPDATE ai_queries SET message_url = $1 WHERE id = $2', [url, id]);
}

async function getQuery(id) {
  if (!(await ensureSchema())) return null;
  const res = await pool.query('SELECT * FROM ai_queries WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Marks a query as reported; returns false if it was already reported.
async function markReported(id) {
  if (!(await ensureSchema())) return false;
  const res = await pool.query('UPDATE ai_queries SET reported = true WHERE id = $1 AND reported = false', [id]);
  return res.rowCount > 0;
}

// A user's latest questions/answers in a channel, oldest first. Used as short-term memory for follow-ups.
async function recentExchanges(userId, channelId, minutes, limit) {
  if (!(await ensureSchema())) return [];
  const res = await pool.query(
    `SELECT question, answer, message_url FROM ai_queries
     WHERE user_id = $1 AND channel_id = $2 AND created_at > NOW() - ($3 || ' minutes')::interval
     ORDER BY id DESC LIMIT $4`,
    [userId, channelId, String(minutes), limit]
  );
  return res.rows.reverse();
}

async function usageSince(interval) {
  if (!(await ensureSchema())) return null;
  const res = await pool.query(
    `SELECT COUNT(*)::int AS queries,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(cache_read_tokens),0)::bigint AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens),0)::bigint AS cache_write_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(CASE WHEN reported THEN 1 ELSE 0 END),0)::int AS reported
     FROM ai_queries WHERE created_at > NOW() - $1::interval`,
    [interval]
  );
  return res.rows[0];
}

// --- Key/value cache ---

async function cacheGet(key) {
  if (!(await ensureSchema())) return null;
  const res = await pool.query('SELECT value FROM ai_kb_cache WHERE key = $1', [key]);
  return res.rows[0] ? res.rows[0].value : null;
}

async function cacheSet(key, value) {
  if (!(await ensureSchema())) return;
  await pool.query(
    `INSERT INTO ai_kb_cache (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

module.exports = {
  hasDb,
  ensureSchema,
  listNotes,
  addNote,
  removeNote,
  logQuery,
  setQueryMessageUrl,
  getQuery,
  markReported,
  recentExchanges,
  usageSince,
  cacheGet,
  cacheSet
};
