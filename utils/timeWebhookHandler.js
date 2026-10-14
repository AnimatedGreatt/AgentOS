const config = require("../config");
const { google } = require("googleapis");
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { getState } = require('./adminState');
const verificationStore = require('./verificationStore');
const probationStore = require('./probationStore');

function resolveRoleToken(token, guild) {
  if (!token || !guild) return null;
  const t = String(token).trim();
  // Extract numeric ID if token looks like a mention or contains digits
  const idMatch = t.match(/(\d{5,})/);
  if (idMatch) {
    const id = idMatch[1];
    const byId = guild.roles.cache.get(id);
    if (byId) return byId;
  }
  // Try exact ID match
  if (guild.roles.cache.get(t)) return guild.roles.cache.get(t);
  // Try by name (case-insensitive)
  const byName = guild.roles.cache.find(r => r.name.toLowerCase() === t.toLowerCase());
  if (byName) return byName;
  return null;
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

function parseRange(range) {
  // Expect formats like 'Sheet1!A2:C1000' or 'Sheet Name' variations
  const m = range.match(/^([^!]+)!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/);
  if (!m) return null;
  return { sheetName: m[1], startCol: m[2], startRow: Number(m[3]) };
}

function stripLeadingApostrophe(s) {
  if (s === undefined || s === null) return s;
  return String(s).replace(/^[\u0027\u2018\u2019]+/, '');
}

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function updateMinutesForUser(username, minutesToAdd) {
  if (!config.GOOGLE_SHEET_ID) throw new Error("GOOGLE_SHEET_ID not configured");
  const range = config.TIME_LOG_SHEET_RANGE;
  const parsed = parseRange(range);
  if (!parsed) throw new Error("TIME_LOG_SHEET_RANGE has unsupported format: " + range);

  const sheets = await getSheets();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: config.GOOGLE_SHEET_ID,
    range
  });
  const rows = resp.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cellName = (row[config.TIME_LOG_NAME_COL] || "").toString().trim();
    if (cellName.toLowerCase() === username.toLowerCase()) {
      const currentWeekly = parseInt(row[config.TIME_LOG_MINUTES_COL]) || 0;
      const updatedWeekly = currentWeekly + minutesToAdd;

      // Determine total column index (config override, otherwise minutes col + 1)
      const totalColIdx = (typeof config.TIME_LOG_TOTAL_COL === 'number') ? config.TIME_LOG_TOTAL_COL : (config.TIME_LOG_MINUTES_COL + 1);
      const currentTotal = parseInt(row[totalColIdx]) || 0;
      const updatedTotal = currentTotal + minutesToAdd;

      const startColIndex = colLetterToIndex(parsed.startCol);
      const weeklyColIndex = startColIndex + config.TIME_LOG_MINUTES_COL;
      const totalColIndex = startColIndex + totalColIdx;
      const weeklyColLetter = indexToColLetter(weeklyColIndex);
      const totalColLetter = indexToColLetter(totalColIndex);
      const targetRowNumber = parsed.startRow + i;
      const weeklyA1 = `${parsed.sheetName}!${weeklyColLetter}${targetRowNumber}`;
      const totalA1 = `${parsed.sheetName}!${totalColLetter}${targetRowNumber}`;

      // Debug: log current/updated values and target A1 ranges (debug-level)
      if (config.TIME_WEBHOOK_VERBOSE) console.debug(`Updating sheet for ${username}: weekly ${currentWeekly} -> ${updatedWeekly} (${weeklyA1}), total ${currentTotal} -> ${updatedTotal} (${totalA1})`);
      try { if (config.TIME_WEBHOOK_VERBOSE) console.debug('Writing values:', weeklyA1, JSON.stringify(String(updatedWeekly)), totalA1, JSON.stringify(String(updatedTotal))); } catch (e) {}
      try {
        const resp = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: config.GOOGLE_SHEET_ID,
          resource: {
            // Use USER_ENTERED so Sheets will parse dates/numbers naturally
            valueInputOption: 'USER_ENTERED',
            data: [
              { range: weeklyA1, values: [[updatedWeekly]] },
              { range: totalA1, values: [[updatedTotal]] }
            ]
          }
        });
        if (config.TIME_WEBHOOK_VERBOSE) console.debug('Sheets batchUpdate response status:', resp.status || (resp && resp.statusText) || 'unknown');
      } catch (err) {
        console.error('Error writing to sheet for', username, err);
      }

      return { updatedWeekly, updatedTotal, row: targetRowNumber, weeklyCol: weeklyColLetter, totalCol: totalColLetter };
    }
  }
  return null;
}

function parseGameMessage(content) {
  if (!content) return null;
  const usernameMatch = content.match(/Username:\s*([^|\r\n]+)/i);
  const timeMatch = content.match(/Time:\s*(\d+)\s*(?:mins?|minutes?)?/i);
  const rankMatch = content.match(/Rank:\s*([^|\r\n]+)/i);
  // Time is optional for join/leave messages; default minutes to 0 when absent

  let username = usernameMatch ? usernameMatch[1].trim() : null;
  if (!username) {
    // Fallback: extract first segment before a pipe or newline and strip any leading label
    const firstSeg = String(content).split(/[|\r\n]/)[0] || '';
    username = firstSeg.replace(/Username:\s*/i, '').trim();
  }
  if (!username) return null;

  const minutes = timeMatch ? Number(timeMatch[1]) : 0;
  return { username, minutes, rank: rankMatch ? rankMatch[1].trim() : null };
}

async function handleTimeWebhookMessage(message) {
  try {
    // Determine debug mode early to gate verbose logging
    let state = { debugMode: false };
    try { state = await getState(); } catch (e) { /* ignore */ }
    const isDebug = !!(state && state.debugMode) || !!config.TIME_WEBHOOK_VERBOSE;

    // Early debug: show incoming message routing info
    try {
      const configuredList = String(config.TIME_LOG_CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
      if (isDebug) console.debug('timeWebhookHandler invoked', {
        channelId: message?.channel?.id,
        configuredTimeLogChannelIds: configuredList,
        guildId: message?.guild?.id,
        authorBot: !!(message && message.author && message.author.bot),
        webhookId: message && message.webhookId,
        hasContent: !!(message && message.content),
        preview: (message && message.content) ? String(message.content).slice(0,160) : null
      });
    } catch (e) { /* ignore logging failures */ }

    if (!message || !message.content) return;
    // Allow overriding the bot-author guard when admin debug mode is enabled
    if (message.author && message.author.bot && !(message.webhookId) && !state.debugMode) return; // ignore normal bots unless webhook
    // Allow comma-separated list of channel IDs in config.TIME_LOG_CHANNEL_ID (legacy single ID supported)
    const allowedChannels = String(config.TIME_LOG_CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    const isTimeLogChannel = (allowedChannels.length === 0) || (message.channel && allowedChannels.includes(message.channel.id));
    if (!isTimeLogChannel && isDebug) console.debug('timeWebhookHandler: message is not in configured TIME_LOG_CHANNEL_ID(s); skipping sheet update but continuing probation checks', { messageChannelId: message.channel?.id, allowedChannels });

    const parsed = parseGameMessage(message.content);
    if (!parsed) return; // not in expected format

    if (isTimeLogChannel) {
      if (state.pauseTimeLogging) {
        if (isDebug) console.debug('Skipping sheet update because automatic time logging is paused by admin state.');
      } else {
        const res = await updateMinutesForUser(parsed.username, parsed.minutes);
        if (res) {
          if (isDebug) console.debug(`Updated ${parsed.username}: +${parsed.minutes} weekly=${res.updatedWeekly} total=${res.updatedTotal} (weekly ${res.weeklyCol}${res.row}, total ${res.totalCol}${res.row})`);
        } else {
          if (isDebug) console.debug(`Username not found in sheet: ${parsed.username}`);
        }
      }
    } else {
      if (isDebug) console.debug('Skipping sheet update because message is not in TIME_LOG_CHANNEL_ID; continuing to probation checks.');
    }

    // Probationary detection and role check
    // Only alert on JOIN events to avoid duplicate alerts on join/leave
    if (!/\bJOIN\b/i.test(message.content)) return;
    try {
      const probNames = String(config.PROBATION_RANK_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const rank = parsed.rank ? String(parsed.rank).toLowerCase() : '';
      if (isDebug) console.debug('Probation check:', { username: parsed.username, rank: parsed.rank, probNames });
      if (rank && probNames.some(pn => rank.includes(pn))) {
        // Attempt to resolve a guild member for role checking. Prefer verified binding (Roblox->Discord).
        let member = null;
        try {
          if (message.guild) {
            // Try verification store first
            let v = null;
            try { v = await verificationStore.getByRoblox(parsed.username); } catch (e) { console.warn('verificationStore.getByRoblox failed:', e); }
            // Stored username may be stale after a Roblox rename: resolve the current name to a user id instead
            if (!v) {
              try {
                const lookup = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [parsed.username], excludeBannedUsers: true });
                const robloxId = lookup.data && lookup.data.data && lookup.data.data[0] ? lookup.data.data[0].id : null;
                if (robloxId) {
                  v = await verificationStore.getByRobloxId(robloxId);
                  if (v) v = await verificationStore.refreshUsername(v);
                }
              } catch (e) { console.warn('Roblox id fallback lookup failed:', e?.response?.status || e.message || e); }
            }
            if (isDebug) console.debug('verification lookup result for', parsed.username, v ? { discord_id: v.discord_id, roblox_userid: v.roblox_userid } : null);
            if (v && v.discord_id) {
              member = await message.guild.members.fetch(v.discord_id, { force: true }).catch(() => null);
              if (member && isDebug) console.debug('Fetched member by verification id (force):', member.user.id);
            }
            // Fallback: direct mention in message
            if (!member) {
              const mentionMatch = message.content.match(/<@!?(\d+)>/);
              if (mentionMatch) {
                member = await message.guild.members.fetch(mentionMatch[1], { force: true }).catch(() => null);
                if (member && isDebug) console.debug('Fetched member by mention (force):', member.user.id);
              }
            }
            // Final fallback: find by username/tag in cache
            if (!member) {
              const uname = parsed.username;
              member = message.guild.members.cache.find(m => (m.user.username && m.user.username.toLowerCase() === String(uname).toLowerCase()) || (m.user.tag && m.user.tag.toLowerCase().startsWith(String(uname).toLowerCase())) ) || null;
            }

            if (member) {
              if (isDebug) console.debug('Resolved guild member for probation check:', { id: member.user.id, tag: member.user.tag });
              // Force-fetch fresh member data to ensure role cache is up-to-date
              try { member = await message.guild.members.fetch(member.user.id, { force: true }).catch(() => member); } catch (e) { /* ignore */ }
              try { if (isDebug) console.debug('Post-fetch member roles count:', member.roles.cache.size); } catch (e) { /* ignore */ }
              // Log member roles briefly for diagnosis
              try {
                const roleList = Array.from(member.roles.cache.values()).map(r => `${r.id}:${r.name}`);
                if (isDebug) console.debug('Member roles:', roleList.slice(0,50));
              } catch (e) { /* ignore logging errors */ }
              // First, check suspicious roles (highest priority). If any found, alert with those.
              const suspiciousTokens = String(config.PROBATION_SUSPICIOUS_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
              if (isDebug) console.debug('Suspicious role tokens:', suspiciousTokens);
              const matchedSuspicious = suspiciousTokens.map(tok => {
                const role = resolveRoleToken(tok, message.guild);
                const id = role ? role.id : String(tok).trim();
                const name = role ? role.name : String(tok).trim();
                const has = !!member.roles.cache.has(id);
                return { id, name, has };
              }).filter(x => x.has);
              if (matchedSuspicious.length > 0) {
                // Detected suspicious roles — defer to probationWatcher via pending registration
                if (isDebug) console.debug('Detected suspicious roles; deferring alert to probationWatcher:', matchedSuspicious.map(x => x.name).join(', '));
              } else {
                // No suspicious roles — check required roles (pass if member has ANY of them). If none present, alert with missing list.
                const requiredTokens = String(config.PROBATION_REQUIRED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
                if (isDebug) console.debug('Required role tokens:', requiredTokens);
                const requiredInfo = requiredTokens.map(tok => {
                  const role = resolveRoleToken(tok, message.guild);
                  const id = role ? role.id : String(tok).trim();
                  const name = role ? role.name : String(tok).trim();
                  const has = !!member.roles.cache.has(id);
                  return { id, name, has };
                });
                if (isDebug) console.debug('Required role details for member:', requiredInfo);
                const hasAnyRequired = requiredInfo.some(r => r.has);
                if (isDebug) console.debug('Has any required role:', hasAnyRequired);
                if (!hasAnyRequired) {
                  // Missing required roles — defer to probationWatcher via pending registration
                  if (isDebug) console.debug('Member missing required roles; deferring alert to probationWatcher:', requiredInfo.map(x => x.name).join(', '));
                  // Diagnostic recheck remains in place below (will still run), but final alert is sent by probationWatcher
                  try {
                    for (const r of requiredInfo) {
                      try {
                        const fetchedRole = await message.guild.roles.fetch(r.id).catch(() => null);
                        if (isDebug) console.debug(`Diagnostic: fetched role ${r.id} ->`, fetchedRole ? fetchedRole.name : null);
                      } catch (e) { console.warn('Diagnostic: role fetch failed for', r.id, e); }
                    }
                    await new Promise(res => setTimeout(res, 1000));
                    try {
                      const refetched = await message.guild.members.fetch(member.user.id, { force: true }).catch(() => null);
                      if (refetched) {
                        const reInfo = requiredTokens.map(tok => {
                          const role = resolveRoleToken(tok, message.guild);
                          const id = role ? role.id : String(tok).trim();
                          const name = role ? role.name : String(tok).trim();
                          const has = !!refetched.roles.cache.has(id);
                          return { id, name, has };
                        });
                        if (isDebug) console.debug('Diagnostic: rechecked required role details for member:', reInfo);
                        const reHasAny = reInfo.some(r => r.has);
                        if (reHasAny) {
                          if (isDebug) console.debug('Diagnostic: member gained required role after recheck, skipping alert for', member.user.id);
                          return;
                        }
                      }
                    } catch (e) { console.warn('Diagnostic: member re-fetch failed', e); }
                  } catch (e) {
                    console.warn('Diagnostic: error during role recheck', e);
                  }
                }
              }
              // Register pending probation check so memberUpdate listener can act as authoritative source
              try {
                probationStore.addPending({ discordId: member.user.id, robloxUsername: parsed.username, rank: parsed.rank });
                if (isDebug) console.debug('Registered pending probation check for', member.user.id);
              } catch (e) { /* ignore */ }
              // If configured, toggle a temporary role to force a guildMemberUpdate event so our watcher runs immediately.
              try {
                const tempRoleId = String(config.PROBATION_TEMP_ROLE_ID || '').trim();
                if (tempRoleId) {
                  const has = !!member.roles.cache.has(tempRoleId);
                  if (!has) {
                    // member did not have the role: add then remove to restore original state (removed)
                    await member.roles.add(tempRoleId, 'probation-check: trigger role update').catch(err => { console.warn('Failed to add probation temp role:', err && err.message ? err.message : err); });
                    setTimeout(() => {
                      member.roles.remove(tempRoleId, 'probation-check: cleanup').catch(err => { console.warn('Failed to remove probation temp role:', err && err.message ? err.message : err); });
                    }, 800);
                    if (isDebug) console.debug('Added then removed temp probation role to force guildMemberUpdate for', member.user.id);
                  } else {
                    // member already has the role: remove then re-add to preserve original state
                    await member.roles.remove(tempRoleId, 'probation-check: trigger role update (remove)').catch(err => { console.warn('Failed to remove probation temp role (pre):', err && err.message ? err.message : err); });
                    setTimeout(() => {
                      member.roles.add(tempRoleId, 'probation-check: trigger role update (re-add)').catch(err => { console.warn('Failed to re-add probation temp role:', err && err.message ? err.message : err); });
                    }, 500);
                    if (isDebug) console.debug('Removed then re-added temp probation role to force guildMemberUpdate for', member.user.id);
                  }
                }
              } catch (e) {
                console.warn('Error toggling probation temp role:', e && e.message ? e.message : e);
              }
            } else {
              if (isDebug) console.debug('Probationary user detected but could not resolve guild member to check roles:', parsed.username);
              // still register by roblox username so memberUpdate can match later if verification happens
              try { probationStore.addPending({ robloxUsername: parsed.username, rank: parsed.rank }); } catch (e) {}
            }
          }
        } catch (err) {
          console.error('Probation detection error:', err);
        }
      }
    } catch (err) {
      console.error('Probation detection error:', err);
    }
  } catch (err) {
    console.error("Error handling time webhook message:", err);
  }
}

module.exports = { handleTimeWebhookMessage };
