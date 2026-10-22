const express = require("express");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require("discord.js");
const config = require("../config");
const arrestStore = require('./arrestStore');
const verificationStore = require('./verification/verificationStore');
const axios = require('axios');
const { findActiveAosByUsername } = require('./aos/aosForumLookup');
const { findBlacklistEntry } = require("./blacklist/blacklistSheet");
const { analyzeSpamAnswers } = require("./spamFilter");
const { getState } = require('./adminState');
const aosActiveStore = require('./aos/aosActiveStore');

/**
 * Creates an Express server to handle form submissions from Google Apps Script
 * @param {Client} client - Discord client instance
 * @returns {Express.Application} Express app
 */
function createFormServer(client) {
  const app = express();
  app.use(express.json());

  const allowedOrigins = String(config.BOT_API_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allowAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes('*');

  // Simple CORS middleware to allow front-end hosted elsewhere to call the bot
  app.use((req, res, next) => {
    const requestOrigin = req.get('origin');
    if (allowAllOrigins) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-discord-token,x-api-token,x-bot-token');
    if (!allowAllOrigins && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
      if (req.method === 'OPTIONS') return res.sendStatus(403);
      return res.status(403).json({ error: 'CORS origin not allowed' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Log all incoming requests
  app.use((req, res, next) => {
    console.debug && console.debug(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  function normalizeSnowflake(value) {
    if (value === undefined || value === null) return null;
    const cleaned = String(value).trim();
    return /^\d{16,20}$/.test(cleaned) ? cleaned : null;
  }

  function extractApiToken(req) {
    const auth = (req.get('authorization') || '').trim();
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

    const headerToken = req.get('x-api-token') || req.get('x-bot-token') || null;
    if (headerToken) return headerToken;

    if (config.BOT_API_ALLOW_LEGACY_QUERY_TOKEN) {
      return req.query?.api_token || req.body?.api_token || null;
    }

    return null;
  }

  function extractFormSubmissionToken(req) {
    const auth = (req.get('authorization') || '').trim();
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return req.get('x-form-token') || null;
  }

  function requireFormSubmissionAuth(req, res, next) {
    const configuredToken = config.FORM_SUBMISSION_TOKEN;
    if (!configuredToken) return next();

    const token = extractFormSubmissionToken(req);
    if (!token || token !== configuredToken) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid form submission token' });
    }

    return next();
  }

  function buildMemberRolesPayload(guild, member) {
    const roles = member.roles.cache
      .filter(role => role.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(role => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        position: role.position,
        managed: role.managed,
        hoist: role.hoist
      }));

    return {
      guildId: guild.id,
      userId: member.id,
      username: member.user.username,
      globalName: member.user.globalName || null,
      nickname: member.nickname || null,
      roleIds: roles.map(role => role.id),
      roles
    };
  }

  function resolveApiGuildId(requestedGuildId) {
    const requested = normalizeSnowflake(requestedGuildId);
    const enforced = normalizeSnowflake(config.BOT_API_ENFORCED_GUILD_ID);

    if (enforced && requested && requested !== enforced) {
      return { error: 'Requested guildId does not match configured API guild', status: 403 };
    }

    const guildId = enforced || requested;
    if (!guildId) {
      return { error: 'guildId is required', status: 400 };
    }

    return { guildId, enforced: !!enforced };
  }

  function extractApplicantIdentity(answers) {
    let applicantDiscordId = null;
    let applicantDiscordUsername = null;

    const discordIdKeys = [
      "Enter your Discord User ID",
      "Discord User ID",
      "Discord ID",
      "User ID",
      "Applicant ID"
    ];
    const discordUsernameKeys = [
      "Enter your Discord Username (not your display name)",
      "Discord Username",
      "Discord User",
      "Username",
      "Applicant"
    ];

    for (const [key, value] of Object.entries(answers || {})) {
      if (!applicantDiscordId && discordIdKeys.some(k => k.toLowerCase() === String(key).toLowerCase())) {
        applicantDiscordId = String(value || "").trim();
      }
      if (!applicantDiscordUsername && discordUsernameKeys.some(k => k.toLowerCase() === String(key).toLowerCase())) {
        applicantDiscordUsername = String(value || "").trim();
      }
    }

    if (applicantDiscordId) {
      const idMatch = applicantDiscordId.match(/^<@!?([0-9]+)>$|^([0-9]{16,20})$/);
      applicantDiscordId = idMatch ? (idMatch[1] || idMatch[2]) : applicantDiscordId;
    }

    return { applicantDiscordId, applicantDiscordUsername };
  }

  async function resolveApplicantUser(client, channel, answers) {
    const { applicantDiscordId, applicantDiscordUsername } = extractApplicantIdentity(answers);

    if (applicantDiscordId) {
      const byId = await client.users.fetch(applicantDiscordId).catch(() => null);
      if (byId) return byId;
    }

    if (applicantDiscordUsername && channel && channel.guild) {
      const cachedMember = channel.guild.members.cache.find(m => m.user.username === applicantDiscordUsername);
      if (cachedMember) return cachedMember.user;
    }

    if (applicantDiscordUsername && channel && channel.guild) {
      const members = await channel.guild.members.fetch().catch(() => null);
      if (members) {
        const member = members.find(m => m.user.username === applicantDiscordUsername);
        if (member) return member.user;
      }
    }

    return null;
  }

  function requireBotApiAuth(req, res, next) {
    const token = extractApiToken(req);
    const preferredToken = config.BOT_API_TOKEN;
    const allowDiscordToken = !!config.BOT_API_ALLOW_DISCORD_TOKEN;
    const discordToken = process.env.DISCORD_TOKEN;

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing API token'
      });
    }

    if (preferredToken && token === preferredToken) return next();

    if (allowDiscordToken && discordToken && token === discordToken) {
      return next();
    }

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API token'
    });
  }

  /**
   * POST /form-submission
   * Receives form data from Google Apps Script and posts it to Discord
   * Expected body from Google Forms:
   * {
   *   "timestamp": "2024-01-01 12:00:00",
   *   "answers": {
   *     "Question 1": "Answer 1",
   *     "Question 2": "Answer 2"
   *   }
   * }
   */
  app.post("/form-submission", requireFormSubmissionAuth, async (req, res) => {
    console.debug && console.debug("📨 Form submission received:", req.body);
    if (!client || !client.user) {
      console.warn("Bot not ready yet - rejecting form submission");
      return res.status(503).json({ error: "Bot not ready" });
    }
    try {
      const { timestamp, answers } = req.body;

      if (!answers || typeof answers !== "object") {
        return res.status(400).json({ error: "Invalid form data: missing or invalid answers" });
      }

      // Global gate: when applications are paused, reject before posting to review channels.
      try {
        const state = await getState();
        if (state && state.pausedApplications) {
          const channelId = config.VOTING_CHANNEL_ID;
          const channel = await client.channels.fetch(channelId).catch(() => null);
          const applicantUser = await resolveApplicantUser(client, channel, answers).catch(() => null);

          if (applicantUser) {
            await applicantUser.send('Applications are currently paused by administration. Your submission was rejected and was not posted for review.').catch(() => null);
          }

          return res.status(200).json({ success: false, message: "Applications are paused" });
        }
      } catch (err) {
        console.warn('Failed to check paused state, continuing submission flow:', err);
      }

      // Anti-spam: detect low-effort and repeated-pattern application spam
      try {
        const spamCheck = analyzeSpamAnswers(answers, {
          minTotalChars: config.APPLICATION_SPAM_MIN_TOTAL_CHARS,
          minLongAnswerChars: config.APPLICATION_SPAM_MIN_LONG_ANSWER_CHARS,
          minLongAnswerCount: config.APPLICATION_SPAM_MIN_LONG_ANSWER_COUNT,
          maxShortLongAnswerRatio: config.APPLICATION_SPAM_MAX_SHORT_LONG_RATIO,
          duplicateLongAnswerThreshold: config.APPLICATION_SPAM_DUPLICATE_LONG_ANSWER_THRESHOLD,
          trustTotalCharsBypass: config.APPLICATION_SPAM_TRUST_TOTAL_CHARS_BYPASS
        });

        if (spamCheck.isSpam) {
          console.warn("Blocked application: spam filter triggered", {
            reasons: spamCheck.reasons,
            metrics: spamCheck.metrics
          });

          try {
            const channelId = config.VOTING_CHANNEL_ID;
            const channel = await client.channels.fetch(channelId).catch(() => null);
            const applicantUser = await resolveApplicantUser(client, channel, answers).catch(() => null);
            if (applicantUser) {
              await applicantUser.send('Your application was rejected by the anti-spam filter and was not posted for review. If you believe this was a mistake, please contact staff before resubmitting.').catch(() => null);
            }
          } catch (dmErr) {
            console.warn('Failed to notify applicant about spam-filter rejection:', dmErr);
          }

          return res.status(200).json({ success: false, message: "Blocked by spam filter" });
        }
      } catch (err) {
        console.warn("Spam filter check failed, continuing:", err);
      }

      // Use VOTING_CHANNEL_ID from config
      const channelId = config.VOTING_CHANNEL_ID;

      // Fetch the channel
      const channel = await client.channels.fetch(channelId).catch(err => {
        console.error(`Error fetching channel ${channelId}:`, err);
        return null;
      });
      if (!channel) {
        console.error(`Could not fetch channel ${channelId}`);
        return res.status(400).json({ error: "Invalid channel ID or channel not accessible" });
      }
      if (channel.type !== ChannelType.GuildText) {
        console.error(`Channel ${channelId} is not a GuildText channel (type=${channel.type})`);
        return res.status(400).json({ error: "Channel is not a text channel" });
      }

      // Convert answers object to fields array
      // We'll split into multiple embeds if needed. Discord embed limits: max 25 fields,
      // field name max 256 chars, value max 1024 chars. Also avoid sending messages
      // over 2000 characters by chunking fields into multiple embeds.
      const MAX_NAME_LEN = 250;
      const MAX_VALUE_LEN = 1000;

      const rawFields = Object.entries(answers).map(([question, answer]) => ({
        name: String(question).slice(0, MAX_NAME_LEN),
        value: String(answer ?? "").slice(0, MAX_VALUE_LEN),
        inline: false
      }));

        // Attempt to extract Roblox username or userId from answers
        let robloxUsername = null;
        let robloxUserId = null;
        for (const [key, value] of Object.entries(answers)) {
          if (/roblox.*username/i.test(key)) robloxUsername = value;
          if (/roblox.*user.?id/i.test(key)) robloxUserId = value;
        }

        // (suspensions mini-search moved below so username-only searches run)
        // Fallback: find a generic username field (avoid Discord username)
        if (!robloxUsername) {
          const usernameEntry = Object.entries(answers).find(([key]) => /username/i.test(key) && !/discord/i.test(key));
          if (usernameEntry) robloxUsername = usernameEntry[1];
        }

        // Block submissions based on blacklist sheet entries and DM applicant if possible
        if (robloxUsername) {
          try {
            const entry = await findBlacklistEntry({ robloxUsername, robloxUserId });
            if (entry) {
              // Found a blocking blacklist entry (temporary/permanent)
              try {
                const userToDm = await resolveApplicantUser(client, channel, answers);

                if (userToDm) {
                  const notifyMsg = `Your application was not sent, as the username "${robloxUsername}" is blacklisted. Your blacklist is ${entry.type} and ends at ${entry.endDate || '(no end date listed)'}, the reason is listed as: "${entry.reason || '(no reason provided)'}"`;
                  await userToDm.send(notifyMsg).catch(() => null);
                }
              } catch (err) {
                console.warn("Failed to DM blacklisted applicant:", err);
              }

              console.warn(`Blocked application from blacklisted username: ${robloxUsername} — ${entry.type}`);
              return res.status(200).json({ success: false, message: "Blocked by blacklist" });
            }
          } catch (err) {
            console.warn('Blacklist sheet lookup failed, continuing with application flow:', err);
          }
        }

        // If only username is present, fetch userId
        if (!robloxUserId && robloxUsername) {
          try {
            const userRes = await require("axios").post(
              "https://users.roblox.com/v1/usernames/users",
              { usernames: [robloxUsername], excludeBannedUsers: true }
            );
            if (userRes.data.data[0]) robloxUserId = userRes.data.data[0].id;
          } catch (err) {
            console.warn("Failed to fetch Roblox userId for BGC", err);
          }
        }

        // Prepare BGC info
        let bgcEmbed = null;
        if (robloxUserId) {
          try {
            // Check groups
            const groupsRes = await require("axios").get(
              `https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`
            );
            const groups = groupsRes.data.data;
            // Hostile/blacklisted group IDs
            const HOSTILE = [35686873];
            const BLACKLISTED = [765802690, 16140130];
            const SGC_ID = 6762663;
            let hostileGroups = groups.filter(g => HOSTILE.includes(g.group.id));
            let blacklistedGroups = groups.filter(g => BLACKLISTED.includes(g.group.id));
            let sgc = groups.find(g => g.group.id === SGC_ID);

            // Optionally check a configured Google Sheet for matching entries
            let sheetMatches = [];
            try {
              const {
                GOOGLE_SHEET_ID,
                GOOGLE_SHEETS_API_KEY,
                GOOGLE_SHEETS_RANGE,
                GOOGLE_SERVICE_ACCOUNT_JSON,
                GOOGLE_SERVICE_ACCOUNT_PATH,
                GOOGLE_SHEET_NAME_COL,
                GOOGLE_SHEET_TYPE_COL
              } = require("../config");

              const range = GOOGLE_SHEETS_RANGE || 'Sheet1!A:C';
              let rows = [];

              if (GOOGLE_SHEET_ID && GOOGLE_SHEETS_API_KEY) {
                const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?key=${GOOGLE_SHEETS_API_KEY}`;
                const sheetRes = await require("axios").get(url);
                rows = sheetRes.data.values || [];
              } else if (GOOGLE_SHEET_ID && (GOOGLE_SERVICE_ACCOUNT_JSON || GOOGLE_SERVICE_ACCOUNT_PATH)) {
                try {
                  const { google } = require('googleapis');
                  let keyObj = null;

                  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
                    try {
                      keyObj = typeof GOOGLE_SERVICE_ACCOUNT_JSON === 'string' ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON) : GOOGLE_SERVICE_ACCOUNT_JSON;
                    } catch (e) {
                      keyObj = GOOGLE_SERVICE_ACCOUNT_JSON;
                    }
                  } else if (GOOGLE_SERVICE_ACCOUNT_PATH) {
                    const fs = require('fs');
                    const p = GOOGLE_SERVICE_ACCOUNT_PATH;
                    keyObj = JSON.parse(fs.readFileSync(p, 'utf8'));
                  }

                  if (!keyObj) throw new Error('No Google service account credentials available');

                  const jwt = new google.auth.JWT({
                    email: keyObj.client_email,
                    key: keyObj.private_key,
                    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
                  });
                  await jwt.authorize();
                  const sheets = google.sheets({ version: 'v4', auth: jwt });
                  const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
                  rows = (sheetRes && sheetRes.data && sheetRes.data.values) || [];
                } catch (err) {
                  console.warn('Google Sheets service account fetch failed:', err);
                }
              }

              const nameIndex = Number.isFinite(Number(GOOGLE_SHEET_NAME_COL)) ? Number(GOOGLE_SHEET_NAME_COL) : 0;
              const typeIndex = Number.isFinite(Number(GOOGLE_SHEET_TYPE_COL)) ? Number(GOOGLE_SHEET_TYPE_COL) : 1;

              for (const row of rows) {
                const rowStr = row.join(' | ');
                const nameCell = String(row[nameIndex] || '').trim();
                const typeCell = String(row[typeIndex] || '').trim() || 'unknown';

                const matchesName = robloxUsername && (
                  (nameCell && nameCell.toLowerCase().includes(String(robloxUsername).toLowerCase())) ||
                  String(rowStr).toLowerCase().includes(String(robloxUsername).toLowerCase())
                );
                const matchesId = robloxUserId && String(rowStr).includes(String(robloxUserId));

                if (matchesName || matchesId) {
                  const displayName = nameCell || rowStr;
                  sheetMatches.push(`${displayName} | ${typeCell}`);
                }
              }
            } catch (err) {
              console.warn("Failed to query Google Sheets for BGC:", err);
            }

            bgcEmbed = new (require("discord.js").EmbedBuilder)()
              .setTitle("Background Check")
              .setColor(0x00aff1)
              .setFooter({ text: `User ID: ${robloxUserId}` });

            if (hostileGroups.length)
              bgcEmbed.addFields({ name: "Hostile Factions", value: hostileGroups.map(g => `**${g.group.name}**\nRole: ${g.role.name}\nRank: ${g.role.rank}`).join("\n\n"), inline: false });
            if (blacklistedGroups.length)
              bgcEmbed.addFields({ name: "Blacklisted Groups", value: blacklistedGroups.map(g => `**${g.group.name}**\nRole: ${g.role.name}\nRank: ${g.role.rank}`).join("\n\n"), inline: false });
            if (sgc)
              bgcEmbed.addFields({ name: "SGC Rank", value: `Role: ${sgc.role.name}\nRank: ${sgc.role.rank}`, inline: false });
            if (!hostileGroups.length && !blacklistedGroups.length && !sgc)
              bgcEmbed.setDescription("⚠️ No hostile/blacklisted groups or SGC rank found.");

            // Add Google Sheets matches to the embed if any were found
            if (sheetMatches.length) {
              const maxShow = 5;
              const shown = sheetMatches.slice(0, maxShow).map(s => `• ${s}`).join('\n');
              const more = sheetMatches.length > maxShow ? `\n+${sheetMatches.length - maxShow} more` : '';
              bgcEmbed.addFields({ name: "⚠️ Blacklist Roster Matches", value: `${shown}${more}`, inline: false });
            }
            // account age will be added after suspensions search so it appears last

            // (suspensions mini-search moved below so username-only searches run)
          } catch (err) {
            bgcEmbed = new (require("discord.js").EmbedBuilder)()
              .setTitle("Background Check")
              .setColor(0xed4245)
              .setDescription("⚠️ Could not fetch group info.");
          }
        }

        // Mini suspensions board search (run after robloxUsername/robloxUserId are resolved)
        try {
          const BOARD_ID = (config && config.TRELLO_SUSPENSIONS_BOARD_ID) ? config.TRELLO_SUSPENSIONS_BOARD_ID : process.env.TRELLO_SUSPENSIONS_BOARD_ID;
          const TRELLO_KEY = process.env.TRELLO_KEY;
          const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
          if (BOARD_ID && TRELLO_KEY && TRELLO_TOKEN && (robloxUsername || robloxUserId)) {
            const cardsRes = await require('axios').get(`https://api.trello.com/1/boards/${BOARD_ID}/cards`, {
              params: { key: TRELLO_KEY, token: TRELLO_TOKEN, fields: 'name,desc,url,labels' }
            });
            const cards = Array.isArray(cardsRes.data) ? cardsRes.data : [];
            const qName = (String(robloxUsername || '')).toLowerCase();
            const qId = robloxUserId ? String(robloxUserId) : '';
            const matches = cards.filter(c => {
              const hay = `${String(c.name||'')}\n${String(c.desc||'')}`.toLowerCase();
              if (qName && hay.includes(qName)) return true;
              if (qId && (String(c.name||'').includes(qId) || String(c.desc||'').includes(qId))) return true;
              return false;
            });
            if (matches.length) {
              if (!bgcEmbed) {
                bgcEmbed = new EmbedBuilder().setTitle('Background Check').setColor(0x00aff1).setFooter({ text: robloxUserId ? `User ID: ${robloxUserId}` : `User: ${robloxUsername}` });
              }
              const maxShow = 6;
              const shown = matches.slice(0, maxShow).map(c => {
                const labels = Array.isArray(c.labels) ? c.labels.map(l => l.name).filter(Boolean).join(', ') : '';
                const labelPart = labels ? ` — ${labels}` : '';
                return `• [${String(c.name || 'untitled')}](${c.url})${labelPart}`;
              }).join('\n');
              const more = matches.length > maxShow ? `\n+${matches.length - maxShow} more` : '';
              const value = (shown + more).slice(0, 1000);
              bgcEmbed.addFields({ name: 'Suspensions Board Search Results', value, inline: false });
            }
          }
        } catch (err) {
          console.warn('Suspensions board mini-search failed:', err?.message || err);
        }

        // Mini arrest-log DB search (run after robloxUsername/robloxUserId are resolved)
        try {
          // If we only have a userId, try to resolve the username so DB lookups succeed
          if (!robloxUsername && robloxUserId) {
            try {
              const userInfoRes = await require('axios').get(`https://users.roblox.com/v1/users/${robloxUserId}`);
              const userInfo = userInfoRes.data || {};
              // older API uses 'name' while some responses use 'username'
              robloxUsername = userInfo.name || userInfo.username || robloxUsername;
            } catch (e) {
              // ignore resolution errors and continue — arrest lookup will simply skip
            }
          }

          if (robloxUsername) {
            const arrests = await arrestStore.getArrestsByRoblox(String(robloxUsername).trim()).catch(() => []);
            if (arrests && arrests.length) {
              if (!bgcEmbed) bgcEmbed = new EmbedBuilder().setTitle('Background Check').setColor(0x00aff1).setFooter({ text: robloxUserId ? `User ID: ${robloxUserId}` : `User: ${robloxUsername}` });
              const maxShowA = 6;
              const shownA = arrests.slice(0, maxShowA).map(a => {
                const idPart = a.id ? `ID ${a.id}` : '';
                const laws = a.charges || a.incident_summary || a.sentence || '(no laws listed)';
                return `• ${idPart} — ${String(laws).slice(0, 200)}`;
              }).join('\n');
              const moreA = arrests.length > maxShowA ? `\n+${arrests.length - maxShowA} more` : '';
              const valueA = (shownA + moreA).slice(0, 1000);
              bgcEmbed.addFields({ name: 'Arrest Log Search Results', value: valueA, inline: false });
            }
          }
        } catch (err) {
          console.warn('Arrest log mini-search failed:', err?.message || err);
        }

        // Mini active AoS search (active warrant forum posts)
        try {
          if (robloxUsername) {
            const aosMatches = await findActiveAosByUsername(client, String(robloxUsername).trim()).catch(() => []);
            if (aosMatches && aosMatches.length) {
              if (!bgcEmbed) bgcEmbed = new EmbedBuilder().setTitle('Background Check').setColor(0x00aff1).setFooter({ text: robloxUserId ? `User ID: ${robloxUserId}` : `User: ${robloxUsername}` });
              const maxShowAoS = 6;
              const shownAoS = aosMatches.slice(0, maxShowAoS).map(m => `• ${m.threadName} (${m.url})`).join('\n');
              const moreAoS = aosMatches.length > maxShowAoS ? `\n+${aosMatches.length - maxShowAoS} more` : '';
              const valueAoS = (shownAoS + moreAoS).slice(0, 1000);
              bgcEmbed.addFields({ name: 'Active AoS Matches', value: valueAoS, inline: false });
            }
          }
        } catch (err) {
          console.warn('Active AoS mini-search failed:', err?.message || err);
        }

        // Add account creation date / age as the final BGC field
        try {
          if (robloxUserId) {
            const userInfoRes = await require('axios').get(`https://users.roblox.com/v1/users/${robloxUserId}`);
            const userInfo = userInfoRes.data || {};
            if (userInfo.created) {
              const created = new Date(userInfo.created);
              const now = new Date();
              const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
              const ageYears = (ageDays / 365).toFixed(2);
              const ts = Math.floor(created.getTime() / 1000);
              if (!bgcEmbed) bgcEmbed = new EmbedBuilder().setTitle('Background Check').setColor(0x00aff1).setFooter({ text: robloxUserId ? `User ID: ${robloxUserId}` : `User: ${robloxUsername}` });
              bgcEmbed.addFields({ name: 'Account Age', value: `<t:${ts}:f> — ${ageDays} day(s) (~${ageYears} years)`, inline: false });
            }
          }
        } catch (err) {
          // ignore account age errors
        }

      // Chunk fields into groups where each embed has at most 25 fields and total
      // approx character length per embed stays under ~1800 characters to avoid
      // hitting message/content limits when rendered.
      const MAX_FIELDS_PER_EMBED = 25;
      const MAX_EMBED_CHARS = 1800;
      const fieldGroups = [];
      let currentGroup = [];
      let currentLen = 0;

      for (const f of rawFields) {
        const fLen = (f.name?.length || 0) + (f.value?.length || 0) + 4; // estimate
        if (currentGroup.length >= MAX_FIELDS_PER_EMBED || (currentLen + fLen) > MAX_EMBED_CHARS) {
          fieldGroups.push(currentGroup);
          currentGroup = [];
          currentLen = 0;
        }
        currentGroup.push(f);
        currentLen += fLen;
      }
      if (currentGroup.length > 0) fieldGroups.push(currentGroup);

      // Prevent spamming too many embeds; cap the number of embeds and note omissions
      const MAX_EMBEDS = 5;
      const omittedEmbeds = fieldGroups.length > MAX_EMBEDS ? fieldGroups.length - MAX_EMBEDS : 0;
      const groupsToSend = omittedEmbeds ? fieldGroups.slice(0, MAX_EMBEDS) : fieldGroups;

      // Prepare base embed meta
      const baseTitle = "Form Submission";
      const baseColor = 0x00aff1;
      const baseTimestamp = timestamp ? new Date(timestamp) : new Date();

      // Build embeds array from groupsToSend
      // Generate a unique application identifier (timestamp or UUID)
      const appId = timestamp ? String(timestamp) : String(Date.now());
      const embeds = groupsToSend.map((group, idx) => {
        const e = new EmbedBuilder()
          .setTitle(idx === 0 ? baseTitle : `${baseTitle} (continued ${idx})`)
          .setColor(baseColor)
          .setTimestamp(baseTimestamp)
          .addFields(group)
          .setFooter({ text: `AppID: ${appId}` });
        return e;
      });

      // If we omitted further groups, append a final note embed
      if (omittedEmbeds > 0) {
        const note = new EmbedBuilder()
          .setTitle(`${baseTitle} (truncated)`)
          .setColor(baseColor)
          .setDescription(`+${omittedEmbeds} additional parts omitted to avoid spamming.`)
          .setTimestamp(baseTimestamp);
        embeds.push(note);
      }

      // Create approve/deny buttons
      const approveButton = new ButtonBuilder()
        .setCustomId("approve")
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success);

      const denyButton = new ButtonBuilder()
        .setCustomId("deny")
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger);

      const components = [new ActionRowBuilder().addComponents(approveButton, denyButton)];

      // Send the embed parts to the channel. Attach buttons only to the first message.
      for (let i = 0; i < embeds.length; i++) {
        const payload = { embeds: [embeds[i]] };
        if (i === 0) {
          payload.components = components;
          if (bgcEmbed) payload.embeds.push(bgcEmbed);
          if (bgcEmbed) bgcEmbed.setFooter({ text: `AppID: ${appId}` });
        }
        try {
          const sent = await channel.send(payload);
          console.debug && console.debug(`Sent embed part ${i} to channel ${channelId} (message id: ${sent.id})`);
        } catch (err) {
          console.error(`Failed to send embed part ${i} to channel ${channelId}:`, err);
        }
      }
      console.info("✅ Form posted to Discord successfully.");
      res.status(200).json({ success: true, message: "Form submitted successfully" });
    } catch (error) {
      console.error("Error handling form submission:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health check endpoint
  app.get("/health", (req, res) => {
    console.debug && console.debug("✅ Health check received");
    res.status(200).json({ status: "ok" });
  });

  // Root endpoint
  app.get("/", (req, res) => {
    res.status(200).json({ message: "Discord bot form server is running" });
  });

  // --- Exam web grading endpoints ---
  const examStore = require('./exams/examStore');
  const { processGrade } = require('./exams/handleExamGrade');

  // Auth middleware: require a Discord OAuth access token from a member with the exam reviewer role
  async function requireExamAuth(req, res, next) {
    console.debug && console.debug(`requireExamAuth: x-discord-token present=${!!req.get('x-discord-token')}`);
    // Try Discord OAuth token in header 'x-discord-token'
    const discordToken = req.get('x-discord-token') || req.body?.discord_token;
    if (!discordToken) return res.status(401).json({ error: 'Unauthorized' });

    try {
      // Get user info from Discord
      const u = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${discordToken}` } });
      const user = u && u.data ? u.data : null;
      console.debug && console.debug('requireExamAuth: discord /users/@me returned', user ? { id: user.id, username: user.username } : 'no-user');
      if (!user) return res.status(401).json({ error: 'Invalid Discord token' });

      // Verify guild membership and role
      const guildId = config.EXAM_GUILD_ID;
      const requiredRole = config.EXAM_AUTH_ROLE_ID;
      if (!guildId || !requiredRole) {
        console.error('requireExamAuth: EXAM_GUILD_ID or EXAM_AUTH_ROLE_ID not configured', { EXAM_GUILD_ID: config.EXAM_GUILD_ID, EXAM_AUTH_ROLE_ID: config.EXAM_AUTH_ROLE_ID });
        return res.status(403).json({ error: 'Server not configured for role verification' });
      }
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      console.debug && console.debug('requireExamAuth: fetched guild', guild ? guild.id : null);
      if (!guild) return res.status(403).json({ error: 'Bot not in configured guild' });
      const member = await guild.members.fetch(user.id).catch(() => null);
      console.debug && console.debug('requireExamAuth: fetched member', member ? member.user.tag : null);
      if (!member) return res.status(403).json({ error: 'User not a guild member' });
      if (!member.roles.cache.has(requiredRole)) return res.status(403).json({ error: 'Insufficient role' });

      req.reviewer = { id: user.id, tag: `${user.username}#${user.discriminator}` };
      return next();
    } catch (e) {
      console.error('Exam auth failed:', e?.response?.data || e.message || e);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  app.get('/exams/pending', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`GET /exams/pending requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      const listAll = await examStore.listActiveSessions();
      const list = (listAll || []).map(s => ({ id: s.id, examId: s.examId, userId: s.userId, username: s.username || null, createdAt: s.createdAt, status: s.status }));
      res.json(list);
    } catch (e) {
      console.error('Failed to list pending exams:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/exams/:id', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`GET /exams/${req.params.id} requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      console.debug && console.debug('Incoming request headers:', { authorization: req.get('authorization') ? 'present' : 'missing', x_discord_token: !!req.get('x-discord-token') });
      const s = await examStore.getSessionById(req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found' });
      res.json(s);
    } catch (e) {
      console.error('Failed to fetch exam session:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/exams/:id/grade', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`POST /exams/${req.params.id}/grade requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      console.debug && console.debug('Grade payload preview:', { scoresLength: Array.isArray(req.body?.scores) ? req.body.scores.length : 0, feedbackLen: (req.body?.feedback || '').length });
      const s = await examStore.getSessionById(req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found' });
      const { scores = [], feedback = '' } = req.body || {};
      const reviewerTag = req.reviewer ? req.reviewer.tag || (`web:${req.reviewer.id || 'unknown'}`) : 'web';
      await processGrade({ sessionId: s.id, scores, feedback, reviewerTag, client });
      res.json({ ok: true });
    } catch (e) {
      console.error('Failed to process grade via web:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- API-prefixed aliases for front-end callers that use /api/exams/... ---
  app.get('/api/exams/pending', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`GET /api/exams/pending requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      const listAll = await examStore.listActiveSessions();
      const list = (listAll || []).map(s => ({ id: s.id, examId: s.examId, userId: s.userId, username: s.username || null, createdAt: s.createdAt, status: s.status }));
      res.json(list);
    } catch (e) {
      console.error('Failed to list pending exams (api):', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/exams/:id', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`GET /api/exams/${req.params.id} requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      console.debug && console.debug('Incoming request headers (api):', { authorization: req.get('authorization') ? 'present' : 'missing', x_discord_token: !!req.get('x-discord-token') });
      const s = await examStore.getSessionById(req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found' });
      res.json(s);
    } catch (e) {
      console.error('Failed to fetch exam session (api):', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/exams/:id/grade', requireExamAuth, async (req, res) => {
    try {
      console.info && console.info(`POST /api/exams/${req.params.id}/grade requested by reviewer=${req.reviewer ? req.reviewer.tag : 'unknown'}`);
      console.debug && console.debug('Grade payload preview (api):', { scoresLength: Array.isArray(req.body?.scores) ? req.body.scores.length : 0, feedbackLen: (req.body?.feedback || '').length });
      const s = await examStore.getSessionById(req.params.id);
      if (!s) return res.status(404).json({ error: 'Not found' });
      const { scores = [], feedback = '' } = req.body || {};
      const reviewerTag = req.reviewer ? req.reviewer.tag || (`web:${req.reviewer.id || 'unknown'}`) : 'web';
      await processGrade({ sessionId: s.id, scores, feedback, reviewerTag, client });
      res.json({ ok: true });
    } catch (e) {
      console.error('Failed to process grade via web (api):', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- AoS website endpoints ---
  app.get('/api/aos/active', requireExamAuth, async (req, res) => {
    try {
      if (!aosActiveStore.isEnabled()) {
        return res.status(503).json({ error: 'AoS store is unavailable (DATABASE_URL not configured).' });
      }

      const list = await aosActiveStore.listActiveAosRows();
      res.json({
        count: list.length,
        items: list.map(item => ({
          threadId: item.threadId,
          guildId: item.guildId,
          forumChannelId: item.forumChannelId,
          threadName: item.threadName,
          url: item.url,
          submitter: item.submitter,
          username: item.username,
          profile: item.profile,
          victims: item.victims,
          charges: item.charges,
          summary: item.summary,
          proof: item.proof,
          tags: Array.isArray(item.tags) ? item.tags : [],
          calculatedTimeMinutes: item.calculatedTimeMinutes,
          jailMinutes: item.jailMinutes,
          postedByBot: !!item.postedByBot,
          createdAt: item.createdAt,
          activatedAt: item.activatedAt,
          lastSeenAt: item.lastSeenAt
        }))
      });
    } catch (err) {
      console.error('Failed to list active AoS rows for web:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/aos/:threadId', requireExamAuth, async (req, res) => {
    try {
      if (!aosActiveStore.isEnabled()) {
        return res.status(503).json({ error: 'AoS store is unavailable (DATABASE_URL not configured).' });
      }

      const threadId = String(req.params.threadId || '').trim();
      if (!/^\d{16,20}$/.test(threadId)) {
        return res.status(400).json({ error: 'Invalid threadId' });
      }

      const all = await aosActiveStore.listActiveAosRows();
      const row = all.find(item => String(item.threadId) === threadId);
      if (!row) return res.status(404).json({ error: 'Not found' });

      if (row.postedByBot) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Bot-posted AoS records can only be removed by /aos complete in Discord.'
        });
      }

      const removed = await aosActiveStore.removeLegacyAosByThreadId(threadId);
      if (!removed) return res.status(409).json({ error: 'Unable to remove row' });
      return res.json({ ok: true, removed: { threadId } });
    } catch (err) {
      console.error('Failed to remove legacy AoS row:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // --- Website role lookup endpoints ---
  // Preferred auth: BOT_API_TOKEN via Authorization: Bearer <token> or x-api-token header.
  // Compatibility mode: set BOT_API_ALLOW_DISCORD_TOKEN=true to allow DISCORD_TOKEN as auth.
  app.get('/api/guilds/:guildId/members/:userId/roles', requireBotApiAuth, async (req, res) => {
    try {
      const resolved = resolveApiGuildId(req.params.guildId);
      if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
      const guildId = resolved.guildId;
      const userId = normalizeSnowflake(req.params.userId);

      if (!userId) return res.status(400).json({ error: 'userId must be a valid Discord ID' });

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return res.status(404).json({ error: 'Guild not found or bot is not in guild' });

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'Member not found in guild' });

      res.json(buildMemberRolesPayload(guild, member));
    } catch (e) {
      console.error('Failed to resolve member roles:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Simplified endpoint: provide userId in path and guildId via query.
  app.get('/api/guild-members/:userId/roles', requireBotApiAuth, async (req, res) => {
    try {
      const resolved = resolveApiGuildId(req.query.guildId);
      if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
      const guildId = resolved.guildId;
      const userId = normalizeSnowflake(req.params.userId);

      if (!userId) return res.status(400).json({ error: 'userId must be a valid Discord ID' });

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return res.status(404).json({ error: 'Guild not found or bot is not in guild' });

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'Member not found in guild' });

      res.json(buildMemberRolesPayload(guild, member));
    } catch (e) {
      console.error('Failed to resolve member roles via simplified route:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Bulk lookup endpoint for website-side role checks on multiple users.
  app.post('/api/guilds/:guildId/members/roles', requireBotApiAuth, async (req, res) => {
    try {
      const resolved = resolveApiGuildId(req.params.guildId);
      if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
      const guildId = resolved.guildId;
      const userIdsRaw = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      const userIds = userIdsRaw.map(normalizeSnowflake).filter(Boolean);

      if (!userIds.length) return res.status(400).json({ error: 'userIds must be a non-empty array of Discord IDs' });
      if (userIds.length > 100) return res.status(400).json({ error: 'Maximum 100 userIds per request' });

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return res.status(404).json({ error: 'Guild not found or bot is not in guild' });

      const results = await Promise.all(userIds.map(async (userId) => {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return { userId, found: false, roleIds: [], roles: [] };
        const payload = buildMemberRolesPayload(guild, member);
        return { ...payload, found: true };
      }));

      res.json({ guildId, count: results.length, results });
    } catch (e) {
      console.error('Failed bulk member role lookup:', e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Debug helper page served by the bot so you can open the bot's origin and test
  // behavior without relying on the external static site. Use: /debug/grade.html?session=<id>
  app.get('/debug/grade.html', (req, res) => {
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Exam debug grader</title></head>
<body>
<h2>Exam debug grader</h2>
<div id="out">Loading...</div>
<script>
const qs = new URLSearchParams(location.search);
const id = qs.get('session');
if (!id) { document.getElementById('out').innerText = 'Missing session query param'; }
else {
  fetch('/api/exams/' + encodeURIComponent(id), { credentials: 'include' })
    .then(r => r.ok ? r.json() : r.text().then(t => { throw new Error('HTTP ' + r.status + '\n' + t); }))
    .then(s => {
      document.getElementById('out').innerText = JSON.stringify(s, null, 2);
    }).catch(e => { document.getElementById('out').innerText = 'Error: ' + e.message; });
}
</script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildOAuthResultPage({ title, message, statusLabel }) {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const safeStatusLabel = escapeHtml(statusLabel || 'Verification');
    const homeBase = String(config.EXAM_WEB_BASE_URL || 'https://agent-os.team').trim().replace(/\/+$/, '');
    const homeUrl = `${homeBase}/`;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0b0b;
      --fg: #ffffff;
      --muted: #8b8b8b;
      --primary: #00aff1;
      --accent: #f5d77a;
      --panel-border: rgba(255, 255, 255, 0.08);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: radial-gradient(circle at 20% 15%, rgba(0, 175, 241, 0.14), transparent 40%), var(--bg);
      color: var(--fg);
      display: grid;
      place-items: center;
      padding: 20px;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      width: min(560px, 100%);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
      border: 1px solid var(--panel-border);
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
    }
    .status {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4.2vw, 40px);
      line-height: 1.08;
    }
    p {
      margin: 12px 0 0;
      color: var(--muted);
      line-height: 1.6;
      font-size: 16px;
    }
    .actions {
      margin-top: 22px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      padding: 11px 16px;
      border-radius: 8px;
      border: 0;
      text-decoration: none;
      font-weight: 700;
      transition: filter 0.18s ease, transform 0.18s ease;
    }
    .btn-primary {
      background: var(--primary);
      color: #000;
    }
    .btn-primary:hover,
    .btn-primary:focus {
      color: var(--fg);
      filter: brightness(0.95);
      transform: translateY(-1px);
      outline: none;
    }
    .meta {
      margin-top: 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .meta strong {
      color: var(--accent);
      font-weight: 600;
    }
    @media (max-width: 700px) {
      .panel { padding: 20px; border-radius: 12px; }
      .actions { width: 100%; }
      .btn { width: 100%; text-align: center; }
    }
  </style>
</head>
<body>
  <main class="panel" role="main" aria-live="polite">
    <div class="status">${safeStatusLabel}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <div class="actions">
      <a class="btn btn-primary" href="${homeUrl}">Go to Home Page</a>
    </div>
    <div class="meta">To return to Discord, just <strong>close this tab</strong>.</div>
  </main>
</body>
</html>`;
  }


  // OAuth callback for Roblox verification
  // Expects query params: code, state
  app.get('/oauth/roblox/callback', async (req, res) => {
    try {
      const { code, state } = req.query || {};
      if (!code || !state) {
        return res.status(400).send(buildOAuthResultPage({
          title: 'Verification failed',
          message: 'Missing code or state. Please restart verification from Discord.',
          statusLabel: 'Error'
        }));
      }

      // Find matching challenge by the stored state code
      const challenge = await verificationStore.getChallengeByCode(String(state));
      if (!challenge) {
        return res.status(400).send(buildOAuthResultPage({
          title: 'Verification expired',
          message: 'This verification session is invalid or expired. Run /agentos-verify again in Discord.',
          statusLabel: 'Expired'
        }));
      }

      // Exchange code for access token
      const tokenUrl = 'https://apis.roblox.com/oauth/v1/token';
      const clientId = config.ROBLOX_OAUTH_CLIENT_ID;
      const clientSecret = config.ROBLOX_OAUTH_CLIENT_SECRET;
      const redirectUri = config.ROBLOX_OAUTH_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) {
        return res.status(500).send(buildOAuthResultPage({
          title: 'Verification unavailable',
          message: 'OAuth is not configured right now. Please contact a bot administrator.',
          statusLabel: 'Setup issue'
        }));
      }

      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', String(code));
      params.append('redirect_uri', redirectUri);
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);

      const tokenRes = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }).catch(e => ({ error: e }));

      if (!tokenRes || tokenRes.error || !tokenRes.data || !tokenRes.data.access_token) {
        console.warn('Roblox token exchange failed', tokenRes && tokenRes.error ? tokenRes.error : tokenRes.data);
        return res.status(500).send(buildOAuthResultPage({
          title: 'Verification failed',
          message: 'Failed to exchange the OAuth code. Please run /agentos-verify again.',
          statusLabel: 'OAuth error'
        }));
      }

      const accessToken = tokenRes.data.access_token;

      // Fetch userinfo from Roblox
      const userInfoUrl = 'https://apis.roblox.com/oauth/v1/userinfo';
      const userInfoRes = await axios.get(userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } }).catch(e => ({ error: e }));
      if (!userInfoRes || userInfoRes.error || !userInfoRes.data) {
        console.warn('Roblox userinfo fetch failed', userInfoRes && userInfoRes.error ? userInfoRes.error : userInfoRes.data);
        return res.status(500).send(buildOAuthResultPage({
          title: 'Verification failed',
          message: 'Could not fetch Roblox account details. Please try again shortly.',
          statusLabel: 'Roblox error'
        }));
      }

      // Attempt to extract a Roblox user id from the response
      const info = userInfoRes.data || {};
      const robloxId = info.user_id || info.sub || info.id || info.roblox_userid || info.robloxId || null;
      const robloxUsername = info.preferred_username || info.username || challenge.roblox_username;

      if (!robloxId) {
        console.warn('Roblox user id not found in userinfo response', info);
        return res.status(500).send(buildOAuthResultPage({
          title: 'Verification failed',
          message: 'Could not determine the Roblox account from OAuth response.',
          statusLabel: 'Roblox error'
        }));
      }

      // Verify that the OAuth-authenticated account matches the requested username/userid
      if (challenge.roblox_userid && String(challenge.roblox_userid) !== String(robloxId)) {
        console.warn('OAuth returned different Roblox id than requested', { expected: challenge.roblox_userid, got: robloxId });
        return res.status(400).send(buildOAuthResultPage({
          title: 'Wrong Roblox account',
          message: 'The authenticated Roblox account does not match the username you selected in Discord.',
          statusLabel: 'Account mismatch'
        }));
      }

      // Persist verification (replaces any previous link for this Discord or Roblox account)
      let verification;
      try {
        verification = await verificationStore.addVerification(robloxUsername || challenge.roblox_username, robloxId, challenge.discord_id);
      } catch (err) {
        console.error('Failed to add verification record:', err);
        // clear the challenge regardless
        await verificationStore.clearChallengeByCode(String(state)).catch(() => null);
        return res.status(500).send(buildOAuthResultPage({
          title: 'Verification failed',
          message: 'Failed to save the verification. Please run /agentos-verify again.',
          statusLabel: 'Database error'
        }));
      }

      // Clear the challenge
      await verificationStore.clearChallengeByCode(String(state)).catch(() => null);

      // Notify the user via DM if possible
      try {
        const user = await client.users.fetch(challenge.discord_id).catch(() => null);
        if (user) {
          const previous = verification && verification.previous_roblox_username;
          const relinkNote = previous && previous !== verification.roblox_username ? ` (previously linked as ${previous})` : '';
          await user.send({ content: `✅ Your Discord account has been verified and linked to Roblox account ${robloxUsername || ''} (ID ${robloxId})${relinkNote}.` }).catch(() => null);
        }
      } catch (err) {
        console.warn('Failed to DM user after verification:', err);
      }

      // Render success page
      return res.status(200).send(buildOAuthResultPage({
        title: 'Verification complete',
        message: 'Your Roblox account is now linked to Discord.',
        statusLabel: 'Success'
      }));
    } catch (err) {
      console.error('Unhandled error in OAuth callback:', err);
      return res.status(500).send(buildOAuthResultPage({
        title: 'Internal server error',
        message: 'An unexpected error occurred while finishing verification.',
        statusLabel: 'Server error'
      }));
    }
  });
  // Catch-all 404 handler (must be after all routes)
  app.use((req, res) => {
    console.warn(`⚠️ 404: ${req.method} ${req.path} - route not found`);
    res.status(404).json({ error: "Route not found" });
  });

  return app;
}

module.exports = { createFormServer };
