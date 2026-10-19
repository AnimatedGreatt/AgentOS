function cleanId(v) {
  if (v === undefined || v === null) return v;
  return String(v).trim().replace(/^\$+/, '');
}

module.exports = {
  // Staging-safe application identity and guild targeting
  APPLICATION_ID: cleanId(process.env.APPLICATION_ID) || cleanId(process.env.DISCORD_APPLICATION_ID) || undefined,
  // Defaults to the OSI server so guild-locked commands (/submit, /anonymous-log) stay locked in production.
  GUILD_ID: cleanId(process.env.GUILD_ID) || "1041577710067138560",
  // Role allowed to approve cases
  REQUIRED_ROLE_ID: cleanId(process.env.REQUIRED_ROLE_ID) || "1449861438012133566,1106739929540730921",
  // Channel where approved cases are posted
  TARGET_CHANNEL_ID: cleanId(process.env.TARGET_CHANNEL_ID) || "1449832209316839455",
  // Role to ping when posting approved cases
  PING_ROLE_ID: cleanId(process.env.PING_ROLE_ID) || "1041577710067138561",
  // Channel for anonymous log submissions; defaults to a production channel but can be overridden for staging.
  ANONYMOUS_LOG_CHANNEL_ID: cleanId(process.env.ANONYMOUS_LOG_CHANNEL_ID) || "1449830431171149885",
  // Role to ping when a scheduled follow-up fires (dedicated; optional)
  FOLLOWUP_PING_ROLE_ID: cleanId(process.env.FOLLOWUP_PING_ROLE_ID) || "1449861438012133566",

  VOTING_CHANNEL_ID: process.env.VOTING_CHANNEL_ID || "1467678462302093334",
  RESULT_CHANNEL_ID: process.env.RESULT_CHANNEL_ID || "1320064034963325068",
  // Application anti-spam tuning for form submissions
  APPLICATION_SPAM_MIN_TOTAL_CHARS: process.env.APPLICATION_SPAM_MIN_TOTAL_CHARS !== undefined ? Number(process.env.APPLICATION_SPAM_MIN_TOTAL_CHARS) : 48,
  APPLICATION_SPAM_MIN_LONG_ANSWER_CHARS: process.env.APPLICATION_SPAM_MIN_LONG_ANSWER_CHARS !== undefined ? Number(process.env.APPLICATION_SPAM_MIN_LONG_ANSWER_CHARS) : 8,
  APPLICATION_SPAM_MIN_LONG_ANSWER_COUNT: process.env.APPLICATION_SPAM_MIN_LONG_ANSWER_COUNT !== undefined ? Number(process.env.APPLICATION_SPAM_MIN_LONG_ANSWER_COUNT) : 4,
  APPLICATION_SPAM_MAX_SHORT_LONG_RATIO: process.env.APPLICATION_SPAM_MAX_SHORT_LONG_RATIO !== undefined ? Number(process.env.APPLICATION_SPAM_MAX_SHORT_LONG_RATIO) : 0.85,
  APPLICATION_SPAM_DUPLICATE_LONG_ANSWER_THRESHOLD: process.env.APPLICATION_SPAM_DUPLICATE_LONG_ANSWER_THRESHOLD !== undefined ? Number(process.env.APPLICATION_SPAM_DUPLICATE_LONG_ANSWER_THRESHOLD) : 6,
  // Bypass spam heuristics when total answer text length reaches this threshold.
  APPLICATION_SPAM_TRUST_TOTAL_CHARS_BYPASS: process.env.APPLICATION_SPAM_TRUST_TOTAL_CHARS_BYPASS !== undefined ? Number(process.env.APPLICATION_SPAM_TRUST_TOTAL_CHARS_BYPASS) : 1200,
  // Channels to post submissions based on verdict
  SUBMIT_GUILTY_CHANNEL_ID: process.env.SUBMIT_GUILTY_CHANNEL_ID || "1449832030291492925",
  SUBMIT_INNOCENT_CHANNEL_ID: process.env.SUBMIT_INNOCENT_CHANNEL_ID || "1449832086818128025",
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || "1467682055298089131",
  // Channel to notify when a DM to an applicant fails. If unset, code falls back to LOG_CHANNEL_ID then RESULT_CHANNEL_ID.
  DM_FAIL_CHANNEL_ID: process.env.DM_FAIL_CHANNEL_ID || "1041577711845519384",
  // Channel ID to create one-time invites in (falls back to the voting channel)
  INVITE_CHANNEL_ID: process.env.INVITE_CHANNEL_ID || "1041577710960513043",

  // Guild ID allowed to use blacklist view commands
  BLACKLIST_GUILD_ID: process.env.BLACKLIST_GUILD_ID || "1041577710067138560",

  // Event hosting system configuration
  EVENT_GUILD_ID: cleanId(process.env.EVENT_GUILD_ID) || "1041577710067138560",
  EVENT_SCHEDULE_CHANNEL_ID: cleanId(process.env.EVENT_SCHEDULE_CHANNEL_ID) || "1507477905951690854",
  EVENT_OPERATIONS_CHANNEL_ID: cleanId(process.env.EVENT_OPERATIONS_CHANNEL_ID) || "1490285605085515896",
  EVENT_PANEL_URL: process.env.EVENT_PANEL_URL || "https://agent-os.team/event-panel",
  EVENT_CREATOR_ROLE_IDS: process.env.EVENT_CREATOR_ROLE_IDS || "1449861438012133566,1515073280883687475",
  EVENT_HOST_ROLE_IDS: process.env.EVENT_HOST_ROLE_IDS || "1449861438012133566,1515073017804361728",
  // Optional: role IDs that can host only Court Martial preset events.
  EVENT_COURT_MARTIAL_HOST_ROLE_IDS: process.env.EVENT_COURT_MARTIAL_HOST_ROLE_IDS || "1515073280883687475",
  // Optional JSON map of preset key -> comma-separated or array role IDs.
  // Example:
  // {"court_martials":"123,456","deployments":["789"]}
  EVENT_PRESET_HOST_ROLE_IDS: process.env.EVENT_PRESET_HOST_ROLE_IDS || "",
  EVENT_DEFAULT_PING_ROLE_ID: cleanId(process.env.EVENT_DEFAULT_PING_ROLE_ID) || "1041577710067138561",
  // When admin debug mode is enabled, skip event ping messages for events started by this user ID.
  EVENT_DEBUG_NO_PING_USER_ID: cleanId(process.env.EVENT_DEBUG_NO_PING_USER_ID) || "716248402513494027",
  EVENT_TIMEZONE: process.env.EVENT_TIMEZONE || 'UTC',
  EVENT_SCHEDULE_MAX_ENTRIES: process.env.EVENT_SCHEDULE_MAX_ENTRIES !== undefined ? Number(process.env.EVENT_SCHEDULE_MAX_ENTRIES) : 20,
  EVENT_RECURRING_AUTO_END_HOURS: process.env.EVENT_RECURRING_AUTO_END_HOURS !== undefined ? Number(process.env.EVENT_RECURRING_AUTO_END_HOURS) : 4,
  // Grace before purging stale one-off scheduled events that are still marked scheduled but already in the past.
  EVENT_EXPIRED_SCHEDULED_GRACE_MINUTES: process.env.EVENT_EXPIRED_SCHEDULED_GRACE_MINUTES !== undefined ? Number(process.env.EVENT_EXPIRED_SCHEDULED_GRACE_MINUTES) : 5,

  // Trello ingest/watch channel and list for message-to-Trello ingestion
  TRELLO_INGEST_CHANNEL_ID: process.env.TRELLO_INGEST_CHANNEL_ID || "1221224045429915759",
  TRELLO_CREATE_LIST_ID: process.env.TRELLO_CREATE_LIST_ID || "6940345b7ed679287366e82b",

  // Suspensions Trello board id (used by suspension commands)
  TRELLO_SUSPENSIONS_BOARD_ID: process.env.TRELLO_SUSPENSIONS_BOARD_ID || "693f1533319531ec08ae2ff4",

  // Database URL for blacklist roster
  DATABASE_URL: process.env.DATABASE_URL || undefined,
  // Optional: GitHub repo to pull latest commit from (format: owner/repo)
  GITHUB_REPO: process.env.GITHUB_REPO || "legobeerus/AgentOS",
  // Optional: GitHub token to increase API rate limits (optional)
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || undefined,
  
  // Optional: Google Sheets lookup for background checks
  // Set GOOGLE_SHEET_ID and GOOGLE_SHEETS_API_KEY in your environment to enable
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || "11k9MP9Qqt2-2xTWMco_YyAysAPVXG5PN3E7P18clWXc",
  GOOGLE_SHEETS_API_KEY: process.env.GOOGLE_SHEETS_API_KEY || undefined,
  // Range to fetch (e.g. 'Sheet1!A:C'). Defaults to the first 3 columns.
  GOOGLE_SHEETS_RANGE: process.env.GOOGLE_SHEETS_RANGE || 'Blacklists!A4:B1000',

  // Time webhook sheet settings: range to search for usernames and minutes
  TIME_LOG_SHEET_RANGE: process.env.TIME_LOG_SHEET_RANGE || 'Master!A4:M1000',
  // Zero-based indices within the fetched range rows for username and minutes columns
  TIME_LOG_NAME_COL: process.env.TIME_LOG_NAME_COL !== undefined ? Number(process.env.TIME_LOG_NAME_COL) : 0,
  TIME_LOG_MINUTES_COL: process.env.TIME_LOG_MINUTES_COL !== undefined ? Number(process.env.TIME_LOG_MINUTES_COL) : 10,
  // Channel ID for the webhook messages to listen to (set via env)
  TIME_LOG_CHANNEL_ID: process.env.TIME_LOG_CHANNEL_ID || "1484714859592552498",
  // Enable verbose logging for time webhook handler when true (env: TIME_WEBHOOK_VERBOSE=true)
  TIME_WEBHOOK_VERBOSE: (process.env.TIME_WEBHOOK_VERBOSE || '').toLowerCase() === 'true' || process.env.TIME_WEBHOOK_VERBOSE === '1',
  // Optional: zero-based index of the rank column within TIME_LOG_SHEET_RANGE
  TIME_LOG_RANK_COL: process.env.TIME_LOG_RANK_COL !== undefined ? Number(process.env.TIME_LOG_RANK_COL) : 3,
  // Comma-separated list of rank names (case-insensitive) to exclude from quota checks
  GAME_QUOTA_EXCLUDE_RANKS: process.env.GAME_QUOTA_EXCLUDE_RANKS || "Special Agent-in-Training,Director of Investigations,Deputy Director of Investigations,Section Chief,Overseer",
  // Channel to post quota check reports
    GAME_QUOTA_CHANNEL_ID: cleanId(process.env.GAME_QUOTA_CHANNEL_ID) || "1290094295956848700",
    // Zero-based index of pass/fail status column in TIME_LOG_SHEET_RANGE (checkbox/IF TRUE/FALSE/IMMUNE)
    GAME_QUOTA_PASS_COL: process.env.GAME_QUOTA_PASS_COL !== undefined ? Number(process.env.GAME_QUOTA_PASS_COL) : 5,
    // Text marker in pass/fail column that excludes a user from quota and Agent of the Week
    GAME_QUOTA_IMMUNE_TEXT: process.env.GAME_QUOTA_IMMUNE_TEXT || 'IMMUNE',
    GAME_LOG_STRIKE_COL: process.env.GAME_LOG_STRIKE_COL !== undefined ? Number(process.env.GAME_LOG_STRIKE_COL) : 6,
    // Tracking tab for quota strike/pass streak automation
    GAME_QUOTA_TRACKING_RANGE: process.env.GAME_QUOTA_TRACKING_RANGE || 'AgentOS Backend!A3:G1000',
    GAME_QUOTA_TRACKING_USERNAME_COL: process.env.GAME_QUOTA_TRACKING_USERNAME_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_USERNAME_COL) : 0,
    GAME_QUOTA_TRACKING_STRIKES_COL: process.env.GAME_QUOTA_TRACKING_STRIKES_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_STRIKES_COL) : 1,
    GAME_QUOTA_TRACKING_PASS_STREAK_COL: process.env.GAME_QUOTA_TRACKING_PASS_STREAK_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_PASS_STREAK_COL) : 2,
    GAME_QUOTA_TRACKING_LAST_CYCLE_COL: process.env.GAME_QUOTA_TRACKING_LAST_CYCLE_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_LAST_CYCLE_COL) : 3,
    GAME_QUOTA_TRACKING_LAST_OUTCOME_COL: process.env.GAME_QUOTA_TRACKING_LAST_OUTCOME_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_LAST_OUTCOME_COL) : 4,
    GAME_QUOTA_TRACKING_LAST_UPDATED_COL: process.env.GAME_QUOTA_TRACKING_LAST_UPDATED_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_LAST_UPDATED_COL) : 5,
    GAME_QUOTA_TRACKING_NOTES_COL: process.env.GAME_QUOTA_TRACKING_NOTES_COL !== undefined ? Number(process.env.GAME_QUOTA_TRACKING_NOTES_COL) : 6,
    // Complete quota for N weeks in a row to remove one strike
    GAME_QUOTA_PASS_WEEKS_FOR_REMOVAL: process.env.GAME_QUOTA_PASS_WEEKS_FOR_REMOVAL !== undefined ? Number(process.env.GAME_QUOTA_PASS_WEEKS_FOR_REMOVAL) : 2,
    // Probation detection: comma-separated rank names to consider probationary
    PROBATION_RANK_NAMES: process.env.PROBATION_RANK_NAMES || 'Special Agent-in-Training',
    // Comma-separated role IDs that should trigger an alert if a probationary agent has them
    PROBATION_SUSPICIOUS_ROLE_IDS: process.env.PROBATION_SUSPICIOUS_ROLE_IDS || "1487506799400849518",
    // Comma-separated role IDs that are required for probationary agents; alert if missing
    PROBATION_REQUIRED_ROLE_IDS: process.env.PROBATION_REQUIRED_ROLE_IDS || "1449837003188342916",
    // Channel to post probation alerts
    PROBATION_ALERT_CHANNEL_ID: process.env.PROBATION_ALERT_CHANNEL_ID || "1041577711845519384",
    // Optional: a temporary role ID that the bot can add/remove to force a guildMemberUpdate
    PROBATION_TEMP_ROLE_ID: cleanId(process.env.PROBATION_TEMP_ROLE_ID) || '1494728925383757867',
  // Role to ping in quota reports (separate from general PING_ROLE_ID)
  GAME_QUOTA_PING_ROLE_ID: cleanId(process.env.GAME_QUOTA_PING_ROLE_ID) || "1041577710067138561",
  // Channel where inactivity notices are posted for staff review
  INACTIVITY_CHANNEL_ID: process.env.INACTIVITY_CHANNEL_ID || "1107773216140832878",
  // Comma-separated role IDs allowed to approve inactivity notices
  INACTIVITY_APPROVER_ROLE_IDS: process.env.INACTIVITY_APPROVER_ROLE_IDS || "1449861438012133566,1515073280883687475",
  // Zero-based index (within TIME_LOG_SHEET_RANGE) of the column to write the end-date to
  TIME_LOG_ENDDATE_COL: process.env.TIME_LOG_ENDDATE_COL !== undefined ? Number(process.env.TIME_LOG_ENDDATE_COL) : 7,
  // Optional: column index (zero-based) for the running total time column (adjacent to minutes column)
  TIME_LOG_TOTAL_COL: process.env.TIME_LOG_TOTAL_COL !== undefined ? Number(process.env.TIME_LOG_TOTAL_COL) : 11,
  // Column index (zero-based) for the SGC/main-group rank within TIME_LOG_SHEET_RANGE
  TIME_LOG_SGC_RANK_COL: process.env.TIME_LOG_SGC_RANK_COL !== undefined ? Number(process.env.TIME_LOG_SGC_RANK_COL) : 1,
  // Roblox group id for the main SGC group used when fetching ranks
  TIME_SGC_GROUP_ID: process.env.TIME_SGC_GROUP_ID !== undefined ? Number(process.env.TIME_SGC_GROUP_ID) : 6762663,

  // Which columns in the fetched range contain the name and the blacklist type.
  // These are zero-based indices into the returned row array. Adjust if your
  // name and type columns are not adjacent.
  GOOGLE_SHEET_NAME_COL: process.env.GOOGLE_SHEET_NAME_COL !== undefined ? Number(process.env.GOOGLE_SHEET_NAME_COL) : 0,
  GOOGLE_SHEET_TYPE_COL: process.env.GOOGLE_SHEET_TYPE_COL !== undefined ? Number(process.env.GOOGLE_SHEET_TYPE_COL) : 1,

  // Roblox OAuth configuration (optional)
  ROBLOX_OAUTH_CLIENT_ID: process.env.ROBLOX_OAUTH_CLIENT_ID || '1901711581481527983',
  ROBLOX_OAUTH_CLIENT_SECRET: process.env.ROBLOX_OAUTH_CLIENT_SECRET || 'RBX-joNZ_SlvEkO47Gg-Kxn7ZAGA2avnRtcacZlGKOh9-FXfguh5QyhKcYheGsv5Ep-h',
  // Full redirect URI that Roblox will call after authorization (must match app registration)
  ROBLOX_OAUTH_REDIRECT_URI: process.env.ROBLOX_OAUTH_REDIRECT_URI || 'https://agentos-production-cca0.up.railway.app/oauth/roblox/callback',

  // Points column index (zero-based). Username column and sheet range reuse the
  // existing TIME_LOG_* settings to avoid duplicate config.
  POINTS_POINTS_COL: process.env.POINTS_POINTS_COL !== undefined ? Number(process.env.POINTS_POINTS_COL) : 12,

  // Blacklist sheet settings (separate tab). Columns are zero-based indices
  BLACKLIST_SHEET_RANGE: process.env.BLACKLIST_SHEET_RANGE || 'Blacklists!A4:I1000',
  BLACKLIST_NAME_COL: process.env.BLACKLIST_NAME_COL !== undefined ? Number(process.env.BLACKLIST_NAME_COL) : 0,
  BLACKLIST_TYPE_COL: process.env.BLACKLIST_TYPE_COL !== undefined ? Number(process.env.BLACKLIST_TYPE_COL) : 1,
  BLACKLIST_ENDDATE_COL: process.env.BLACKLIST_ENDDATE_COL !== undefined ? Number(process.env.BLACKLIST_ENDDATE_COL) : 2,
  BLACKLIST_REASON_COL: process.env.BLACKLIST_REASON_COL !== undefined ? Number(process.env.BLACKLIST_REASON_COL) : 6,

  // Standard embed color (hex). Can be set via env as number (e.g. 0x5865f2) or decimal.
  EMBED_COLOR: process.env.EMBED_COLOR ? Number(process.env.EMBED_COLOR) : 0x00aff1,

  // Exam workflow configuration
  // Channel where exam authorization requests are posted for staff review/authorization
  EXAM_AUTH_CHANNEL_ID: process.env.EXAM_AUTH_CHANNEL_ID || "1515427287300837518",
  // Channel where completed exams are posted for grading
  EXAM_REVIEW_CHANNEL_ID: process.env.EXAM_REVIEW_CHANNEL_ID || "1503106291013390479",
  // Role ID required to authorize exams (staff reviewer role)
  EXAM_AUTH_ROLE_ID: cleanId(process.env.EXAM_AUTH_ROLE_ID) || "1449861438012133566",
  // Role ID required to *request* an exam (candidate role); optional
  EXAM_CANDIDATE_ROLE_ID: cleanId(process.env.EXAM_CANDIDATE_ROLE_ID) || undefined,
  // Default pass threshold as percent (0-100)
  EXAM_PASS_THRESHOLD: process.env.EXAM_PASS_THRESHOLD !== undefined ? Number(process.env.EXAM_PASS_THRESHOLD) : 75,
  // Default time limit in seconds applied to exams if not specified per-exam
  EXAM_TIME_LIMIT_SECONDS: process.env.EXAM_TIME_LIMIT_SECONDS !== undefined ? Number(process.env.EXAM_TIME_LIMIT_SECONDS) : 86400,
  // Short-lived secret token for web grading endpoints (optional)
  EXAM_REVIEW_SECRET: process.env.EXAM_REVIEW_SECRET || undefined,
  // Guild ID where exam reviewers are members (used for OAuth role verification)
  EXAM_GUILD_ID: cleanId(process.env.EXAM_GUILD_ID) || "1041577710067138560",
  // Public base URL for the web grading UI (e.g. https://grading.example.com)
  EXAM_WEB_BASE_URL: process.env.EXAM_WEB_BASE_URL || "https://agent-os.team",
  // Path on EXAM_WEB_BASE_URL where the AoS section is hosted
  AOS_WEB_PATH: process.env.AOS_WEB_PATH || '/aos-profile',
  // DB exam update poll fallback controls (used with LISTEN/NOTIFY)
  EXAM_DB_POLL_ENABLED: (process.env.EXAM_DB_POLL_ENABLED || '').toLowerCase() === 'true' || process.env.EXAM_DB_POLL_ENABLED === '1',
  // Poll interval in ms for fallback exam update checks (default 2 minutes)
  EXAM_DB_POLL_MS: process.env.EXAM_DB_POLL_MS !== undefined ? Number(process.env.EXAM_DB_POLL_MS) : 120000,

  // Cross-server kick workflow
  // Guild ID where /kick will remove the member from
  KICK_TARGET_GUILD_ID: cleanId(process.env.KICK_TARGET_GUILD_ID) || undefined,
  // Guild ID where /kick will remove configured roles from the same user
  KICK_ROLE_STRIP_GUILD_ID: cleanId(process.env.KICK_ROLE_STRIP_GUILD_ID) || undefined,
  // Channel where /kick action logs are posted
  KICK_LOG_CHANNEL_ID: cleanId(process.env.KICK_LOG_CHANNEL_ID) || "1488617010576490506",
  // Comma-separated role IDs to remove in KICK_ROLE_STRIP_GUILD_ID
  KICK_ROLE_STRIP_ROLE_IDS: process.env.KICK_ROLE_STRIP_ROLE_IDS || "",
  // Optional: comma-separated role IDs allowed to run /kick (empty = fallback to ADMIN_WHITELIST)
  KICK_COMMAND_ALLOWED_ROLE_IDS: process.env.KICK_COMMAND_ALLOWED_ROLE_IDS || "",

  // Website role lookup API configuration
  // Shared API token preferred for web callers (do not expose DISCORD_TOKEN to browsers)
  BOT_API_TOKEN: process.env.BOT_API_TOKEN || undefined,
  // Comma-separated CORS allowlist for web API requests. Empty or '*' allows any origin.
  BOT_API_ALLOWED_ORIGINS: process.env.BOT_API_ALLOWED_ORIGINS || '*',
  // Temporary compatibility mode for legacy clients that pass api_token in query/body.
  BOT_API_ALLOW_LEGACY_QUERY_TOKEN: process.env.BOT_API_ALLOW_LEGACY_QUERY_TOKEN === undefined
    ? true
    : (process.env.BOT_API_ALLOW_LEGACY_QUERY_TOKEN || '').toLowerCase() === 'true' || process.env.BOT_API_ALLOW_LEGACY_QUERY_TOKEN === '1',
  // Optional hard lock: force website role lookups to this guild ID
  BOT_API_ENFORCED_GUILD_ID: cleanId(process.env.BOT_API_ENFORCED_GUILD_ID) || undefined,
  // Optional compatibility mode: allow using DISCORD_TOKEN as API auth (not recommended)
  BOT_API_ALLOW_DISCORD_TOKEN: (process.env.BOT_API_ALLOW_DISCORD_TOKEN || '').toLowerCase() === 'true' || process.env.BOT_API_ALLOW_DISCORD_TOKEN === '1',
  // Optional shared secret for /form-submission endpoint. If unset, endpoint remains open.
  FORM_SUBMISSION_TOKEN: process.env.FORM_SUBMISSION_TOKEN || undefined,

  // Comma-separated role IDs that should be excluded from the !verifylist output
  // Example: VERIFYLIST_EXCLUDE_ROLE_IDS=12345,67890
  VERIFYLIST_EXCLUDE_ROLE_IDS: process.env.VERIFYLIST_EXCLUDE_ROLE_IDS || "1263502224181694467,1250194811521208353,1106779772492718180",
  // Arrest logging: channel where arrest embeds are posted
  ARREST_LOG_CHANNEL_ID: process.env.ARREST_LOG_CHANNEL_ID || "1221224045429915759",
  // Optional: restrict arrest logging to a single guild (server) by ID
  ARREST_GUILD_ID: cleanId(process.env.ARREST_GUILD_ID) || "1041577710067138560",
  // Optional: require users to have this role ID to run `arrest-log`
  ARREST_REQUIRED_ROLE_ID: cleanId(process.env.ARREST_REQUIRED_ROLE_ID) || "1041078857643597824",
  // Comma-separated role IDs that may edit/delete any arrest
  ARREST_ADMIN_ROLE_IDS: process.env.ARREST_ADMIN_ROLE_IDS || "1449861438012133566,1106739929540730921",

  // AoS forum workflow configuration
  AOS_FORUM_CHANNEL_ID: cleanId(process.env.AOS_FORUM_CHANNEL_ID) || "1414714736679059599",
  AOS_PING_ROLE_ID: cleanId(process.env.AOS_PING_ROLE_ID) || "1041577710067138561",
  AOS_TAG_COMPLETED_ID: cleanId(process.env.AOS_TAG_COMPLETED_ID) || "1414717583524888598",
  AOS_TAG_ACTIVE_WARRANT_ID: cleanId(process.env.AOS_TAG_ACTIVE_WARRANT_ID) || "1414718122971103333",
  AOS_TAG_INACTIVE_WARRANT_ID: cleanId(process.env.AOS_TAG_INACTIVE_WARRANT_ID) || "1414718213261889626",
  AOS_TAG_INFRACTION_LIGHT_ID: cleanId(process.env.AOS_TAG_INFRACTION_LIGHT_ID) || "1414718407621873764",
  AOS_TAG_INFRACTION_MEDIUM_ID: cleanId(process.env.AOS_TAG_INFRACTION_MEDIUM_ID) || "1414718477612093571",
  AOS_TAG_INFRACTION_HEAVY_ID: cleanId(process.env.AOS_TAG_INFRACTION_HEAVY_ID) || "1414718528774475786",
  AOS_TAG_30_DAY_ID: cleanId(process.env.AOS_TAG_30_DAY_ID) || "1414731884872728709",
  AOS_TAG_RECALLED_ID: cleanId(process.env.AOS_TAG_RECALLED_ID) || "1414717678156779752",
  AOS_TAG_APPROVED_ID: cleanId(process.env.AOS_TAG_APPROVED_ID) || "1525486629458804928",
  AOS_TAG_REQUISITION_REWARD_ID: cleanId(process.env.AOS_TAG_REQUISITION_REWARD_ID) || "1414718868966080586",
  AOS_TAG_MEDAL_REWARD_ID: cleanId(process.env.AOS_TAG_MEDAL_REWARD_ID) || "1414719611378864168",
  AOS_ADD_ROLE_IDS: process.env.AOS_ADD_ROLE_IDS || "1041577710067138561",
  AOS_APPROVE_ROLE_IDS: process.env.AOS_APPROVE_ROLE_IDS || "1449861438012133566,1515073017804361728,1106739929540730921",
  AOS_COMPLETE_ROLE_IDS: process.env.AOS_COMPLETE_ROLE_IDS || "1041577710067138561",
  AOS_COMPLETE_PING_ROLE_ID: cleanId(process.env.AOS_COMPLETE_PING_ROLE_ID) || "1515073017804361728",
  AOS_BANNED_ROLE_ID: cleanId(process.env.AOS_BANNED_ROLE_ID) || "1327721437276012595",
  AOS_LOOKUP_MAX_THREADS: process.env.AOS_LOOKUP_MAX_THREADS !== undefined ? Number(process.env.AOS_LOOKUP_MAX_THREADS) : 100,

  // XP log monitoring for online AoS alerts
  XP_LOG_CHANNEL_ID: cleanId(process.env.XP_LOG_CHANNEL_ID) || "994328564625326152",
  XP_ALERT_CHANNEL_ID: cleanId(process.env.XP_ALERT_CHANNEL_ID) || "1041577711665156155",
  XP_ALERT_DEDUP_MINUTES: process.env.XP_ALERT_DEDUP_MINUTES !== undefined ? Number(process.env.XP_ALERT_DEDUP_MINUTES) : 10,
  XP_ALERT_VERBOSE: (process.env.XP_ALERT_VERBOSE || '').toLowerCase() === 'true' || process.env.XP_ALERT_VERBOSE === '1',
  // TTL for cached AoS entry lookups used by XP watcher (milliseconds)
  XP_AOS_CACHE_TTL_MS: process.env.XP_AOS_CACHE_TTL_MS !== undefined ? Number(process.env.XP_AOS_CACHE_TTL_MS) : 60000,

  // AI assistant (/ask and @mentions). Requires ANTHROPIC_API_KEY.
  // Comma-separated guild IDs where the assistant may answer (the knowledge base contains restricted OSI documents).
  AI_GUILD_IDS: process.env.AI_GUILD_IDS || "1041577710067138560",
  AI_MODEL: process.env.AI_MODEL || "claude-haiku-5-5",
  // Channel that receives "wrong answer" reports. Deliberately no LOG_CHANNEL_ID fallback: that is the application log.
  AI_FEEDBACK_CHANNEL_ID: cleanId(process.env.AI_FEEDBACK_CHANNEL_ID) || "1560299106193375314",
  // Who built the bot; the assistant knows them and plays along when members poke fun at them.
  AI_CREATOR_NAME: process.env.AI_CREATOR_NAME || "Animated",
  AI_CREATOR_ID: cleanId(process.env.AI_CREATOR_ID) || "716248402513494027",
  AI_USER_COOLDOWN_SECONDS: process.env.AI_USER_COOLDOWN_SECONDS !== undefined ? Number(process.env.AI_USER_COOLDOWN_SECONDS) : 10,
  AI_USER_DAILY_LIMIT: process.env.AI_USER_DAILY_LIMIT !== undefined ? Number(process.env.AI_USER_DAILY_LIMIT) : 40,
  AI_SYNC_INTERVAL_MINUTES: process.env.AI_SYNC_INTERVAL_MINUTES !== undefined ? Number(process.env.AI_SYNC_INTERVAL_MINUTES) : 30,
  // Knowledge sources. Google Docs must be shared with the service account (GOOGLE_SERVICE_ACCOUNT_JSON).
  AI_GOOGLE_DOC_IDS: process.env.AI_GOOGLE_DOC_IDS || "1pEVCUjvF9H6_WGfmgDV_I26rJWs-Tm40pyzqcNoK-8c,14CeLsAweWJOPIiwuOUHkg6jGARASySdPM2AFwyeQWKw,1YOBnhqZcKJ4xfvZl6k0h6OSYsBCaoTvTKYYboJRW24c,1PY4uWklus06TWDyuHYkhJxAVLP-s1wI4XXZqwGgt5IU",
  AI_TRELLO_BOARD_IDS: process.env.AI_TRELLO_BOARD_IDS || "GoXodhwD,IxtcpAoK",
  AI_WIKI_BASE_URL: process.env.AI_WIKI_BASE_URL || "https://sgcommand.wikidot.com",

  // Service account credentials for private sheets. Provide the full JSON
  // as a string in `GOOGLE_SERVICE_ACCOUNT_JSON` (preferred) or a filesystem
  // path in `GOOGLE_SERVICE_ACCOUNT_PATH` (legacy).
  GOOGLE_SERVICE_ACCOUNT_JSON: (() => {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) return undefined;
    // Try plain JSON
    try { return JSON.parse(raw); } catch (e) {}
    // Try JSON with escaped newlines fixed
    try { return JSON.parse(raw.replace(/\\n/g, '\n')); } catch (e) {}
    // Try base64-encoded JSON
    try { const dec = Buffer.from(raw, 'base64').toString('utf8'); return JSON.parse(dec); } catch (e) {}
    return undefined;
  })(),
  GOOGLE_SERVICE_ACCOUNT_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_PATH || undefined
};

// Admin whitelist: comma-separated user IDs in env var ADMIN_WHITELIST
// Example: ADMIN_WHITELIST=123,456,789
module.exports.ADMIN_WHITELIST = (process.env.ADMIN_WHITELIST || "716248402513494027").split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
module.exports.AI_GUILD_IDS_LIST = String(module.exports.AI_GUILD_IDS || "").split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
module.exports.AI_GOOGLE_DOC_IDS_LIST = String(module.exports.AI_GOOGLE_DOC_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
module.exports.AI_TRELLO_BOARD_IDS_LIST = String(module.exports.AI_TRELLO_BOARD_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const _rawRequiredRoles = process.env.REQUIRED_ROLE_ID || module.exports.REQUIRED_ROLE_ID || "";
module.exports.REQUIRED_ROLE_IDS_LIST = String(_rawRequiredRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
// Processed list of role IDs to exclude from verifylist (from VERIFYLIST_EXCLUDE_ROLE_IDS)
// Build processed list of role IDs to exclude from verifylist. Prefer explicit env var, otherwise use the
// `VERIFYLIST_EXCLUDE_ROLE_IDS` value defined above in the exported config object.
const _rawVerifylistExclude = process.env.VERIFYLIST_EXCLUDE_ROLE_IDS || module.exports.VERIFYLIST_EXCLUDE_ROLE_IDS || "";
module.exports.VERIFYLIST_EXCLUDE_ROLE_IDS_LIST = String(_rawVerifylistExclude).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawKickStripRoles = process.env.KICK_ROLE_STRIP_ROLE_IDS || module.exports.KICK_ROLE_STRIP_ROLE_IDS || "";
module.exports.KICK_ROLE_STRIP_ROLE_IDS_LIST = String(_rawKickStripRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawKickAllowedRoles = process.env.KICK_COMMAND_ALLOWED_ROLE_IDS || module.exports.KICK_COMMAND_ALLOWED_ROLE_IDS || "";
module.exports.KICK_COMMAND_ALLOWED_ROLE_IDS_LIST = String(_rawKickAllowedRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawAosAddRoles = process.env.AOS_ADD_ROLE_IDS || module.exports.AOS_ADD_ROLE_IDS || "";
module.exports.AOS_ADD_ROLE_IDS_LIST = String(_rawAosAddRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawAosApproveRoles = process.env.AOS_APPROVE_ROLE_IDS || module.exports.AOS_APPROVE_ROLE_IDS || "";
module.exports.AOS_APPROVE_ROLE_IDS_LIST = String(_rawAosApproveRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawAosCompleteRoles = process.env.AOS_COMPLETE_ROLE_IDS || module.exports.AOS_COMPLETE_ROLE_IDS || "";
module.exports.AOS_COMPLETE_ROLE_IDS_LIST = String(_rawAosCompleteRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawEventCreatorRoles = process.env.EVENT_CREATOR_ROLE_IDS || module.exports.EVENT_CREATOR_ROLE_IDS || "";
module.exports.EVENT_CREATOR_ROLE_IDS_LIST = String(_rawEventCreatorRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawEventHostRoles = process.env.EVENT_HOST_ROLE_IDS || module.exports.EVENT_HOST_ROLE_IDS || "";
module.exports.EVENT_HOST_ROLE_IDS_LIST = String(_rawEventHostRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);
const _rawCourtMartialHostRoles = process.env.EVENT_COURT_MARTIAL_HOST_ROLE_IDS || module.exports.EVENT_COURT_MARTIAL_HOST_ROLE_IDS || "";
module.exports.EVENT_COURT_MARTIAL_HOST_ROLE_IDS_LIST = String(_rawCourtMartialHostRoles).split(",").map(s => cleanId(s)).map(s => s.trim()).filter(Boolean);

function _normalizeRoleList(input) {
  if (Array.isArray(input)) return input.map(s => cleanId(s)).map(s => String(s || '').trim()).filter(Boolean);
  return String(input || '').split(',').map(s => cleanId(s)).map(s => String(s || '').trim()).filter(Boolean);
}

function _parsePresetRoleMap(raw) {
  const source = String(raw || '').trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      const roleIds = _normalizeRoleList(value);
      if (roleIds.length) out[String(key).trim()] = roleIds;
    }
    return out;
  } catch (e) {
    return {};
  }
}

const _presetMapFromEnv = _parsePresetRoleMap(process.env.EVENT_PRESET_HOST_ROLE_IDS || module.exports.EVENT_PRESET_HOST_ROLE_IDS || "");
if (module.exports.EVENT_COURT_MARTIAL_HOST_ROLE_IDS_LIST.length) {
  const existing = Array.isArray(_presetMapFromEnv.court_martials) ? _presetMapFromEnv.court_martials : [];
  const merged = Array.from(new Set([...existing, ...module.exports.EVENT_COURT_MARTIAL_HOST_ROLE_IDS_LIST]));
  _presetMapFromEnv.court_martials = merged;
}
module.exports.EVENT_PRESET_HOST_ROLE_IDS_MAP = _presetMapFromEnv;
