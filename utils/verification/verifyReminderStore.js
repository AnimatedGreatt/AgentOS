const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config');

const FILE_PATH = path.join(__dirname, '..', '..', 'data', 'verify_reminders.json');
const DATABASE_URL = config.DATABASE_URL || process.env.DATABASE_URL || '';

let pool = null;
let initPromise = null;
let writeLock = Promise.resolve();

async function ensureFile() {
  const dir = path.dirname(FILE_PATH);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.access(FILE_PATH);
  } catch (e) {
    await fsp.writeFile(FILE_PATH, '[]', 'utf8');
  }
}

async function readAllFile() {
  await ensureFile();
  try {
    const raw = await fsp.readFile(FILE_PATH, 'utf8');
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list;
  } catch (e) {
    try { await fsp.writeFile(FILE_PATH, '[]', 'utf8'); } catch (e) {}
    return [];
  }
}

async function writeAllFile(list) {
  const tmp = FILE_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, FILE_PATH);
}

function enqueueWriteFile(list) {
  writeLock = writeLock.then(() => writeAllFile(list)).catch(err => console.warn('verifyReminderStore write failed', err));
  return writeLock;
}

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.on('error', (err) => console.error('[verifyReminderStore] Postgres pool error:', err));
  }
  return pool;
}

async function ensureTable() {
  if (!DATABASE_URL) return false;
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(
        `CREATE TABLE IF NOT EXISTS bot_verify_reminders (
          id TEXT PRIMARY KEY,
          discord_id TEXT,
          guild_id TEXT,
          next_send_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          last_sent_at TIMESTAMPTZ
        )`
      );
      console.info('[verifyReminderStore] ensured bot_verify_reminders table exists');
      return true;
    })().catch(err => {
      console.warn('[verifyReminderStore] failed to init table:', err);
      return false;
    });
  }
  return initPromise;
}

async function addReminder({ discordId, guildId, nextSendAt }) {
  const id = uuidv4();
  if (!DATABASE_URL) {
    const list = await readAllFile();
    const entry = { id, discordId, guildId, nextSendAt: nextSendAt ? new Date(nextSendAt).toISOString() : null, created_at: new Date().toISOString(), last_sent_at: null };
    list.push(entry);
    await enqueueWriteFile(list);
    return entry;
  }
  const ok = await ensureTable();
  if (!ok) throw new Error('db_error');
  const db = getPool();
  await db.query('INSERT INTO bot_verify_reminders (id, discord_id, guild_id, next_send_at) VALUES ($1,$2,$3,$4)', [id, String(discordId), String(guildId), nextSendAt ? new Date(nextSendAt).toISOString() : null]);
  return { id, discordId, guildId, nextSendAt: nextSendAt ? new Date(nextSendAt).toISOString() : null, created_at: new Date().toISOString(), last_sent_at: null };
}

async function removeReminder(discordId, guildId) {
  if (!DATABASE_URL) {
    const list = await readAllFile();
    const idx = list.findIndex(x => x.discordId === String(discordId) && x.guildId === String(guildId));
    if (idx === -1) return false;
    list.splice(idx, 1);
    await enqueueWriteFile(list);
    return true;
  }
  const ok = await ensureTable();
  if (!ok) return false;
  const db = getPool();
  const res = await db.query('DELETE FROM bot_verify_reminders WHERE discord_id=$1 AND guild_id=$2', [String(discordId), String(guildId)]);
  return res.rowCount > 0;
}

async function getReminder(discordId, guildId) {
  if (!DATABASE_URL) {
    const list = await readAllFile();
    return list.find(x => x.discordId === String(discordId) && x.guildId === String(guildId)) || null;
  }
  const ok = await ensureTable();
  if (!ok) return null;
  const db = getPool();
  const res = await db.query('SELECT id, discord_id AS "discordId", guild_id AS "guildId", next_send_at AS "nextSendAt", created_at AS "created_at", last_sent_at AS "last_sent_at" FROM bot_verify_reminders WHERE discord_id=$1 AND guild_id=$2', [String(discordId), String(guildId)]);
  return (res.rows && res.rows[0]) ? res.rows[0] : null;
}

async function listDue(beforeDt) {
  if (!DATABASE_URL) {
    const list = await readAllFile();
    const nowISO = new Date(beforeDt).toISOString();
    return list.filter(x => x.nextSendAt && x.nextSendAt <= nowISO);
  }
  const ok = await ensureTable();
  if (!ok) return [];
  const db = getPool();
  const res = await db.query('SELECT id, discord_id AS "discordId", guild_id AS "guildId", next_send_at AS "nextSendAt", created_at AS "created_at", last_sent_at AS "last_sent_at" FROM bot_verify_reminders WHERE next_send_at IS NOT NULL AND next_send_at <= $1', [new Date(beforeDt).toISOString()]);
  return res.rows || [];
}

async function listByDiscord(discordId) {
  if (!DATABASE_URL) return (await readAllFile()).filter(x => x.discordId === String(discordId));
  const ok = await ensureTable(); if (!ok) return [];
  const db = getPool(); const res = await db.query('SELECT id, discord_id AS "discordId", guild_id AS "guildId", next_send_at AS "nextSendAt", created_at AS "created_at", last_sent_at AS "last_sent_at" FROM bot_verify_reminders WHERE discord_id=$1', [String(discordId)]);
  return res.rows || [];
}

async function setNextSend(id, nextSendAt) {
  if (!DATABASE_URL) {
    const list = await readAllFile();
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) return false;
    list[idx].nextSendAt = nextSendAt ? new Date(nextSendAt).toISOString() : null;
    list[idx].last_sent_at = new Date().toISOString();
    await enqueueWriteFile(list);
    return true;
  }
  const ok = await ensureTable(); if (!ok) return false;
  const db = getPool();
  const res = await db.query('UPDATE bot_verify_reminders SET next_send_at=$1, last_sent_at=NOW() WHERE id=$2 RETURNING *', [nextSendAt ? new Date(nextSendAt).toISOString() : null, id]);
  return (res.rows && res.rows[0]) ? true : false;
}

module.exports = { addReminder, removeReminder, getReminder, listDue, listByDiscord, setNextSend };
