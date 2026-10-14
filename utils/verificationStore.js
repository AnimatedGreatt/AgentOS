const axios = require('axios');
const { pool } = require('./db');

async function init() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_verifications (
      roblox_username TEXT PRIMARY KEY,
      roblox_userid TEXT UNIQUE,
      discord_id TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_verification_challenges (
      roblox_username TEXT,
      roblox_userid TEXT,
      discord_id TEXT,
      code TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (roblox_username, discord_id)
    )`
  );
}

// Note: table initialization is intentionally not run at require-time here.
// Call `init()` from app startup when a real DATABASE_URL is configured.

// Link (or re-link) a Discord account to a Roblox account. Callers must have already proven
// ownership of the Roblox account (OAuth or profile code), so any older binding that conflicts
// with this one is replaced: the Discord account's previous link, a stale username row for the
// same Roblox user id (e.g. after a Roblox username change), or another row holding this username.
async function addVerification(robloxUsername, robloxUserId, discordId) {
  const username = String(robloxUsername).toLowerCase();
  const userId = robloxUserId ? String(robloxUserId) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT roblox_username, roblox_userid, discord_id FROM bot_verifications
       WHERE discord_id = $1 OR roblox_username = $2 OR ($3::text IS NOT NULL AND roblox_userid = $3)`,
      [discordId, username, userId]
    );
    for (const row of existing.rows) {
      if (row.discord_id !== discordId) {
        console.warn('Verification: replacing binding held by another Discord account', { replaced: row, discordId, username, userId });
      }
    }
    await client.query(
      `DELETE FROM bot_verifications
       WHERE discord_id = $1 OR roblox_username = $2 OR ($3::text IS NOT NULL AND roblox_userid = $3)`,
      [discordId, username, userId]
    );
    const res = await client.query(
      `INSERT INTO bot_verifications (roblox_username, roblox_userid, discord_id) VALUES ($1, $2, $3)
       RETURNING roblox_username, roblox_userid, discord_id, created_at`,
      [username, userId, discordId]
    );
    await client.query('COMMIT');
    const previous = existing.rows.find(r => r.discord_id === discordId) || null;
    return { ...res.rows[0], previous_roblox_username: previous ? previous.roblox_username : null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// Fetch the current Roblox username for a stored binding and update the row if the user has
// renamed on Roblox since verifying. Returns the (possibly updated) record; on any lookup
// failure the original record is returned unchanged.
async function refreshUsername(record) {
  if (!record || !record.roblox_userid) return record;
  let currentName = null;
  try {
    const res = await axios.get(`https://users.roblox.com/v1/users/${encodeURIComponent(record.roblox_userid)}`);
    currentName = res.data && res.data.name ? String(res.data.name).toLowerCase() : null;
  } catch (err) {
    console.warn('Verification: failed to fetch current Roblox username', record.roblox_userid, err?.response?.status || err.message || err);
    return record;
  }
  if (!currentName || currentName === String(record.roblox_username).toLowerCase()) return record;
  try {
    const updated = await addVerification(currentName, record.roblox_userid, record.discord_id);
    console.log('Verification: refreshed renamed Roblox account', { discord_id: record.discord_id, from: record.roblox_username, to: currentName });
    return updated;
  } catch (err) {
    console.warn('Verification: failed to store refreshed Roblox username', err);
    return record;
  }
}

async function removeByRoblox(robloxUsername) {
  await pool.query('DELETE FROM bot_verifications WHERE roblox_username = $1', [robloxUsername.toLowerCase()]);
}

async function removeByDiscord(discordId) {
  await pool.query('DELETE FROM bot_verifications WHERE discord_id = $1', [discordId]);
}

async function getByRoblox(robloxUsername) {
  const res = await pool.query('SELECT roblox_username, roblox_userid, discord_id, created_at FROM bot_verifications WHERE roblox_username = $1', [String(robloxUsername).toLowerCase()]);
  return res.rows[0] || null;
}

async function getByDiscord(discordId) {
  const res = await pool.query('SELECT roblox_username, roblox_userid, discord_id, created_at FROM bot_verifications WHERE discord_id = $1', [discordId]);
  return res.rows[0] || null;
}

async function getByRobloxId(robloxUserId) {
  const res = await pool.query('SELECT roblox_username, roblox_userid, discord_id, created_at FROM bot_verifications WHERE roblox_userid = $1', [String(robloxUserId)]);
  return res.rows[0] || null;
}

async function listAllDiscordIds() {
  const res = await pool.query('SELECT discord_id FROM bot_verifications WHERE discord_id IS NOT NULL');
  return res.rows.map(r => r.discord_id);
}

// Challenge helpers for two-step verification
async function createChallenge(robloxUsername, robloxUserId, discordId, code, expiresAt) {
  const q = `INSERT INTO bot_verification_challenges (roblox_username, roblox_userid, discord_id, code, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (roblox_username, discord_id) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, created_at = NOW()`;
  await pool.query(q, [robloxUsername.toLowerCase(), robloxUserId ? String(robloxUserId) : null, discordId, String(code), expiresAt]);
}

async function getChallenge(robloxUsername, discordId) {
  const res = await pool.query('SELECT roblox_username, roblox_userid, discord_id, code, expires_at, created_at FROM bot_verification_challenges WHERE roblox_username = $1 AND discord_id = $2', [String(robloxUsername).toLowerCase(), discordId]);
  return res.rows[0] || null;
}

async function clearChallenge(robloxUsername, discordId) {
  await pool.query('DELETE FROM bot_verification_challenges WHERE roblox_username = $1 AND discord_id = $2', [String(robloxUsername).toLowerCase(), discordId]);
}

// Lookup / clear helpers by the stored one-time code/state value
async function getChallengeByCode(code) {
  const res = await pool.query('SELECT roblox_username, roblox_userid, discord_id, code, expires_at, created_at FROM bot_verification_challenges WHERE code = $1', [String(code)]);
  return res.rows[0] || null;
}

async function clearChallengeByCode(code) {
  await pool.query('DELETE FROM bot_verification_challenges WHERE code = $1', [String(code)]);
}

// Export public API (includes challenge helpers and init)
module.exports = {
  addVerification,
  removeByRoblox,
  removeByDiscord,
  getByRoblox,
  getByDiscord,
  getByRobloxId,
  refreshUsername,
  createChallenge,
  getChallenge,
  clearChallenge,
  getChallengeByCode,
  clearChallengeByCode,
  listAllDiscordIds,
  init
};

