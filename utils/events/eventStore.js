const { v4: uuidv4 } = require('uuid');
const config = require('../../config');

const DATABASE_URL = process.env.DATABASE_URL || config.DATABASE_URL || '';
let pool = null;
let initPromise = null;

const EVENT_TYPE_KEYS = ['deployments', 'combat_trainings', 'mock_investigations', 'court_martials', 'sting_operations', 'custom'];

function normalizeWeeklyByType(value) {
  const base = {
    deployments: 0,
    combat_trainings: 0,
    mock_investigations: 0,
    court_martials: 0,
    sting_operations: 0,
    custom: 0
  };
  if (!value || typeof value !== 'object') return base;
  for (const key of EVENT_TYPE_KEYS) {
    base[key] = Number(value[key] || 0);
  }
  return base;
}

function requireDb() {
  if (!DATABASE_URL) {
    const err = new Error('events_db_not_configured');
    err.code = 'events_db_not_configured';
    throw err;
  }
}

function getPool() {
  requireDb();
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.on('error', (err) => console.error('[eventStore] Postgres pool error:', err));
  }
  return pool;
}

async function ensureTables() {
  requireDb();
  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool();
      await db.query(
        `CREATE TABLE IF NOT EXISTS bot_events (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          hosts_text TEXT NOT NULL,
          game_link TEXT,
          vc_link TEXT,
          start_at TIMESTAMPTZ,
          is_recurring BOOLEAN NOT NULL DEFAULT false,
          recurring_weekday SMALLINT,
          recurring_time_utc TEXT,
          next_run_at TIMESTAMPTZ,
          last_run_at TIMESTAMPTZ,
          ping_role_id TEXT,
          created_by TEXT,
          created_by_username TEXT,
          status TEXT NOT NULL DEFAULT 'scheduled',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );

      await db.query(
        `CREATE TABLE IF NOT EXISTS bot_live_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          event_id TEXT REFERENCES bot_events(id) ON DELETE SET NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT,
          message_id TEXT,
          ping_message_id TEXT,
          event_title TEXT NOT NULL,
          hosts_text TEXT,
          host_user_id TEXT,
          description TEXT,
          game_link TEXT,
          vc_link TEXT,
          ping_role_id TEXT,
          scheduled_for TIMESTAMPTZ,
          event_type_key TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          auto_end_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'active',
          ended_at TIMESTAMPTZ,
          ended_by TEXT,
          end_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );

      await db.query(
        `CREATE TABLE IF NOT EXISTS bot_event_system_state (
          id INTEGER PRIMARY KEY,
          schedule_channel_id TEXT,
          schedule_message_id TEXT,
          operations_channel_id TEXT,
          operations_message_id TEXT,
          weekly_completed_count INTEGER NOT NULL DEFAULT 0,
          weekly_completed_by_type JSONB NOT NULL DEFAULT '{}'::jsonb,
          last_week_reset_key TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );

      await db.query(`ALTER TABLE bot_live_events ADD COLUMN IF NOT EXISTS event_type_key TEXT`);
  await db.query(`ALTER TABLE bot_live_events ADD COLUMN IF NOT EXISTS ping_message_id TEXT`);
      await db.query(`ALTER TABLE bot_event_system_state ADD COLUMN IF NOT EXISTS weekly_completed_by_type JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await db.query(`ALTER TABLE bot_events ADD COLUMN IF NOT EXISTS created_by_username TEXT`);
      await db.query(`ALTER TABLE bot_events ADD COLUMN IF NOT EXISTS game_link TEXT`);
      await db.query(`ALTER TABLE bot_events ADD COLUMN IF NOT EXISTS vc_link TEXT`);

      await db.query(
        `INSERT INTO bot_event_system_state (id, weekly_completed_count, weekly_completed_by_type)
         VALUES (1, 0, $1::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(normalizeWeeklyByType(null))]
      );

      console.info('[eventStore] ensured event tables exist');
      return true;
    })().catch((err) => {
      console.error('[eventStore] failed to ensure tables:', err);
      throw err;
    });
  }
  return initPromise;
}

function normalizeRoleId(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  return v || null;
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    title: row.title,
    description: row.description || '',
    hostsText: row.hosts_text || '',
    gameLink: row.game_link || '',
    vcLink: row.vc_link || '',
    startAt: row.start_at ? new Date(row.start_at).toISOString() : null,
    isRecurring: !!row.is_recurring,
    recurringWeekday: row.recurring_weekday === null || row.recurring_weekday === undefined ? null : Number(row.recurring_weekday),
    recurringTimeUtc: row.recurring_time_utc || null,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    pingRoleId: row.ping_role_id || null,
    createdBy: row.created_by || null,
    createdByUsername: row.created_by_username || null,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function mapLiveEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    eventId: row.event_id || null,
    guildId: row.guild_id,
    channelId: row.channel_id || null,
    messageId: row.message_id || null,
    pingMessageId: row.ping_message_id || null,
    eventTitle: row.event_title,
    hostsText: row.hosts_text || '',
    hostUserId: row.host_user_id || null,
    description: row.description || '',
    gameLink: row.game_link || '',
    vcLink: row.vc_link || '',
    pingRoleId: row.ping_role_id || null,
    eventTypeKey: row.event_type_key || null,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    autoEndAt: row.auto_end_at ? new Date(row.auto_end_at).toISOString() : null,
    status: row.status,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    endedBy: row.ended_by || null,
    endReason: row.end_reason || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

async function createEvent(input) {
  await ensureTables();
  const db = getPool();
  const id = uuidv4();
  const nowIso = new Date().toISOString();
  const row = await db.query(
    `INSERT INTO bot_events (
      id, guild_id, title, description, hosts_text, game_link, vc_link, start_at, is_recurring,
      recurring_weekday, recurring_time_utc, next_run_at, last_run_at, ping_role_id,
      created_by, created_by_username, status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,
    [
      id,
      String(input.guildId),
      String(input.title || '').trim(),
      String(input.description || '').trim(),
      String(input.hostsText || '').trim(),
      String(input.gameLink || '').trim(),
      String(input.vcLink || '').trim(),
      input.startAt ? new Date(input.startAt).toISOString() : null,
      !!input.isRecurring,
      input.recurringWeekday === undefined || input.recurringWeekday === null ? null : Number(input.recurringWeekday),
      input.recurringTimeUtc ? String(input.recurringTimeUtc).trim() : null,
      input.nextRunAt ? new Date(input.nextRunAt).toISOString() : null,
      input.lastRunAt ? new Date(input.lastRunAt).toISOString() : null,
      normalizeRoleId(input.pingRoleId),
      input.createdBy ? String(input.createdBy) : null,
      input.createdByUsername ? String(input.createdByUsername).trim() : null,
      input.status ? String(input.status) : 'scheduled',
      nowIso,
      nowIso
    ]
  );
  return mapEvent(row.rows[0]);
}

async function updateEvent(id, updates) {
  await ensureTables();
  const db = getPool();
  const fields = [];
  const values = [];
  let idx = 1;

  function push(col, value) {
    fields.push(`${col} = $${idx++}`);
    values.push(value);
  }

  if (updates.title !== undefined) push('title', String(updates.title || '').trim());
  if (updates.description !== undefined) push('description', String(updates.description || '').trim());
  if (updates.hostsText !== undefined) push('hosts_text', String(updates.hostsText || '').trim());
  if (updates.gameLink !== undefined) push('game_link', String(updates.gameLink || '').trim());
  if (updates.vcLink !== undefined) push('vc_link', String(updates.vcLink || '').trim());
  if (updates.startAt !== undefined) push('start_at', updates.startAt ? new Date(updates.startAt).toISOString() : null);
  if (updates.isRecurring !== undefined) push('is_recurring', !!updates.isRecurring);
  if (updates.recurringWeekday !== undefined) push('recurring_weekday', updates.recurringWeekday === null ? null : Number(updates.recurringWeekday));
  if (updates.recurringTimeUtc !== undefined) push('recurring_time_utc', updates.recurringTimeUtc ? String(updates.recurringTimeUtc).trim() : null);
  if (updates.nextRunAt !== undefined) push('next_run_at', updates.nextRunAt ? new Date(updates.nextRunAt).toISOString() : null);
  if (updates.lastRunAt !== undefined) push('last_run_at', updates.lastRunAt ? new Date(updates.lastRunAt).toISOString() : null);
  if (updates.pingRoleId !== undefined) push('ping_role_id', normalizeRoleId(updates.pingRoleId));
  if (updates.createdByUsername !== undefined) push('created_by_username', updates.createdByUsername ? String(updates.createdByUsername).trim() : null);
  if (updates.status !== undefined) push('status', String(updates.status));

  push('updated_at', new Date().toISOString());

  if (fields.length === 0) {
    return getEventById(id);
  }

  values.push(String(id));
  const res = await db.query(
    `UPDATE bot_events SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return mapEvent(res.rows[0] || null);
}

async function getEventById(id) {
  await ensureTables();
  const db = getPool();
  const res = await db.query('SELECT * FROM bot_events WHERE id = $1 LIMIT 1', [String(id)]);
  return mapEvent(res.rows[0] || null);
}

async function removeEvent(id, guildId) {
  await ensureTables();
  const db = getPool();
  const res = await db.query('DELETE FROM bot_events WHERE id = $1 AND guild_id = $2', [String(id), String(guildId)]);
  return res.rowCount > 0;
}

async function removeEventById(id) {
  await ensureTables();
  const db = getPool();
  const res = await db.query('DELETE FROM bot_events WHERE id = $1', [String(id)]);
  return res.rowCount > 0;
}

async function purgeExpiredOneOffEvents(now = new Date(), scheduledGraceMinutes = 5) {
  await ensureTables();
  const db = getPool();
  const nowIso = new Date(now).toISOString();
  const graceMs = Math.max(0, Number(scheduledGraceMinutes) || 0) * 60 * 1000;
  const scheduledCutoffIso = new Date(new Date(now).getTime() - graceMs).toISOString();
  const res = await db.query(
    `DELETE FROM bot_events
     WHERE is_recurring = false
       AND (
         (status <> 'scheduled' AND next_run_at <= $1)
         OR
         (status = 'scheduled' AND next_run_at <= $2)
       )`,
    [nowIso, scheduledCutoffIso]
  );
  return Number(res.rowCount || 0);
}

async function countScheduledEvents(guildId) {
  await ensureTables();
  const db = getPool();
  const res = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM bot_events
     WHERE guild_id = $1
       AND status = 'scheduled'
       AND next_run_at IS NOT NULL
       AND next_run_at > NOW()`,
    [String(guildId)]
  );
  return Number(res.rows[0] && res.rows[0].count ? res.rows[0].count : 0);
}

async function listScheduledEvents(guildId) {
  await ensureTables();
  const db = getPool();
  const res = await db.query(
    `SELECT * FROM bot_events
     WHERE guild_id = $1
       AND status = 'scheduled'
       AND next_run_at IS NOT NULL
       AND next_run_at > NOW()
     ORDER BY next_run_at ASC NULLS LAST, created_at ASC`,
    [String(guildId)]
  );
  return res.rows.map(mapEvent);
}

async function listEventsForScheduling(guildId) {
  await ensureTables();
  const db = getPool();
  const res = await db.query(
    `SELECT * FROM bot_events
     WHERE guild_id = $1 AND status = 'scheduled' AND next_run_at IS NOT NULL`,
    [String(guildId)]
  );
  return res.rows.map(mapEvent);
}

async function createLiveEvent(input) {
  await ensureTables();
  const db = getPool();
  const id = uuidv4();
  const nowIso = new Date().toISOString();
  const res = await db.query(
    `INSERT INTO bot_live_events (
      id, source, event_id, guild_id, channel_id, message_id, ping_message_id, event_title, hosts_text,
      host_user_id, description, game_link, vc_link, ping_role_id, scheduled_for,
      event_type_key, started_at, auto_end_at, status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    RETURNING *`,
    [
      id,
      String(input.source || 'scheduled'),
      input.eventId ? String(input.eventId) : null,
      String(input.guildId),
      input.channelId ? String(input.channelId) : null,
      input.messageId ? String(input.messageId) : null,
      input.pingMessageId ? String(input.pingMessageId) : null,
      String(input.eventTitle || '').trim(),
      String(input.hostsText || '').trim(),
      input.hostUserId ? String(input.hostUserId) : null,
      String(input.description || '').trim(),
      String(input.gameLink || '').trim(),
      String(input.vcLink || '').trim(),
      normalizeRoleId(input.pingRoleId),
      input.scheduledFor ? new Date(input.scheduledFor).toISOString() : null,
      input.eventTypeKey ? String(input.eventTypeKey).trim() : null,
      input.startedAt ? new Date(input.startedAt).toISOString() : nowIso,
      input.autoEndAt ? new Date(input.autoEndAt).toISOString() : null,
      String(input.status || 'active'),
      nowIso,
      nowIso
    ]
  );
  return mapLiveEvent(res.rows[0]);
}

async function updateLiveEvent(id, updates) {
  await ensureTables();
  const db = getPool();
  const fields = [];
  const values = [];
  let idx = 1;

  function push(col, value) {
    fields.push(`${col} = $${idx++}`);
    values.push(value);
  }

  if (updates.channelId !== undefined) push('channel_id', updates.channelId ? String(updates.channelId) : null);
  if (updates.messageId !== undefined) push('message_id', updates.messageId ? String(updates.messageId) : null);
  if (updates.pingMessageId !== undefined) push('ping_message_id', updates.pingMessageId ? String(updates.pingMessageId) : null);
  if (updates.description !== undefined) push('description', String(updates.description || '').trim());
  if (updates.gameLink !== undefined) push('game_link', String(updates.gameLink || '').trim());
  if (updates.vcLink !== undefined) push('vc_link', String(updates.vcLink || '').trim());
  if (updates.status !== undefined) push('status', String(updates.status));
  if (updates.endedAt !== undefined) push('ended_at', updates.endedAt ? new Date(updates.endedAt).toISOString() : null);
  if (updates.endedBy !== undefined) push('ended_by', updates.endedBy ? String(updates.endedBy) : null);
  if (updates.endReason !== undefined) push('end_reason', updates.endReason ? String(updates.endReason) : null);

  push('updated_at', new Date().toISOString());

  values.push(String(id));
  const res = await db.query(
    `UPDATE bot_live_events SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return mapLiveEvent(res.rows[0] || null);
}

async function getLiveEventById(id) {
  await ensureTables();
  const db = getPool();
  const res = await db.query('SELECT * FROM bot_live_events WHERE id = $1 LIMIT 1', [String(id)]);
  return mapLiveEvent(res.rows[0] || null);
}

async function getLiveEventByMessage(channelId, messageId) {
  await ensureTables();
  const db = getPool();
  const res = await db.query(
    'SELECT * FROM bot_live_events WHERE channel_id = $1 AND message_id = $2 LIMIT 1',
    [String(channelId), String(messageId)]
  );
  return mapLiveEvent(res.rows[0] || null);
}

async function listDueAutoEndLiveEvents(now = new Date()) {
  await ensureTables();
  const db = getPool();
  const res = await db.query(
    `SELECT * FROM bot_live_events
     WHERE status = 'active' AND auto_end_at IS NOT NULL AND auto_end_at <= $1`,
    [new Date(now).toISOString()]
  );
  return res.rows.map(mapLiveEvent);
}

async function getSystemState() {
  await ensureTables();
  const db = getPool();
  const res = await db.query('SELECT * FROM bot_event_system_state WHERE id = 1 LIMIT 1');
  const row = res.rows[0] || null;
  if (!row) return null;
  let weeklyByType = null;
  if (row.weekly_completed_by_type && typeof row.weekly_completed_by_type === 'object') {
    weeklyByType = row.weekly_completed_by_type;
  } else if (typeof row.weekly_completed_by_type === 'string') {
    try { weeklyByType = JSON.parse(row.weekly_completed_by_type); } catch (e) {}
  }
  return {
    id: 1,
    scheduleChannelId: row.schedule_channel_id || null,
    scheduleMessageId: row.schedule_message_id || null,
    operationsChannelId: row.operations_channel_id || null,
    operationsMessageId: row.operations_message_id || null,
    weeklyCompletedCount: Number(row.weekly_completed_count || 0),
    weeklyCompletedByType: normalizeWeeklyByType(weeklyByType),
    lastWeekResetKey: row.last_week_reset_key || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

async function upsertSystemState(patch) {
  await ensureTables();
  const current = await getSystemState();
  const next = {
    scheduleChannelId: patch.scheduleChannelId !== undefined ? patch.scheduleChannelId : (current ? current.scheduleChannelId : null),
    scheduleMessageId: patch.scheduleMessageId !== undefined ? patch.scheduleMessageId : (current ? current.scheduleMessageId : null),
    operationsChannelId: patch.operationsChannelId !== undefined ? patch.operationsChannelId : (current ? current.operationsChannelId : null),
    operationsMessageId: patch.operationsMessageId !== undefined ? patch.operationsMessageId : (current ? current.operationsMessageId : null),
    weeklyCompletedCount: patch.weeklyCompletedCount !== undefined ? Number(patch.weeklyCompletedCount || 0) : (current ? current.weeklyCompletedCount : 0),
    weeklyCompletedByType: patch.weeklyCompletedByType !== undefined
      ? normalizeWeeklyByType(patch.weeklyCompletedByType)
      : normalizeWeeklyByType(current ? current.weeklyCompletedByType : null),
    lastWeekResetKey: patch.lastWeekResetKey !== undefined ? patch.lastWeekResetKey : (current ? current.lastWeekResetKey : null)
  };

  const db = getPool();
  await db.query(
    `INSERT INTO bot_event_system_state (
      id, schedule_channel_id, schedule_message_id, operations_channel_id,
      operations_message_id, weekly_completed_count, weekly_completed_by_type, last_week_reset_key, updated_at
    ) VALUES (1,$1,$2,$3,$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT (id) DO UPDATE SET
      schedule_channel_id = EXCLUDED.schedule_channel_id,
      schedule_message_id = EXCLUDED.schedule_message_id,
      operations_channel_id = EXCLUDED.operations_channel_id,
      operations_message_id = EXCLUDED.operations_message_id,
      weekly_completed_count = EXCLUDED.weekly_completed_count,
      weekly_completed_by_type = EXCLUDED.weekly_completed_by_type,
      last_week_reset_key = EXCLUDED.last_week_reset_key,
      updated_at = EXCLUDED.updated_at`,
    [
      next.scheduleChannelId,
      next.scheduleMessageId,
      next.operationsChannelId,
      next.operationsMessageId,
      next.weeklyCompletedCount,
      JSON.stringify(next.weeklyCompletedByType),
      next.lastWeekResetKey,
      new Date().toISOString()
    ]
  );

  return getSystemState();
}

async function incrementWeeklyCounter(eventTypeKey) {
  await ensureTables();
  const state = await getSystemState();
  const nextCount = Number((state && state.weeklyCompletedCount) || 0) + 1;
  const key = EVENT_TYPE_KEYS.includes(eventTypeKey) ? eventTypeKey : 'custom';
  const byType = normalizeWeeklyByType(state ? state.weeklyCompletedByType : null);
  byType[key] = Number(byType[key] || 0) + 1;
  return upsertSystemState({ weeklyCompletedCount: nextCount, weeklyCompletedByType: byType });
}

module.exports = {
  ensureTables,
  createEvent,
  updateEvent,
  getEventById,
  removeEvent,
  removeEventById,
  purgeExpiredOneOffEvents,
  countScheduledEvents,
  listScheduledEvents,
  listEventsForScheduling,
  createLiveEvent,
  updateLiveEvent,
  getLiveEventById,
  getLiveEventByMessage,
  listDueAutoEndLiveEvents,
  getSystemState,
  upsertSystemState,
  incrementWeeklyCounter
};
