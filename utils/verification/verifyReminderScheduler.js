const verifyReminderStore = require('./verifyReminderStore');
const verificationStore = require('./verificationStore');
const config = require('../../config');

// Delay buffer to avoid tight loops
const MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let timers = new Map(); // id -> timeout
let isRunning = false;

function clearTimer(id) {
  if (!id) return;
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function scheduleTimeoutForEntry(entry, client) {
  if (!entry || !entry.id) return;
  // clear existing
  clearTimer(entry.id);
  if (!entry.nextSendAt) return; // waiting for join event to set
  try {
    console.info('[verifyReminderScheduler] scheduling reminder', { id: entry.id, discordId: entry.discordId, guildId: entry.guildId, nextSendAt: entry.nextSendAt });
  } catch (e) { /* ignore logging errors */ }
  const when = new Date(entry.nextSendAt).getTime();
  const now = Date.now();
  const delay = Math.max(1000, when - now);
  const t = setTimeout(async () => {
    timers.delete(entry.id);
    await sendReminderIfDue(entry, client);
  }, delay);
  timers.set(entry.id, t);
}

async function sendReminderIfDue(entry, client) {
  try {
    console.info('[verifyReminderScheduler] sendReminderIfDue start', { id: entry.id, discordId: entry.discordId, guildId: entry.guildId, nextSendAt: entry.nextSendAt });
    // double-check current state: is user verified?
    const verified = await verificationStore.getByDiscord(entry.discordId);
    if (verified) {
      console.info('[verifyReminderScheduler] user already verified, removing reminder', { discordId: entry.discordId, guildId: entry.guildId });
      clearTimer(entry.id);
      await verifyReminderStore.removeReminder(entry.discordId, entry.guildId);
      return;
    }
    // fetch member
    const guild = client.guilds.cache.get(entry.guildId);
    if (!guild) {
      // guild not cached; remove reminder to avoid orphan
      console.warn('[verifyReminderScheduler] guild not cached, removing reminder', { guildId: entry.guildId, discordId: entry.discordId });
      clearTimer(entry.id);
      await verifyReminderStore.removeReminder(entry.discordId, entry.guildId);
      return;
    }
    let member = null;
    try { member = await guild.members.fetch(entry.discordId); } catch (e) { member = null; }
    if (!member) {
      // user not in guild, remove reminder
      console.warn('[verifyReminderScheduler] member not found in guild, removing reminder', { guildId: entry.guildId, discordId: entry.discordId });
      clearTimer(entry.id);
      await verifyReminderStore.removeReminder(entry.discordId, entry.guildId);
      return;
    }
    // if verified now, remove
    const verified2 = await verificationStore.getByDiscord(entry.discordId);
    if (verified2) {
      console.info('[verifyReminderScheduler] user verified after fetch, removing reminder', { discordId: entry.discordId, guildId: entry.guildId });
      clearTimer(entry.id);
      await verifyReminderStore.removeReminder(entry.discordId, entry.guildId);
      return;
    }
    // send DM reminder
    try {
      console.info('[verifyReminderScheduler] attempting to DM user', { discordId: entry.discordId, guildId: entry.guildId });
      const user = await client.users.fetch(entry.discordId);
      const dm = await user.createDM();
      const text = config.VERIFY_REMINDER_MESSAGE || 'You have not yet verified your account with AgentOS. To initiate verification, please run the `/agentos-verify` command with your Roblox username in the server.\n\nVerification is mandatory. Reminders will be sent every 24 hours until you verify.';
      const sent = await dm.send({ content: text });
      console.info('[verifyReminderScheduler] DM sent', { discordId: entry.discordId, guildId: entry.guildId, messageId: sent.id });
    } catch (e) {
      console.warn('[verifyReminderScheduler] failed to DM user', { discordId: entry.discordId, guildId: entry.guildId, error: e && (e.stack || e.message) });
    }
    // schedule next send in 24h
    const next = new Date(Date.now() + DAY_MS).toISOString();
    await verifyReminderStore.setNextSend(entry.id, next);
    // re-schedule
    const updated = await verifyReminderStore.getReminder(entry.discordId, entry.guildId);
    if (updated) scheduleTimeoutForEntry(updated, client);
  } catch (e) {
    console.error('[verifyReminderScheduler] sendReminderIfDue failed', e && (e.stack || e.message));
  }
}

async function initScheduler(client) {
  if (isRunning) return;
  isRunning = true;
  // load all reminders with nextSendAt and schedule
  try {
    const now = new Date();
    const due = await verifyReminderStore.listDue(new Date(Date.now() + 7 * DAY_MS));
    // schedule each
    for (const entry of due) {
      scheduleTimeoutForEntry(entry, client);
    }
  } catch (e) {
    console.error('[verifyReminderScheduler] init failed', e);
  }
}

async function onGuildMemberAdd(member) {
  // when member joins, find pending reminders for this discord and guild
  try {
    const list = await verifyReminderStore.listByDiscord(member.id);
    for (const entry of list) {
      if (entry.guildId !== member.guild.id) continue;
      // if no nextSendAt, set to join + 24h
      if (!entry.nextSendAt) {
        const joinTime = member.joinedTimestamp || Date.now();
        const next = new Date(Math.max(joinTime + DAY_MS, Date.now() + DAY_MS)).toISOString();
        await verifyReminderStore.setNextSend(entry.id, next);
        const updated = await verifyReminderStore.getReminder(member.id, member.guild.id);
        if (updated) scheduleTimeoutForEntry(updated, member.client);
      } else {
        scheduleTimeoutForEntry(entry, member.client);
      }
    }
  } catch (e) {
    console.error('[verifyReminderScheduler] onGuildMemberAdd failed', e);
  }
}

async function onGuildMemberRemove(member) {
  try {
    const list = await verifyReminderStore.listByDiscord(member.id);
    for (const entry of list) {
      if (entry && entry.guildId === member.guild.id) clearTimer(entry.id);
    }
    await verifyReminderStore.removeReminder(member.id, member.guild.id);
  } catch (e) {
    console.error('[verifyReminderScheduler] onGuildMemberRemove failed', e);
  }
}

module.exports = { initScheduler, onGuildMemberAdd, onGuildMemberRemove, scheduleTimeoutForEntry };
