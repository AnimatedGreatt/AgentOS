const config = require('../../config');
const eventStore = require('./eventStore');
const eventSystem = require('./eventSystem');

let clientRef = null;
const eventTimers = new Map();
let maintenanceTimer = null;

function clearEventTimer(eventId) {
  const t = eventTimers.get(eventId);
  if (t) {
    clearTimeout(t);
    eventTimers.delete(eventId);
  }
}

function recurringAutoEndMs() {
  const hours = Number(config.EVENT_RECURRING_AUTO_END_HOURS || 4);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

function parseIso(input) {
  if (!input) return null;
  const dt = new Date(input);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt;
}

async function scheduleEventTimer(event) {
  clearEventTimer(event.id);
  const when = parseIso(event.nextRunAt);
  if (!when) return;

  const delay = Math.max(0, when.getTime() - Date.now());
  const timeout = setTimeout(async () => {
    try {
      await fireEvent(event.id);
    } catch (err) {
      console.error('eventScheduler fireEvent failed:', err);
    }
  }, delay);

  eventTimers.set(event.id, timeout);
}

async function fireEvent(eventId) {
  if (!clientRef) return;
  const event = await eventStore.getEventById(eventId);
  if (!event) return;
  if (event.status !== 'scheduled') {
    clearEventTimer(event.id);
    return;
  }

  const now = new Date();
  const nextRun = parseIso(event.nextRunAt);
  if (!nextRun) return;
  if (nextRun.getTime() - now.getTime() > 15000) {
    await scheduleEventTimer(event);
    return;
  }

  const autoEndAt = event.isRecurring
    ? new Date(now.getTime() + recurringAutoEndMs()).toISOString()
    : null;

  await eventSystem.postLiveEvent(clientRef, {
    source: 'scheduled',
    eventId: event.id,
    guildId: event.guildId,
    eventTitle: event.title,
    hostsText: event.hostsText,
    startedByUserId: event.createdBy || null,
    description: event.description,
    gameLink: event.gameLink || '',
    vcLink: event.vcLink || '',
    eventTypeKey: 'custom',
    pingRoleId: event.pingRoleId || null,
    scheduledFor: event.nextRunAt,
    autoEndAt
  });

  if (event.isRecurring) {
    const upcoming = eventSystem.computeNextWeeklyRunAt(event.recurringWeekday, event.recurringTimeUtc, new Date(now.getTime() + 1000));
    await eventStore.updateEvent(event.id, {
      lastRunAt: event.nextRunAt,
      nextRunAt: upcoming ? upcoming.toISOString() : null,
      status: 'scheduled'
    });
    const updated = await eventStore.getEventById(event.id);
    if (updated) await scheduleEventTimer(updated);
  } else {
    await eventStore.removeEventById(event.id);
    clearEventTimer(event.id);
  }

  await eventSystem.refreshScheduleMessage(clientRef, event.guildId);
}

async function runMaintenanceTick() {
  if (!clientRef) return;
  try {
    await eventSystem.maybeResetWeeklyCounter(clientRef);
  } catch (e) {
    console.error('eventScheduler weekly reset tick failed:', e);
  }

  try {
    const due = await eventStore.listDueAutoEndLiveEvents(new Date());
    for (const live of due) {
      try {
        await eventSystem.endLiveEvent(clientRef, live.id, 'system', 'auto_end_recurring');
      } catch (e) {
        console.error('eventScheduler auto-end failed:', e);
      }
    }
  } catch (e) {
    console.error('eventScheduler auto-end tick failed:', e);
  }

  try {
    await eventStore.purgeExpiredOneOffEvents(
      new Date(),
      Number(config.EVENT_EXPIRED_SCHEDULED_GRACE_MINUTES || 5)
    );
  } catch (e) {
    console.error('eventScheduler expired-event purge failed:', e);
  }
}

async function resyncAll() {
  if (!clientRef) return;
  await eventStore.ensureTables();

  for (const eventId of Array.from(eventTimers.keys())) {
    clearEventTimer(eventId);
  }

  const guildId = String(config.EVENT_GUILD_ID || '').trim();
  if (!guildId) return;

  const events = await eventStore.listEventsForScheduling(guildId);
  for (const event of events) {
    await scheduleEventTimer(event);
  }
}

async function startEventScheduler(client) {
  clientRef = client;
  try {
    await eventStore.ensureTables();
  } catch (err) {
    if (err && err.code === 'events_db_not_configured') {
      console.warn('Event scheduler disabled: DATABASE_URL is not configured.');
      return;
    }
    throw err;
  }

  await resyncAll();
  await runMaintenanceTick();

  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = setInterval(() => {
    runMaintenanceTick().catch((e) => console.error('eventScheduler maintenance error:', e));
  }, 60 * 1000);
}

module.exports = {
  startEventScheduler,
  resyncAll
};
