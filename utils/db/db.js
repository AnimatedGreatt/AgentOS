const { Pool } = require('pg');
const config = require('../../config');

const connectionString = process.env.DATABASE_URL || config.DATABASE_URL;
const pool = new Pool({ connectionString });
// Idle pooled connections can error when Postgres restarts or the network drops. Without a
// listener, node-postgres re-emits that as an unhandled 'error' event and the process crashes.
// The pool discards the broken connection and opens a new one on the next query.
pool.on('error', (err) => {
  console.error('Postgres pool: idle connection error (connection discarded):', err && err.message ? err.message : err);
});

async function init() {
  // Create tables if they don't exist and ensure single-row seeds
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_changelog (
      id INTEGER PRIMARY KEY,
      version TEXT,
      additions TEXT,
      notes TEXT,
      updated_at TIMESTAMPTZ
    )`
  );

  await pool.query(
    `INSERT INTO bot_changelog (id, version, additions, notes, updated_at)
     VALUES (1, '', '', '', NOW()) ON CONFLICT (id) DO NOTHING`);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_admin_state (
      id INTEGER PRIMARY KEY,
      paused_applications BOOLEAN DEFAULT false,
      debug_mode BOOLEAN DEFAULT false,
      pause_time_logging BOOLEAN DEFAULT false
    )`
  );

  // Backward-compatible migration for existing databases
  await pool.query(
    `ALTER TABLE bot_admin_state
     ADD COLUMN IF NOT EXISTS pause_time_logging BOOLEAN DEFAULT false`
  );

  await pool.query(
    `INSERT INTO bot_admin_state (id, paused_applications, debug_mode, pause_time_logging)
     VALUES (1, false, false, false) ON CONFLICT (id) DO NOTHING`);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_paused_commands (
      command_name TEXT PRIMARY KEY,
      paused BOOLEAN DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );
  console.info('Ensured bot_paused_commands table exists');

  // Ensure exam session and review tables for exam workflow
  await pool.query(
    `CREATE TABLE IF NOT EXISTS exams_sessions (
      id UUID PRIMARY KEY,
      exam_id TEXT,
      user_id TEXT,
      status TEXT,
      payload JSONB,
      version INTEGER DEFAULT 1,
      dm_channel_id TEXT,
      dm_message_id TEXT,
      review_channel_id TEXT,
      review_message_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS exam_reviews (
      id UUID PRIMARY KEY,
      session_id UUID REFERENCES exams_sessions(id) ON DELETE CASCADE,
      reviewer_id TEXT,
      scores JSONB,
      feedback TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );
  console.info('Ensured exams_sessions and exam_reviews tables exist');
}

// Initialize at require-time only when an explicit DATABASE_URL is provided.
// This prevents deploy scripts (which load command modules) from attempting
// to connect to a database when none is configured locally.
if (process.env.DATABASE_URL) {
  init().catch(err => {
    console.error('Failed to initialize DB schema:', err);
  });
} else {
  console.info('DATABASE_URL not set — skipping DB schema initialization.');
}

module.exports = { pool };

/**
 * Listen for exam update notifications and optionally poll for unprocessed graded sessions.
 * handler(payload, source) will be invoked with payload string and source ('notification'|'poll').
 */
async function listenForExamUpdates(handler, opts = {}) {
  if (!process.env.DATABASE_URL) {
    console.info('DATABASE_URL not set — skipping listenForExamUpdates');
    return () => {};
  }
  const client = await pool.connect();
  client.on('error', (err) => console.error('Postgres listener client error:', err));
  client.on('notification', async (msg) => {
    try {
      await handler(msg.payload, 'notification');
    } catch (e) {
      console.error('Error handling notification payload:', e);
    }
  });
  await client.query('LISTEN exam_updates');
  console.info('Listening for Postgres NOTIFY on channel: exam_updates');

  // Poll fallback: periodically query only unprocessed graded sessions.
  // Default is intentionally conservative to reduce DB load when NOTIFY is healthy.
  const pollEnabled = opts.pollEnabled !== undefined
    ? !!opts.pollEnabled
    : (config.EXAM_DB_POLL_ENABLED !== undefined ? !!config.EXAM_DB_POLL_ENABLED : true);
  const pollMs = Number.isFinite(Number(opts.pollMs)) && Number(opts.pollMs) > 0
    ? Number(opts.pollMs)
    : (Number.isFinite(Number(config.EXAM_DB_POLL_MS)) && Number(config.EXAM_DB_POLL_MS) > 0 ? Number(config.EXAM_DB_POLL_MS) : 120000);
  const pollBatchSize = Number.isFinite(Number(opts.pollBatchSize)) && Number(opts.pollBatchSize) > 0
    ? Number(opts.pollBatchSize)
    : 25;

  let poller = null;
  let pollInFlight = false;
  if (pollEnabled) {
    poller = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const q = await pool.query(
          "SELECT id::text AS session_id FROM exams_sessions WHERE status='graded' AND (payload->'review'->>'processed') IS DISTINCT FROM 'true' ORDER BY updated_at ASC LIMIT $1",
          [pollBatchSize]
        );
        for (const row of q.rows) {
          try {
            const payload = JSON.stringify({ sessionId: row.session_id });
            await handler(payload, 'poll');
          } catch (e) {
            console.error('Error handling polled graded session:', e);
          }
        }
      } catch (e) {
        console.error('Error polling for graded sessions:', e.message || e);
      } finally {
        pollInFlight = false;
      }
    }, pollMs);
    console.info(`Exam poll fallback enabled: interval=${pollMs}ms batch=${pollBatchSize}`);
  } else {
    console.info('Exam poll fallback disabled; relying on Postgres NOTIFY only.');
  }

  return () => {
    if (poller) clearInterval(poller);
    client.query('UNLISTEN exam_updates').catch(() => null);
    client.release();
  };
}

module.exports.listenForExamUpdates = listenForExamUpdates;

async function listenForAosFieldUpdates(handler) {
  if (!process.env.DATABASE_URL) {
    console.info('DATABASE_URL not set — skipping listenForAosFieldUpdates');
    return () => {};
  }

  // The LISTEN connection is long-lived; if it drops (DB restart, idle timeout, network blip)
  // notifications are silently lost, so reconnect on error and health-check it periodically.
  const healthCheckMs = 60 * 1000;
  let client = null;
  let stopped = false;
  let reconnectTimer = null;
  let healthTimer = null;
  let retryDelayMs = 1000;

  function dropClient(err) {
    if (!client) return;
    const dead = client;
    client = null;
    dead.removeAllListeners('notification');
    try { dead.release(err || true); } catch (e) { /* already released */ }
  }

  function scheduleReconnect(err) {
    dropClient(err);
    if (stopped || reconnectTimer) return;
    console.warn(`AoS listener disconnected; reconnecting in ${retryDelayMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => null);
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 60 * 1000);
  }

  async function connect() {
    if (stopped) return;
    let next = null;
    try {
      next = await pool.connect();
      next.on('error', (err) => {
        console.error('Postgres AoS listener client error:', err && err.message ? err.message : err);
        if (client === next) scheduleReconnect(err);
      });
      next.on('notification', async (msg) => {
        if (!msg || msg.channel !== 'aos_field_updates') return;
        try {
          await handler(msg.payload || '');
        } catch (e) {
          console.error('Error handling aos_field_updates payload:', e);
        }
      });
      await next.query('LISTEN aos_field_updates');
      client = next;
      retryDelayMs = 1000;
      console.info('Listening for Postgres NOTIFY on channel: aos_field_updates');
    } catch (err) {
      console.error('Failed to LISTEN on aos_field_updates:', err && err.message ? err.message : err);
      if (next) { try { next.release(err); } catch (e) { /* ignore */ } }
      scheduleReconnect(err);
      throw err;
    }
  }

  // A failed first attempt has already scheduled a retry, so keep the health check running regardless.
  await connect().catch(() => null);

  healthTimer = setInterval(() => {
    if (!client) return;
    const current = client;
    current.query('SELECT 1').catch((err) => {
      if (client === current) scheduleReconnect(err);
    });
  }, healthCheckMs);

  return () => {
    stopped = true;
    if (healthTimer) clearInterval(healthTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (client) {
      const current = client;
      client = null;
      current.query('UNLISTEN aos_field_updates').catch(() => null).finally(() => current.release());
    }
  };
}

module.exports.listenForAosFieldUpdates = listenForAosFieldUpdates;
