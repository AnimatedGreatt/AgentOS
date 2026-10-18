const { pool } = require('./db/db');

let schemaEnsured = false;

async function ensureAdminStateSchema() {
  if (schemaEnsured) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_admin_state (
      id INTEGER PRIMARY KEY,
      paused_applications BOOLEAN DEFAULT false,
      debug_mode BOOLEAN DEFAULT false,
      pause_time_logging BOOLEAN DEFAULT false
    )`
  );
  await pool.query(
    `ALTER TABLE bot_admin_state
     ADD COLUMN IF NOT EXISTS pause_time_logging BOOLEAN DEFAULT false`
  );
  await pool.query(
    `INSERT INTO bot_admin_state (id, paused_applications, debug_mode, pause_time_logging)
     VALUES (1, false, false, false) ON CONFLICT (id) DO NOTHING`
  );
  schemaEnsured = true;
}

async function getState() {
  await ensureAdminStateSchema();
  const res = await pool.query('SELECT paused_applications, debug_mode, pause_time_logging FROM bot_admin_state WHERE id = $1', [1]);
  const row = res.rows[0] || {};
  return {
    pausedApplications: !!row.paused_applications,
    debugMode: !!row.debug_mode,
    pauseTimeLogging: !!row.pause_time_logging
  };
}

async function setState(partial) {
  await ensureAdminStateSchema();
  // Fetch current then update only provided fields
  const cur = await getState();
  const paused = typeof partial.pausedApplications === 'boolean' ? partial.pausedApplications : cur.pausedApplications;
  const debug = typeof partial.debugMode === 'boolean' ? partial.debugMode : cur.debugMode;
  const pauseTimeLogging = typeof partial.pauseTimeLogging === 'boolean' ? partial.pauseTimeLogging : cur.pauseTimeLogging;
  const res = await pool.query(
    `UPDATE bot_admin_state SET paused_applications = $1, debug_mode = $2, pause_time_logging = $3 WHERE id = $4 RETURNING paused_applications, debug_mode, pause_time_logging`,
    [paused, debug, pauseTimeLogging, 1]
  );
  const row = res.rows[0];
  return {
    pausedApplications: !!row.paused_applications,
    debugMode: !!row.debug_mode,
    pauseTimeLogging: !!row.pause_time_logging
  };
}

module.exports = { getState, setState };
