const { pool } = require('../db/db');

async function init() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_inactivity (
      roblox_username TEXT PRIMARY KEY,
      discord_id TEXT,
      end_date TIMESTAMPTZ
    )`
  );
}

init().catch(err => console.error('Failed to init bot_inactivity table:', err));

async function addEntry(robloxUsername, discordId, endDate) {
  // endDate should be a JS Date or null
  const q = `INSERT INTO bot_inactivity (roblox_username, discord_id, end_date)
    VALUES ($1, $2, $3)
    ON CONFLICT (roblox_username) DO UPDATE SET discord_id = EXCLUDED.discord_id, end_date = EXCLUDED.end_date`;
  await pool.query(q, [robloxUsername, discordId, endDate]);
}

async function removeEntry(robloxUsername) {
  await pool.query(`DELETE FROM bot_inactivity WHERE roblox_username = $1`, [robloxUsername]);
}

async function getExpired(now = new Date()) {
  const res = await pool.query(`SELECT roblox_username, discord_id, end_date FROM bot_inactivity WHERE end_date <= $1`, [now]);
  return res.rows || [];
}

async function getActiveRobloxUsernames() {
  const res = await pool.query(`SELECT roblox_username FROM bot_inactivity`);
  return (res.rows || []).map(r => r.roblox_username);
}

async function getAll() {
  const res = await pool.query(`SELECT roblox_username, discord_id, end_date FROM bot_inactivity`);
  return res.rows || [];
}

module.exports = { addEntry, removeEntry, getExpired, getActiveRobloxUsernames, getAll };
