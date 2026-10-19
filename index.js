require("dotenv").config();
const { startKeepAlive } = require("./utils/db/dbKeepAlive");
const verificationStore = require('./utils/verification/verificationStore');
const arrestStore = require('./utils/arrestStore');
const aosActiveStore = require('./utils/aos/aosActiveStore');
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { loadCommands } = require("./utils/loadCommands");
const { handleInteraction } = require("./utils/interactions/handleInteraction");
const { handleTrelloIngest } = require("./utils/trelloMessageIngest");
const { handleMessageCommands } = require("./utils/messageCommands");
const { handleExamDM } = require("./utils/exams/examMessageHandler");
const { handleTimeWebhookMessage } = require("./utils/timeWebhookHandler");
const { startSuspensionScheduler } = require("./utils/trelloSuspensionScheduler");
const { createFormServer } = require("./utils/createFormServer");
const { initXpWatcherDiagnostics, handleXpAuditLogMessage } = require("./utils/xpWatcher");
const { startKnowledgeSync } = require("./utils/ai/knowledgeBase");
const { handleAiMention } = require("./utils/ai/aiDiscord");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  // DM channels aren't cached after a restart; without this, DMs (exam answers) are silently dropped
  partials: [Partials.Channel]
});

const { startInactivityScheduler } = require("./utils/inactivity/inactivityScheduler");
const { startFollowupScheduler } = require("./utils/followups/followupScheduler");
const probationWatcher = require('./utils/probation/probationWatcher');
const verifyReminderScheduler = require('./utils/verification/verifyReminderScheduler');
const { startEventScheduler } = require('./utils/events/eventScheduler');
const config = require('./config');

function buildAosWebUrlForUsername(username) {
  const baseRaw = String(config.EXAM_WEB_BASE_URL || '').trim();
  if (!baseRaw) return null;

  const base = baseRaw.replace(/\/$/, '');
  const path = String(config.AOS_WEB_PATH || '/aos-profile').trim() || '/aos-profile';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const safeUsername = encodeURIComponent(String(username || '').trim());
  return `${base}${normalizedPath}?username=${safeUsername}`;
}

// Replaces the Username/Charges/jail lines in an AoS starter post (format from buildAosBody in commands/aos.js).
// Values are collapsed to one line because the forum parsers read each field from a single line.
function applyAosEditsToStarterContent(content, { username, charges, jailMinutes }) {
  const oneLine = (value) => String(value).split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(', ');
  let next = String(content || '');
  if (username) {
    next = next.replace(/^(\*\*Username:\*\*).*$/m, (_, label) => `${label} ${oneLine(username)}`);
    const webViewUrl = buildAosWebUrlForUsername(username);
    if (webViewUrl) {
      next = next.replace(/\[\*\*View in browser\*\*\]\([^)]*\)/, () => `[**View in browser**](${webViewUrl})`);
    }
  }
  if (charges) {
    next = next.replace(/^(\*\*Charges:\*\*).*$/m, (_, label) => `${label} ${oneLine(charges)}`);
  }
  if (Number.isFinite(jailMinutes) && jailMinutes >= 0) {
    next = next.replace(/Jail\s*time\s*has\s*been\s*set\s*to\s*\d+\s*minutes?/i, `Jail time has been set to ${Math.round(jailMinutes)} minutes`);
  }
  return next.slice(0, 2000);
}

// Start DB keep-alive (if configured)
startKeepAlive();

// Initialize verification tables when a database is configured
if (process.env.DATABASE_URL) {
  verificationStore.init().catch(err => console.error('verificationStore.init failed:', err));
  arrestStore.init().catch(err => console.error('arrestStore.init failed:', err));
  aosActiveStore.init().catch(err => console.error('aosActiveStore.init failed:', err));
} else {
  console.info('DATABASE_URL not set — skipping DB-backed store init.');
}

// Load all commands
loadCommands(client);

// Ready event
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { initXpWatcherDiagnostics(client).catch(() => null); } catch (e) {}
  startSuspensionScheduler();
  // Start inactivity scheduler to DM expired INs and clean DB
  try { startInactivityScheduler(client); } catch (e) { console.error('Failed to start inactivity scheduler:', e); }
  // Start follow-up scheduler to send persisted follow-up messages
  try { startFollowupScheduler(client); } catch (e) { console.error('Failed to start followup scheduler:', e); }
  // Start the form server now that the bot is ready
  const app = createFormServer(client);
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Form submission server listening on port ${PORT}`);
  });
  // Schedule existing exam sessions for expiration handling
  try {
    const examStore = require('./utils/exams/examStore');
    examStore.initExpirationScheduler(client).catch(err => console.error('Failed to initialize exam expiration scheduler:', err));
  } catch (e) {
    console.error('Failed to start exam expiration scheduler:', e);
  }
  // Start DB listener for exam updates (NOTIFY / poll)
  try {
    const db = require('./utils/db/db');
    const examStore = require('./utils/exams/examStore');
    const { finalizeReview } = require('./utils/exams/handleExamGrade');
    db.listenForExamUpdates(async (payload, source) => {
      try {
        // payload expected to be JSON like { sessionId: '...' } or plain session id
        let sessionId = null;
        try { const p = JSON.parse(payload || 'null'); sessionId = p && p.sessionId ? p.sessionId : (typeof payload === 'string' ? payload : null); } catch (e) { sessionId = payload; }
        if (!sessionId) return;
        console.info(`DB exam update received (source=${source}) session=${sessionId}`);
        const sess = await examStore.getSessionById(sessionId);
        if (!sess) return console.warn('DB listener: session not found', sessionId);
        if (sess.status === 'graded' && sess.review && !sess.review.processed) {
          console.info('DB listener: finalizing review for session', sessionId);
          await finalizeReview({ session: sess, client });
        }
      } catch (e) { console.error('Error handling DB exam update:', e); }
    }, {
      pollEnabled: config.EXAM_DB_POLL_ENABLED,
      pollMs: config.EXAM_DB_POLL_MS
    }).catch(err => console.error('Failed to start DB exam update listener:', err));

    db.listenForAosFieldUpdates(async (payload) => {
      let parsed = null;
      try {
        parsed = JSON.parse(payload || '{}');
      } catch (e) {
        return;
      }

      const threadId = String(parsed?.threadId || '').trim();
      if (!threadId) return;

      const oldCharges = parsed?.oldCharges === undefined || parsed?.oldCharges === null
        ? null
        : String(parsed.oldCharges);
      const newCharges = parsed?.newCharges === undefined || parsed?.newCharges === null
        ? null
        : String(parsed.newCharges);
      const oldUsername = parsed?.oldUsername === undefined || parsed?.oldUsername === null
        ? null
        : String(parsed.oldUsername).trim();
      const newUsername = parsed?.newUsername === undefined || parsed?.newUsername === null
        ? String(parsed?.username || '').trim()
        : String(parsed.newUsername).trim();
      const oldJailMinutes = parsed?.oldJailMinutes === undefined || parsed?.oldJailMinutes === null
        ? null
        : Number(parsed.oldJailMinutes);
      const newJailMinutes = parsed?.newJailMinutes === undefined || parsed?.newJailMinutes === null
        ? null
        : Number(parsed.newJailMinutes);

      const chargesChanged = oldCharges !== newCharges;
      const usernameChanged = oldUsername !== newUsername;
      const jailChanged = oldJailMinutes !== newJailMinutes;
      if (!chargesChanged && !jailChanged && !usernameChanged) return;

      const username = String(newUsername || parsed?.username || '').trim();
      const webViewUrl = buildAosWebUrlForUsername(username);
      const changedFields = [
        usernameChanged ? 'username' : null,
        chargesChanged ? 'charges' : null,
        jailChanged ? 'jail time' : null
      ].filter(Boolean).join(', ');

      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread || typeof thread.send !== 'function') return;

      // Rewrite the original post so it reflects the edit (only possible when the bot authored it).
      try {
        const starter = typeof thread.fetchStarterMessage === 'function'
          ? await thread.fetchStarterMessage().catch(() => null)
          : null;
        if (starter && starter.author && starter.author.id === client.user.id) {
          const updatedContent = applyAosEditsToStarterContent(starter.content, {
            username: usernameChanged ? username : null,
            charges: chargesChanged ? newCharges : null,
            jailMinutes: jailChanged ? newJailMinutes : null
          });
          if (updatedContent !== starter.content) {
            await starter.edit({ content: updatedContent });
          }
        }
        if (usernameChanged && username && /^AOS\s*-/i.test(String(thread.name || ''))) {
          await thread.setName(`AOS - ${username}`.slice(0, 100));
        }
      } catch (e) {
        console.warn('AoS update: failed to edit starter message/thread name:', e?.message || e);
      }

      const content = webViewUrl
        ? `⚠️ This AoS has been updated (${changedFields}), view changes on [the dashboard](${webViewUrl})`
        : `⚠️ This AoS has been updated (${changedFields})`;

      await thread.send(content).catch(() => null);
    }).catch(err => console.error('Failed to start AoS update listener:', err));
  } catch (e) { console.debug && console.debug('DB listener not started (no DB configured?)', e.message || e); }
  // Start probation watcher to handle role-change based alerts
  try { probationWatcher.init(client); } catch (e) { console.error('Failed to init probationWatcher:', e); }
  // Start verification reminder scheduler
  try { verifyReminderScheduler.initScheduler(client); } catch (e) { console.error('Failed to init verifyReminderScheduler:', e); }
  // Start events scheduler and weekly maintenance ticks
  try { startEventScheduler(client); } catch (e) { console.error('Failed to init eventScheduler:', e); }
  // Load and periodically refresh the AI assistant's knowledge (Docs, Trello, wiki)
  try { startKnowledgeSync(); } catch (e) { console.error('Failed to start AI knowledge sync:', e); }
});

// Guild member join/leave hooks for verification reminders
client.on('guildMemberAdd', async (member) => {
  try { await verifyReminderScheduler.onGuildMemberAdd(member); } catch (e) { console.error('verifyReminderScheduler onGuildMemberAdd failed', e); }
});
client.on('guildMemberRemove', async (member) => {
  try { await verifyReminderScheduler.onGuildMemberRemove(member); } catch (e) { console.error('verifyReminderScheduler onGuildMemberRemove failed', e); }
});

// Interaction handler
client.on("interactionCreate", async interaction => {
  await handleInteraction(interaction, client);
});

// Message handler for Trello ingestion
client.on("messageCreate", async message => {
  // Handle exam DM answers first
  try { await handleExamDM(message, client); } catch (e) { console.error('Exam DM handler failed:', e); }
  try { await handleXpAuditLogMessage(message, client); } catch (e) { console.error('XP watcher failed:', e); }
  await handleMessageCommands(message, client);
  // Not awaited: answering takes a few seconds and shouldn't delay the handlers below.
  handleAiMention(message, client).catch(e => console.error('AI mention handler failed:', e));
  await handleTrelloIngest(message);
  await handleTimeWebhookMessage(message);
});
// Login to Discord
client.login(process.env.DISCORD_TOKEN);
