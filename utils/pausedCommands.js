const { pool } = require('./db/db');

async function isPaused(commandName) {
  if (!commandName) return false;
  const res = await pool.query('SELECT paused FROM bot_paused_commands WHERE command_name = $1', [commandName]);
  if (!res.rows[0]) return false;
  return !!res.rows[0].paused;
}

async function setPaused(commandName, paused) {
  await pool.query(
    `INSERT INTO bot_paused_commands (command_name, paused, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (command_name) DO UPDATE SET paused = EXCLUDED.paused, updated_at = EXCLUDED.updated_at`,
    [commandName, !!paused]
  );
  return { command: commandName, paused: !!paused };
}

async function listPaused() {
  const res = await pool.query('SELECT command_name, paused FROM bot_paused_commands');
  return res.rows || [];
}

module.exports = { isPaused, setPaused, listPaused };
