const { SlashCommandBuilder } = require("discord.js");
const config = require("../config");
const { google } = require("googleapis");

function normalizeCell(value) {
  return (value || "").toString().trim();
}

function isImmuneStatus(value) {
  const s = normalizeCell(value).toLowerCase();
  return s === (config.GAME_QUOTA_IMMUNE_TEXT || "IMMUNE").toLowerCase();
}

function isFailedStatus(value) {
  const s = normalizeCell(value).toLowerCase();
  // Google Sheets checkbox/IF outputs are typically TRUE/FALSE (string values via values API).
  return s === "false" || s === "unchecked" || s === "0" || s === "no" || s === "n";
}

function colLetterToIndex(letter) {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 65 + 1);
  }
  return index - 1;
}

function indexToColLetter(index) {
  let s = "";
  while (index >= 0) {
    s = String.fromCharCode(65 + (index % 26)) + s;
    index = Math.floor(index / 26) - 1;
  }
  return s;
}

function parseRectRange(range) {
  const m = String(range || "").match(/^([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return null;
  return {
    sheetName: m[1],
    startColLetter: m[2].toUpperCase(),
    startRow: Number(m[3]),
    endColLetter: m[4].toUpperCase(),
    endRow: Number(m[5])
  };
}

function getCycleKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function getWritableSheetsClient() {
  if (!config.GOOGLE_SHEET_ID) return null;
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON && !config.GOOGLE_SERVICE_ACCOUNT_PATH) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function getNextStrike(row, strikeCol) {
  if (typeof strikeCol !== 'number') return null;
  const rawStrike = normalizeCell(row[strikeCol]);
  const currentStrike = Number(rawStrike) || 0;
  return Math.min(currentStrike + 1, 3);
}

function getQuotaFailureReason(row, minutesCol) {
  const rawMinutes = normalizeCell(row[minutesCol]);
  if (rawMinutes === '' || rawMinutes === '0') return 'No activity';

  const minutes = Number(rawMinutes);
  if (!Number.isNaN(minutes)) {
    if (minutes <= 0) return 'No activity';
    if (minutes < 60) return `Missing ${60 - minutes} minutes`;
  }

  return 'Quota not met';
}

function formatStrikeSections(entries, strikeCol, minutesCol) {
  const buckets = new Map([
    [1, []],
    [2, []],
    [3, []]
  ]);

  for (const entry of entries) {
    const nextStrike = (entry && typeof entry.nextStrike === 'number')
      ? entry.nextStrike
      : getNextStrike(entry.row, strikeCol);
    const reason = getQuotaFailureReason(entry.row, minutesCol);
    const line = nextStrike
      ? `- ${entry.name} | ${reason} | Strike ${nextStrike}`
      : `- ${entry.name} | ${reason}`;

    if (nextStrike && buckets.has(nextStrike)) {
      buckets.get(nextStrike).push(line);
      continue;
    }

    buckets.get(1).push(line);
  }

  const firstStrikes = buckets.get(1);
  const secondStrikes = buckets.get(2);
  const finalStrikes = buckets.get(3);

  return [
    '**First Strikes**',
    firstStrikes.length ? firstStrikes.join('\n') : '- N/A',
    '',
    '**Second Strikes**',
    secondStrikes.length ? secondStrikes.join('\n') : '- N/A',
    '',
    '**Final Strikes (Removal from OSI)**',
    finalStrikes.length ? finalStrikes.join('\n') : '- N/A'
  ].join('\n');
}

function formatRemovalSection(removals, passWeeksNeeded) {
  const body = removals.length
    ? removals.map(r => `- ${r.name} | Eligible for removal (${r.before} -> ${r.after}) | Completed ${passWeeksNeeded} weeks`).join('\n')
    : '- N/A';
  return ['**Strike Removals**', body].join('\n');
}

function formatProgressSection(progress, passWeeksNeeded) {
  const body = progress.length
    ? progress.map(p => `- ${p.name} | Pass streak ${p.streak}/${passWeeksNeeded} | Quota strike ${p.strikes}`).join('\n')
    : '- N/A';
  return ['**Pass Progress**', body].join('\n');
}

function parseQuotaStrikeNotes(notesText) {
  const notes = normalizeCell(notesText);
  if (!notes) return { ok: true, hasNotes: false, quotaStrikes: null };

  const parts = notes.split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: true, hasNotes: true, quotaStrikes: 0 };

  let quotaStrikes = 0;
  for (const part of parts) {
    const lower = part.toLowerCase();
    // Non-quota notes are ignored entirely.
    if (!lower.includes('quota')) continue;

    // For quota entries, require strict format: Nx Quota strike
    const quotaMatch = part.match(/^(\d+)\s*x\s*quota\s+strike$/i);
    if (!quotaMatch) return { ok: false, hasNotes: true, quotaStrikes: null };

    const count = Number(quotaMatch[1]);
    if (!Number.isFinite(count)) return { ok: false, hasNotes: true, quotaStrikes: null };
    quotaStrikes += count;
  }

  return { ok: true, hasNotes: true, quotaStrikes };
}

function getNextQuotaDueTimestamp(now = new Date()) {
  // Quota checks run on a weekly cadence.
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 7);
  return Math.floor(next.getTime() / 1000);
}

async function getSheetRows(range) {
  // If an API key is provided, use the simple REST read (read-only)
  if (config.GOOGLE_SHEETS_API_KEY && config.GOOGLE_SHEET_ID) {
    const axios = require('axios');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?key=${config.GOOGLE_SHEETS_API_KEY}`;
    const res = await axios.get(url);
    return res.data.values || [];
  }

  // Otherwise attempt service account credentials via googleapis
  if (config.GOOGLE_SHEET_ID && (config.GOOGLE_SERVICE_ACCOUNT_JSON || config.GOOGLE_SERVICE_ACCOUNT_PATH)) {
    const auth = new google.auth.GoogleAuth({
      credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
      keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.GOOGLE_SHEET_ID, range });
    return (resp && resp.data && resp.data.values) || [];
  }

  throw new Error('Google Sheets not configured: provide GOOGLE_SHEETS_API_KEY or service account credentials');
}

async function resolveQuotaChannelAndPermission(interaction, channelId, requiredRoles) {
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    return { channel: null, allowed: false, error: 'Could not fetch the target channel.' };
  }

  const targetGuildId = channel.guildId || (channel.guild && channel.guild.id) || null;
  if (!targetGuildId) {
    return { channel, allowed: false, error: 'Configured quota channel is not in a guild.' };
  }

  // If no role restriction is configured, allow by default.
  if (!requiredRoles.length) {
    return { channel, allowed: true, error: null };
  }

  // Fast path when command is run in the same guild context.
  if (interaction.guildId === targetGuildId && interaction.member && interaction.member.roles && interaction.member.roles.cache) {
    const hasRole = requiredRoles.some(roleId => interaction.member.roles.cache.has(roleId));
    return { channel, allowed: hasRole, error: null };
  }

  // Cross-guild check: verify membership and role in the quota channel's guild.
  const guild = await interaction.client.guilds.fetch(targetGuildId).catch(() => null);
  if (!guild) {
    return { channel, allowed: false, error: 'Could not access the quota guild to verify permissions.' };
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !member.roles || !member.roles.cache) {
    return { channel, allowed: false, error: null };
  }

  const hasRole = requiredRoles.some(roleId => member.roles.cache.has(roleId));
  return { channel, allowed: hasRole, error: null };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("quota-check")
    .setDescription("Run a weekly quota check and post a report to the configured channel (ASK BEFORE USE)"),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const channelId = String(config.GAME_QUOTA_CHANNEL_ID || '').trim();
    if (!channelId) return interaction.editReply("No target channel configured for quota reports.");

    // Restrict based on roles in the configured quota channel's guild.
    let quotaChannel = null;
    try {
      const requiredRoles = Array.isArray(config.REQUIRED_ROLE_IDS_LIST)
        ? config.REQUIRED_ROLE_IDS_LIST
        : String(config.REQUIRED_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
      const permission = await resolveQuotaChannelAndPermission(interaction, channelId, requiredRoles);
      quotaChannel = permission.channel;
      if (permission.error) {
        await interaction.editReply({ content: permission.error, ephemeral: true });
        return;
      }
      if (!permission.allowed) {
        await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true });
        return;
      }
    } catch (err) {
      // If anything goes wrong resolving roles, deny by default
      try { await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true }); } catch (e) {}
      return;
    }

    try {
      if (!config.GOOGLE_SHEET_ID) return interaction.editReply("Google sheet not configured.");
      const range = config.TIME_LOG_SHEET_RANGE;
      const rows = await getSheetRows(range);

      const nameCol = config.TIME_LOG_NAME_COL || 0;
      const minutesCol = config.TIME_LOG_MINUTES_COL || 2;
      const rankCol = (config.TIME_LOG_RANK_COL !== undefined && config.TIME_LOG_RANK_COL !== null) ? Number(config.TIME_LOG_RANK_COL) : undefined;
      const passCol = (config.GAME_QUOTA_PASS_COL !== undefined && config.GAME_QUOTA_PASS_COL !== null) ? Number(config.GAME_QUOTA_PASS_COL) : undefined;
      const excludeRanks = new Set([
        ...(config.GAME_QUOTA_EXCLUDE_RANKS || "").split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        'low command',
        'medium command'
      ]);

      const failed = [];
      const candidates = [];
      let topName = null;
      let topMinutes = -1;

      const strikeCol = (config.GAME_LOG_STRIKE_COL !== undefined && config.GAME_LOG_STRIKE_COL !== null) ? Number(config.GAME_LOG_STRIKE_COL) : undefined;

      for (const row of rows) {
        const name = normalizeCell(row[nameCol]);
        const raw = normalizeCell(row[minutesCol]);
        if (!name) continue;
        // If a rank column is configured and the rank matches an excluded rank, skip this row
        if (typeof rankCol === 'number' && excludeRanks.size) {
          const rank = (row[rankCol] || "").toString().trim().toLowerCase();
          if (rank && excludeRanks.has(rank)) continue;
        }

        const passStatusRaw = typeof passCol === 'number' ? row[passCol] : undefined;
        if (isImmuneStatus(passStatusRaw)) {
          // IMMUNE users are excluded from both fail checks and Agent of the Week nomination.
          candidates.push({ name, row, failedByQuota: false, immune: true });
          continue;
        }

        let failedByQuota = false;
        if (typeof passCol === 'number' && isFailedStatus(passStatusRaw)) {
          failedByQuota = true;
          failed.push({ name, row });
        }

        // If the sheet cell contains exactly a single hyphen, treat it as ignored
        if (raw === "-") continue;
        if (raw !== "") {
          const val = Number(raw);
          if (!Number.isNaN(val)) {
            // Legacy fallback: if pass-status column is not configured, use time-based quota failure.
            if (typeof passCol !== 'number' && val < 60) {
              failedByQuota = true;
              failed.push({ name, row });
            }
            if (val > topMinutes) { topMinutes = val; topName = name; }
          }
        }

        candidates.push({ name, row, failedByQuota, immune: false });
      }

      // Exclude users currently on IN in DB
      let activeLower = new Set();
      try {
        const { getActiveRobloxUsernames } = require('../utils/inactivity/inactivityStore');
        const active = await getActiveRobloxUsernames();
        activeLower = new Set(active.map(a => String(a).toLowerCase()));
      } catch (err) {
        console.error('Failed to filter by IN DB:', err);
      }

      const filtered = failed.filter(obj => !activeLower.has(String(obj.name).toLowerCase()));
      let displayFailed = filtered.map(obj => ({ ...obj }));
      const passWeeksNeeded = Math.max(1, Number(config.GAME_QUOTA_PASS_WEEKS_FOR_REMOVAL) || 2);
      const removals = [];
      const progress = [];
      const trackingNotes = [];
      const missingTrackingRows = [];
      const invalidStrikeNoteUsers = [];

      try {
        const trackingRange = String(config.GAME_QUOTA_TRACKING_RANGE || '').trim();
        const trackingParsed = parseRectRange(trackingRange);
        const sheets = await getWritableSheetsClient();

        if (trackingRange && trackingParsed && sheets) {
          const usernameCol = Number(config.GAME_QUOTA_TRACKING_USERNAME_COL);
          const strikesCol = Number(config.GAME_QUOTA_TRACKING_STRIKES_COL);
          const passStreakCol = Number(config.GAME_QUOTA_TRACKING_PASS_STREAK_COL);
          const lastCycleCol = Number(config.GAME_QUOTA_TRACKING_LAST_CYCLE_COL);
          const lastOutcomeCol = Number(config.GAME_QUOTA_TRACKING_LAST_OUTCOME_COL);
          const lastUpdatedCol = Number(config.GAME_QUOTA_TRACKING_LAST_UPDATED_COL);
          const notesCol = Number(config.GAME_QUOTA_TRACKING_NOTES_COL);

          const trackingResp = await sheets.spreadsheets.values.get({
            spreadsheetId: config.GOOGLE_SHEET_ID,
            range: trackingRange
          });
          const trackingRows = (trackingResp && trackingResp.data && trackingResp.data.values) || [];
          const rowWidth = (colLetterToIndex(trackingParsed.endColLetter) - colLetterToIndex(trackingParsed.startColLetter)) + 1;
          const cycleKey = getCycleKey(new Date());
          const nowIso = new Date().toISOString();

          const trackingMap = new Map();
          for (let i = 0; i < trackingRows.length; i++) {
            const r = trackingRows[i] || [];
            const username = normalizeCell(r[usernameCol]);
            if (!username) continue;
            trackingMap.set(username.toLowerCase(), { index: i, row: r });
          }

          const writeUpdates = [];
          const failedStrikeMap = new Map();

          for (const c of candidates) {
            const key = String(c.name).toLowerCase();
            const existing = trackingMap.get(key);
            if (!existing) {
              missingTrackingRows.push(c.name);
              continue;
            }

            const existingRow = existing.row || [];
            const existingStrikes = Number(normalizeCell(existingRow[strikesCol])) || 0;
            const existingPassStreak = Number(normalizeCell(existingRow[passStreakCol])) || 0;
            const existingCycle = normalizeCell(existingRow[lastCycleCol]);
            const strikeNotes = normalizeCell(existingRow[notesCol]);
            const parsedNotes = parseQuotaStrikeNotes(strikeNotes);
            let quotaStrikesForCalc;
            if (parsedNotes.hasNotes && parsedNotes.ok) {
              // Notes exist and are valid: use parsed quota strikes only (don't fall back to existingStrikes)
              quotaStrikesForCalc = Math.max(0, Number(parsedNotes.quotaStrikes) || 0);
            } else if (!parsedNotes.hasNotes) {
              // No notes: use existing strikes as fallback
              quotaStrikesForCalc = Math.max(0, existingStrikes);
            } else {
              // Invalid notes: set to 0 to prevent strike removals
              quotaStrikesForCalc = 0;
            }
            const notesFormatInvalid = !!strikeNotes && !parsedNotes.ok;
            if (notesFormatInvalid) invalidStrikeNoteUsers.push(c.name);

            if (existingCycle === cycleKey) continue;

            let strikes = existingStrikes;
            let passStreak = existingPassStreak;
            let outcome = 'PASS';

            const isInactive = activeLower.has(key);
            if (c.immune) {
              outcome = 'IMMUNE';
            } else if (isInactive) {
              outcome = 'INACTIVE_SKIP';
            } else if (c.failedByQuota) {
              outcome = 'FAIL';
              passStreak = 0;
              const nextQuotaStrike = Math.min(quotaStrikesForCalc + 1, 3);
              failedStrikeMap.set(key, nextQuotaStrike);
            } else {
              passStreak = passStreak + 1;
              if (!notesFormatInvalid && passStreak >= passWeeksNeeded && quotaStrikesForCalc > 0) {
                const before = quotaStrikesForCalc;
                const after = Math.max(quotaStrikesForCalc - 1, 0);
                passStreak = 0;
                outcome = 'PASS_ELIGIBLE_FOR_REMOVAL';
                removals.push({ name: c.name, before, after });
              } else if (!notesFormatInvalid && quotaStrikesForCalc > 0) {
                progress.push({ name: c.name, streak: passStreak, strikes: quotaStrikesForCalc });
              }
            }

            const outRow = Array(rowWidth).fill('');
            for (let i = 0; i < rowWidth; i++) outRow[i] = existingRow[i] !== undefined ? String(existingRow[i]) : '';

            // Username and strike columns are managed by an external sync script.
            // Keep them read-only here to avoid write conflicts.
            outRow[passStreakCol] = String(passStreak);
            outRow[lastCycleCol] = cycleKey;
            outRow[lastOutcomeCol] = outcome;
            outRow[lastUpdatedCol] = nowIso;

            if (existing) {
              const absoluteRow = trackingParsed.startRow + existing.index;
              writeUpdates.push({
                range: `${trackingParsed.sheetName}!${trackingParsed.startColLetter}${absoluteRow}:${trackingParsed.endColLetter}${absoluteRow}`,
                values: [outRow]
              });
            }
          }

          if (writeUpdates.length) {
            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: config.GOOGLE_SHEET_ID,
              resource: {
                valueInputOption: 'USER_ENTERED',
                data: writeUpdates
              }
            });
          }

          displayFailed = filtered.map(obj => {
            const mapped = failedStrikeMap.get(String(obj.name).toLowerCase());
            if (typeof mapped === 'number') return { ...obj, nextStrike: mapped };
            return { ...obj };
          });

          if (missingTrackingRows.length) {
            trackingNotes.push(`Skipped ${missingTrackingRows.length} user(s) missing in tracking tab: ${missingTrackingRows.slice(0, 10).join(', ')}${missingTrackingRows.length > 10 ? ', ...' : ''}.`);
          }
          if (invalidStrikeNoteUsers.length) {
            const deduped = Array.from(new Set(invalidStrikeNoteUsers));
            trackingNotes.push(`Skipped pass progress for ${deduped.length} user(s) due to invalid strike note format (expected comma-separated \"Nx <Type> strike\" entries): ${deduped.slice(0, 10).join(', ')}${deduped.length > 10 ? ', ...' : ''}.`);
          }
        } else {
          trackingNotes.push('Tracking sheet updates skipped (missing range or writable Google service credentials).');
        }
      } catch (trackErr) {
        console.error('Quota tracking update failed:', trackErr);
        trackingNotes.push('Tracking sheet updates failed; posted report without automated strike removals/progress updates.');
      }

      const channel = quotaChannel || await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!channel) return interaction.editReply("Could not fetch the target channel.");

      const pingRoleId = config.GAME_QUOTA_PING_ROLE_ID || null;
      const rolePing = pingRoleId ? `<@&${pingRoleId}>` : "";

      const failedList = formatStrikeSections(displayFailed, strikeCol, minutesCol);
      const removalsList = formatRemovalSection(removals, passWeeksNeeded);
      const progressList = formatProgressSection(progress, passWeeksNeeded);
      const trackingNoteBlock = trackingNotes.length ? `\n\n*${trackingNotes.join(' ')}*` : '';
      const agent = topName ? `- ${topName}` : "- None";
      const nextQuotaDueTs = getNextQuotaDueTimestamp(new Date());
      const nextQuotaDueLine = `Next quota is due on <t:${nextQuotaDueTs}:D> (<t:${nextQuotaDueTs}:R>)`;

      const content = `# <:osi:1448992108500357150> Quota Check <:osi:1448992108500357150> #\n${rolePing}\n\nThis week's quota has been reset! Here are the statistics:\n\n${failedList}\n\n${removalsList}\n\n${progressList}\n\n**Agent of the week:**\n${agent}\n-# Contact <@852691896206622820> for your **__150 R$__** reward\n\n**In order to have a strike removed, you will need to complete the quota for 2 consecutive weeks.**\n-# *The roster will be manually reset shortly. ${nextQuotaDueLine}*${trackingNoteBlock}`;

      await channel.send({ content });
      await interaction.editReply({ content: `Quota check posted to <#${channelId}>.`, ephemeral: true });

    } catch (err) {
      console.error("quota-check error:", err);
      await interaction.editReply("An error occurred while running the quota check.");
    }
  }
};
