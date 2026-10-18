// Simple in-memory store for recent probation webhook events
const pending = new Map(); // key -> { discordId?, robloxUsername, rank, ts }

function _makeKeyByDiscord(id) { return `d:${id}`; }
function _makeKeyByRoblox(name) { return `r:${String(name).toLowerCase()}`; }

function addPending({ discordId, robloxUsername, rank }) {
  const ts = Date.now();
  if (discordId) pending.set(_makeKeyByDiscord(discordId), { discordId, robloxUsername, rank, ts });
  if (robloxUsername) pending.set(_makeKeyByRoblox(robloxUsername), { discordId, robloxUsername, rank, ts });
}

function getByDiscord(discordId) {
  return pending.get(_makeKeyByDiscord(discordId)) || null;
}

function getByRoblox(robloxUsername) {
  return pending.get(_makeKeyByRoblox(robloxUsername)) || null;
}

function removeByDiscord(discordId) {
  pending.delete(_makeKeyByDiscord(discordId));
}

function removeByRoblox(robloxUsername) {
  pending.delete(_makeKeyByRoblox(robloxUsername));
}

// Periodic cleanup of entries older than a configured window (default 5 minutes)
const CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_TTL_MS = (process.env.PROBATION_PENDING_TTL_MINUTES ? Number(process.env.PROBATION_PENDING_TTL_MINUTES) : 5) * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - (v.ts || 0) > DEFAULT_TTL_MS) pending.delete(k);
  }
}, CLEANUP_INTERVAL_MS);

module.exports = { addPending, getByDiscord, getByRoblox, removeByDiscord, removeByRoblox };
