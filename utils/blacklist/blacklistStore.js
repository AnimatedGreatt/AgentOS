const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "..", "data", "blacklist.json");
const config = require("../../config");
const DATABASE_URL = config.DATABASE_URL || process.env.DATABASE_URL || "";

console.info("[blacklistStore] storage:", DATABASE_URL ? "postgres (DATABASE_URL set)" : "file (no DATABASE_URL)");

let pool = null;
let initPromise = null;

let writeLock = Promise.resolve();

function normalize(username) {
  return String(username || "").trim().toLowerCase();
}

async function ensureFileStore() {
  const dir = path.dirname(FILE_PATH);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.access(FILE_PATH);
  } catch (err) {
    await fsp.writeFile(FILE_PATH, "[]", "utf8");
  }
}

async function readList() {
  await ensureFileStore();
  try {
    const raw = await fsp.readFile(FILE_PATH, "utf8");
    const list = JSON.parse(raw);
          if (!Array.isArray(list)) return [];
          // convert strings to objects if necessary
          return list.map(item => {
            if (typeof item === 'string') return { username: normalize(item), added_by_name: null, added_by_id: null, added_at: null };
            return {
              username: normalize(item.username || item),
              added_by_name: item.added_by_name || item.added_by || null,
              added_by_id: item.added_by_id || null,
              added_at: item.added_at || null
            };
          });
  } catch (err) {
    console.warn("Failed to read blacklist store, resetting.", err);
    try { await fsp.writeFile(FILE_PATH, "[]", "utf8"); } catch (e) {}
    return [];
  }
}

async function listUsernames() {
  if (!DATABASE_URL) {
    const list = await readList();
    return list.map(item => item.username);
  }
  const ok = await ensureTable();
  if (!ok) return [];
  const db = getPool();
  try {
    const res = await db.query("SELECT username FROM blacklist ORDER BY username ASC");
    return Array.isArray(res.rows) ? res.rows.map(r => String(r.username)) : [];
  } catch (err) {
    console.warn("Failed to list usernames from DB:", err);
    return [];
  }
}

async function doAtomicWrite(list) {
  const tmp = FILE_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), "utf8");
  await fsp.rename(tmp, FILE_PATH);
}

function enqueueWrite(list) {
  writeLock = writeLock
    .then(() => doAtomicWrite(list))
    .catch(err => {
      console.warn("Failed to write blacklist store:", err);
    });
  return writeLock;
}

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require("pg");
    console.info("[blacklistStore] creating Postgres pool");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.on("error", (err) => {
      console.error("[blacklistStore] Postgres pool error:", err);
    });
  }
  return pool;
}

async function ensureTable() {
  if (!DATABASE_URL) return false;
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(
        `CREATE TABLE IF NOT EXISTS blacklist (
          username TEXT PRIMARY KEY,
          added_by_name TEXT,
          added_by_id TEXT,
          added_at TIMESTAMPTZ DEFAULT NOW()
        )`
      );
      // Ensure columns exist for older schemas that only created `username`.
      try {
        await db.query("ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS added_by_name TEXT");
        await db.query("ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS added_by_id TEXT");
        await db.query("ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ DEFAULT NOW()");
      } catch (e) {
        // non-fatal: log and continue
        console.warn("[blacklistStore] failed to ensure blacklist columns:", e.message || e);
      }
      console.info("[blacklistStore] ensured blacklist table exists");
      return true;
    })().catch(err => {
      console.warn("Failed to init blacklist table:", err);
      return false;
    });
  }
  return initPromise;
}

async function hasUsername(username) {
  const norm = normalize(username);
  if (!norm) return false;

  if (!DATABASE_URL) {
    const list = await readList();
    return list.some(item => normalize(item.username) === norm);
  }

  const ok = await ensureTable();
  if (!ok) return false;
  const db = getPool();
  const result = await db.query("SELECT 1 FROM blacklist WHERE username = $1", [norm]);
  return result.rowCount > 0;
}

async function addUsername(username) {
  const norm = normalize(username);
  if (!norm) return { added: false, reason: "empty" };

  if (!DATABASE_URL) {
    const list = await readList();
    if (list.some(item => normalize(item.username) === norm)) return { added: false, reason: "exists" };
    const addedBy = arguments[1];
    const obj = { username: norm, added_by_name: addedBy ? (addedBy.tag || addedBy.username || String(addedBy)) : null, added_by_id: addedBy ? (addedBy.id || null) : null, added_at: new Date().toISOString() };
    list.push(obj);
    await enqueueWrite(list);
    return { added: true };
  }

  const ok = await ensureTable();
  if (!ok) return { added: false, reason: "db_error" };
  const db = getPool();
  const addedBy = arguments[1];
  const addedByName = addedBy ? (addedBy.tag || addedBy.username || String(addedBy)) : null;
  const addedById = addedBy ? (addedBy.id || null) : null;
  const result = await db.query(
    "INSERT INTO blacklist (username, added_by_name, added_by_id, added_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING",
    [norm, addedByName, addedById]
  );
  if (result.rowCount === 0) return { added: false, reason: "exists" };
  return { added: true };
}

async function removeUsername(username) {
  const norm = normalize(username);
  if (!norm) return { removed: false, reason: "empty" };

  if (!DATABASE_URL) {
    const list = await readList();
    const idx = list.findIndex(item => normalize(item.username) === norm);
    if (idx === -1) return { removed: false, reason: "missing" };
    list.splice(idx, 1);
    await enqueueWrite(list);
    return { removed: true };
  }

  const ok = await ensureTable();
  if (!ok) return { removed: false, reason: "db_error" };
  const db = getPool();
  const result = await db.query("DELETE FROM blacklist WHERE username = $1", [norm]);
  if (result.rowCount === 0) return { removed: false, reason: "missing" };
  return { removed: true };
}

// (readList already defined above)

module.exports = {
  hasUsername,
  addUsername,
  removeUsername,
  listUsernames,
  // returns array of objects: { username, added_by_name, added_by_id, added_at }
  listEntries: async function() {
    if (!DATABASE_URL) {
      return await readList();
    }
    const ok = await ensureTable();
    if (!ok) return [];
    const db = getPool();
    try {
      const res = await db.query("SELECT username, added_by_name, added_by_id, added_at FROM blacklist ORDER BY username ASC");
      return Array.isArray(res.rows) ? res.rows.map(r => ({ username: String(r.username), added_by_name: r.added_by_name || null, added_by_id: r.added_by_id || null, added_at: r.added_at ? r.added_at.toISOString() : null })) : [];
    } catch (err) {
      console.warn("Failed to list entries from DB:", err);
      return [];
    }
  }
};
