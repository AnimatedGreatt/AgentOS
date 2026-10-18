const { listFollowups, removeFollowup, updateFollowup } = require('./followupStore');

let clientRef = null;
const timers = new Map();
const RETRY_MS = Number(process.env.FOLLOWUP_RETRY_MS || 60 * 60 * 1000); // default 1 hour

function clearTimer(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

async function sendAndCleanup(entry) {
  let sent = false;
  try {
    const ch = await clientRef.channels.fetch(entry.threadId).catch(() => null);
    if (ch && typeof ch.send === 'function') {
        const followupPingRole = config.FOLLOWUP_PING_ROLE_ID;
        const allowed = followupPingRole ? [followupPingRole] : [];
      try {
          if (allowed.length) {
            await ch.send({ content: entry.content, allowedMentions: { roles: allowed } });
          } else {
            await ch.send({ content: entry.content });
          }
        sent = true;
      } catch (e) {
        console.error('followupScheduler: send error for entry', entry.id, e);
      }
    } else {
      console.warn('followupScheduler: channel not found or not sendable for entry', entry.id, entry.threadId);
    }
  } catch (e) {
    console.error('followupScheduler unexpected error for entry', entry.id, e);
  }

  if (sent) {
    try { await removeFollowup(entry.id); } catch (e) { console.error('followupScheduler failed to remove sent entry', entry.id, e); }
    clearTimer(entry.id);
  } else {
    // Don't delete the persisted followup on transient failures. Persist a retry time and reschedule.
    try {
      const next = new Date(Date.now() + RETRY_MS).toISOString();
      await updateFollowup(entry.id, { sendAt: next }).catch(() => null);
      entry.sendAt = next;
      scheduleEntry(entry);
      console.info('followupScheduler: rescheduled entry', entry.id, 'for', next);
    } catch (e) {
      console.error('followupScheduler failed to persist retry for entry', entry.id, e);
      // As a fallback, clear timer to avoid tight retry loop
      clearTimer(entry.id);
    }
  }
}

function scheduleEntry(entry) {
  clearTimer(entry.id);
  const when = new Date(entry.sendAt).getTime();
  const delay = Math.max(0, when - Date.now());
  const t = setTimeout(() => sendAndCleanup(entry), delay);
  timers.set(entry.id, t);
}

async function startFollowupScheduler(client) {
  clientRef = client;
  try {
    const list = await listFollowups();
    for (const entry of list) {
      scheduleEntry(entry);
    }
  } catch (e) {
    console.error('Failed to start followup scheduler:', e);
  }
}

// Expose a function to schedule newly-added followups at runtime
function scheduleFollowup(entry) {
  // If scheduler not started, ignore scheduling - it will be scheduled on startup
  if (!clientRef) return;
  scheduleEntry(entry);
}

module.exports = { startFollowupScheduler, scheduleFollowup };
