const { pool } = require('./db/db');

async function init() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_update_cooldowns (
      roblox_username TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ
    )`
  );
}

init().catch(err => console.error('Failed to init bot_update_cooldowns table:', err));

async function isCooling(robloxUsername) {
  const res = await pool.query('SELECT expires_at FROM bot_update_cooldowns WHERE roblox_username = $1', [robloxUsername.toLowerCase()]);
  if (!res.rows || !res.rows[0]) return false;
  const expires = res.rows[0].expires_at;
  return new Date(expires) > new Date();
}

async function addCooldown(robloxUsername, expiresAt) {
  await pool.query(
    `INSERT INTO bot_update_cooldowns (roblox_username, expires_at) VALUES ($1, $2)
     ON CONFLICT (roblox_username) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [robloxUsername.toLowerCase(), expiresAt]
  );
}

async function clearExpired() {
  await pool.query('DELETE FROM bot_update_cooldowns WHERE expires_at <= NOW()');
}

module.exports = { isCooling, addCooldown, clearExpired };
