const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const config = require('../config');
const { getByDiscord, refreshUsername } = require('../utils/verificationStore');

function colIndexToLetter(index) {
  let s = '';
  index++; // 1-based
  while (index > 0) {
    const rem = (index - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    index = Math.floor((index - 1) / 26);
  }
  return s;
}

function parseRange(range) {
  const m = String(range || '').match(/^([^!]+)!\s*([A-Z]+)(\d+):([A-Z]+)(\d+)?$/i);
  if (!m) return null;
  return {
    sheetName: m[1],
    startCol: m[2].toUpperCase(),
    startRow: Number(m[3]),
    endCol: m[4].toUpperCase(),
    endRow: m[5] ? Number(m[5]) : undefined
  };
}

function findRowIndex(rows, nameCol, username) {
  const target = String(username).toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const cell = String(row[nameCol] || '').trim();
    const rowStr = (row || []).join(' | ');
    if (!cell && !rowStr) continue;
    if (cell && cell.toLowerCase() === target) return i;
    if (String(rowStr).toLowerCase().includes(target)) return i;
  }
  return -1;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('Modify verified users points on the configured Google Sheet')
    .addStringOption(o =>
      o.setName('operation')
       .setDescription('Operation to perform')
       .setRequired(true)
       .addChoices(
         { name: 'Add', value: 'add' },
         { name: 'Subtract', value: 'subtract' },
         { name: 'Set', value: 'set' }
       )
    )
    .addStringOption(o =>
      o
        .setName('users')
        .setDescription('Mention one or more Discord users (example: @user1 @user2)')
        .setRequired(true)
    )
    .addIntegerOption(o => o.setName('amount').setDescription('Amount/value').setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // Restrict to the same approver role used for case approvals
    try {
      const requiredRoles = Array.isArray(config.REQUIRED_ROLE_IDS_LIST)
        ? config.REQUIRED_ROLE_IDS_LIST
        : String(config.REQUIRED_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
      const hasRequiredRole = requiredRoles.some(roleId => interaction.member.roles.cache.has(roleId));
      if (!hasRequiredRole) {
        await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true });
        return;
      }
    } catch (err) {
      try { await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true }); } catch (e) {}
      return;
    }

    const operation = interaction.options.getString('operation');
    const usersInput = interaction.options.getString('users');
    const amount = interaction.options.getInteger('amount');

    const mentionIds = Array.from(new Set((String(usersInput).match(/<@!?(\d+)>/g) || [])
      .map((mention) => mention.match(/\d+/)[0])));

    if (!mentionIds.length) {
      const invalidEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Points Update Failed')
        .setDescription('No valid user mentions were provided. Mention users like @user1 @user2.');
      return interaction.editReply({ embeds: [invalidEmbed] });
    }

    const RANGE = config.TIME_LOG_SHEET_RANGE;
    const NAME_COL = Number.isFinite(Number(config.TIME_LOG_NAME_COL)) ? Number(config.TIME_LOG_NAME_COL) : 0;
    const POINTS_COL = Number.isFinite(Number(config.POINTS_POINTS_COL)) ? Number(config.POINTS_POINTS_COL) : Number(config.TIME_LOG_MINUTES_COL || 1);

    if (!RANGE) return interaction.editReply('Google sheet range not configured (set POINTS_SHEET_RANGE or TIME_LOG_SHEET_RANGE).');
    if (!config.GOOGLE_SHEET_ID) return interaction.editReply('GOOGLE_SHEET_ID not configured.');

    const keyObj = config.GOOGLE_SERVICE_ACCOUNT_JSON;
    const keyPath = config.GOOGLE_SERVICE_ACCOUNT_PATH;
    if (!keyObj && !keyPath) return interaction.editReply('Service account credentials not configured (set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_PATH).');

    let creds = keyObj;
    if (!creds && keyPath) {
      try { creds = require('fs').readFileSync(keyPath, 'utf8'); creds = JSON.parse(creds); } catch (e) { return interaction.editReply('Failed to read service account JSON from path: ' + e.message); }
    }

    const jwt = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    try {
      await jwt.authorize();
      const sheets = google.sheets({ version: 'v4', auth: jwt });

      const fetchRes = await sheets.spreadsheets.values.get({ spreadsheetId: config.GOOGLE_SHEET_ID, range: RANGE });
      const rows = (fetchRes.data && fetchRes.data.values) || [];
      if (!rows.length) return interaction.editReply('No rows found in configured range.');

      const parsed = parseRange(RANGE);
      if (!parsed) return interaction.editReply('Configured range is not in an expected A1 format like Sheet1!A4:K1000.');

      function letterToIndex(lett) { let n = 0; for (let ch of lett) { n = n*26 + (ch.charCodeAt(0)-64); } return n-1; }
      const startColIndex = letterToIndex(parsed.startCol);
      const targetColIndex = startColIndex + POINTS_COL;
      const targetColLetter = colIndexToLetter(targetColIndex);

      const succeeded = [];
      const notVerified = [];
      const notFoundInSheet = [];
      const failed = [];

      for (const discordId of mentionIds) {
        const mentionTag = `<@${discordId}>`;
        let verification;
        try {
          verification = await getByDiscord(discordId);
        } catch (verificationErr) {
          failed.push(`${mentionTag}: verification lookup failed (${verificationErr.message || String(verificationErr)})`);
          continue;
        }

        if (!verification || !verification.roblox_username) {
          notVerified.push(mentionTag);
          continue;
        }

        let username = String(verification.roblox_username).trim();
        let foundIdx = findRowIndex(rows, NAME_COL, username);

        // The stored username may be stale if the user renamed on Roblox after verifying
        if (foundIdx === -1) {
          const refreshed = await refreshUsername(verification).catch(() => verification);
          const refreshedName = String((refreshed && refreshed.roblox_username) || '').trim();
          if (refreshedName && refreshedName.toLowerCase() !== username.toLowerCase()) {
            username = refreshedName;
            foundIdx = findRowIndex(rows, NAME_COL, username);
          }
        }

        if (foundIdx === -1) {
          notFoundInSheet.push(`${mentionTag} -> ${username}`);
          continue;
        }

        const targetRow = foundIdx; // 0-based within fetched range
        const currentValRaw = String((rows[targetRow] || [])[POINTS_COL] || '').trim();
        const currentVal = currentValRaw === '' ? 0 : Number(currentValRaw) || 0;

        let newVal;
        if (operation === 'add') newVal = currentVal + amount;
        else if (operation === 'subtract') newVal = currentVal - amount;
        else newVal = amount;

        const targetRowNumber = parsed.startRow + targetRow; // 1-based
        const targetA1 = `${parsed.sheetName}!${targetColLetter}${targetRowNumber}`;

        try {
          await sheets.spreadsheets.values.update({ spreadsheetId: config.GOOGLE_SHEET_ID, range: targetA1, valueInputOption: 'RAW', requestBody: { values: [[String(newVal)]] } });
          rows[targetRow][POINTS_COL] = String(newVal);
          succeeded.push(`${mentionTag} -> ${username}: ${currentVal} -> ${newVal}`);
        } catch (updateErr) {
          failed.push(`${mentionTag} -> ${username}: ${updateErr.message || String(updateErr)}`);
        }
      }

      const total = mentionIds.length;
      const successCount = succeeded.length;
      const summary = `${successCount}/${total} successful`;

      const resultEmbed = new EmbedBuilder()
        .setTitle('Points Update Results')
        .setColor(successCount === total ? 0x57f287 : (successCount > 0 ? 0xfee75c : 0xed4245))
        .setDescription(`${summary}. Operation: ${operation}. Amount: ${amount}.`)
        .addFields(
          { name: 'Successful', value: succeeded.length ? succeeded.join('\n').slice(0, 1024) : 'None', inline: false },
          { name: 'Not Verified', value: notVerified.length ? notVerified.join(', ').slice(0, 1024) : 'None', inline: false },
          { name: 'Verified But Not Found In Sheet', value: notFoundInSheet.length ? notFoundInSheet.join('\n').slice(0, 1024) : 'None', inline: false },
          { name: 'Failed', value: failed.length ? failed.join('\n').slice(0, 1024) : 'None', inline: false }
        );

      return interaction.editReply({ embeds: [resultEmbed] });
    } catch (err) {
      console.error('points command failed:', err);
      const failedEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Points Update Failed')
        .setDescription('Failed to update sheet: ' + (err.message || String(err)));
      return interaction.editReply({ embeds: [failedEmbed] });
    }
  }
};
