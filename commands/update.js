const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { google } = require('googleapis');
const axios = require('axios');
const { isCooling, addCooldown, clearExpired } = require('../utils/updateStore');
const { getState } = require('../utils/adminState');

function colLetterToIndex(letter) {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 65 + 1);
  }
  return index - 1;
}

function indexToColLetter(index) {
  let s = '';
  while (index >= 0) {
    s = String.fromCharCode(65 + (index % 26)) + s;
    index = Math.floor(index / 26) - 1;
  }
  return s;
}

function parseRange(range) {
  const m = range.match(/^([^!]+)!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/);
  if (!m) return null;
  return { sheetName: m[1], startCol: m[2], startRow: Number(m[3]) };
}

function stripLeadingApostrophe(s) {
  if (s === undefined || s === null) return s;
  return String(s).replace(/^[\u0027\u2018\u2019]+/, '');
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription("Update a user's SGC rank on the sheet from Roblox")
    .setDMPermission(false)
    .addStringOption(option =>
       option
       .setName('username')
       .setDescription('Roblox username to update')
       .setRequired(true)
       .setMinLength(3)
       .setMaxLength(20)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const roblox = String(interaction.options.getString('username') || '').trim();
    if (!roblox) return interaction.editReply({ content: 'Provide a Roblox username.', ephemeral: true });

    // Clear expired cooldowns
    try { await clearExpired(); } catch (e) { /* ignore */ }

    // Respect admin debug mode to bypass cooldown
    try {
      const state = await getState();
      if (!state.debugMode) {
        const cooling = await isCooling(roblox.toLowerCase());
        if (cooling) return interaction.editReply({ content: `${roblox} is on cooldown. Try again in a bit.`, ephemeral: true });
        // add cooldown for 1 minute
        const expires = new Date(Date.now() + 60 * 1000);
        await addCooldown(roblox.toLowerCase(), expires);
      }
    } catch (err) {
      console.error('Cooldown check failed:', err);
      return interaction.editReply({ content: 'Internal error checking cooldowns.', ephemeral: true });
    }

    try {
      // Resolve Roblox userId
      let robloxUserId = null;
      try {
        const res = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [roblox], excludeBannedUsers: true });
        if (res.data && res.data.data && res.data.data[0]) robloxUserId = res.data.data[0].id;
      } catch (err) {
        console.warn('Failed to fetch Roblox user id:', err?.response?.data || err.message || err);
      }
      if (!robloxUserId) return interaction.editReply({ content: `Could not resolve Roblox user: ${roblox}`, ephemeral: true });

      // Fetch group roles for user
      let sgcRole = null;
      try {
        const gres = await axios.get(`https://groups.roblox.com/v2/users/${robloxUserId}/groups/roles`);
        const groups = gres.data && gres.data.data ? gres.data.data : [];
        const sgc = groups.find(g => Number(g.group.id) === Number(config.TIME_SGC_GROUP_ID));
        if (sgc && sgc.role) sgcRole = sgc.role.name || String(sgc.role.rank || '');
      } catch (err) {
        console.warn('Failed to fetch Roblox groups:', err?.response?.data || err.message || err);
      }
      if (!sgcRole) return interaction.editReply({ content: `Could not determine SGC rank for ${roblox}.`, ephemeral: true });

      // Find user row in sheet
      if (!config.GOOGLE_SHEET_ID) return interaction.editReply({ content: 'Google sheet not configured.', ephemeral: true });
      const range = config.TIME_LOG_SHEET_RANGE;
      const parsed = parseRange(range);
      if (!parsed) return interaction.editReply({ content: 'TIME_LOG_SHEET_RANGE format unsupported.', ephemeral: true });

      const sheets = await getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.GOOGLE_SHEET_ID, range });
      const rows = resp.data.values || [];

      let foundIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cellNameRaw = (row[config.TIME_LOG_NAME_COL] || '').toString();
        const cellName = stripLeadingApostrophe(cellNameRaw).trim();
        if (cellName && cellName.toLowerCase() === roblox.toLowerCase()) { foundIndex = i; break; }
      }
      if (foundIndex === -1) return interaction.editReply({ content: `Username ${roblox} not found on the sheet.`, ephemeral: true });

      // Compute A1 for SGC rank cell
      const startColIndex = colLetterToIndex(parsed.startCol);
      const targetColIndex = startColIndex + (Number.isFinite(Number(config.TIME_LOG_SGC_RANK_COL)) ? Number(config.TIME_LOG_SGC_RANK_COL) : config.TIME_LOG_SGC_RANK_COL);
      const targetColLetter = indexToColLetter(targetColIndex);
      const targetRowNumber = parsed.startRow + foundIndex;
      const targetA1 = `${parsed.sheetName}!${targetColLetter}${targetRowNumber}`;

      // Write the SGC rank (role name) to the sheet
      try { console.debug && console.debug('Updating SGC rank for', roblox, '->', sgcRole, 'cell', targetA1); } catch (e) {}
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.GOOGLE_SHEET_ID,
        range: targetA1,
        valueInputOption: 'RAW',
        resource: { values: [[sgcRole]] }
      });

      return interaction.editReply({ content: `Updated ${roblox}'s SGC rank to **${sgcRole}** on the sheet (cell ${targetA1}).`, ephemeral: true });
    } catch (err) {
      console.error('update command error:', err);
      return interaction.editReply({ content: 'Failed to update SGC rank due to an error.', ephemeral: true });
    }
  }
};
