const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { google } = require('googleapis');
const config = require('../config');
const { getByDiscord, refreshUsername } = require('../utils/verification/verificationStore');

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

function readMinutes(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('time')
    .setDescription('Modify verified users time on the configured Google Sheet')
    .setDMPermission(false)
    .addStringOption(option =>
      option.setName('operation')
        .setDescription('Operation to perform')
        .setRequired(true)
        .addChoices(
          { name: 'Add', value: 'add' },
          { name: 'Subtract', value: 'subtract' },
          { name: 'Set weekly time', value: 'set' }
        )
    )
    .addStringOption(option =>
      option.setName('users')
        .setDescription('Mention one or more Discord users (example: @user1 @user2)')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of time in minutes')
        .setRequired(true)
        .setMinValue(0)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const aethzor = interaction.user.id === '1070746204239040582'
      && interaction.guildId === '1540828031864803410';
    if (!aethzor) {
      // Restrict to the same approver role used for case approvals
      try {
        const requiredRoles = Array.isArray(config.REQUIRED_ROLE_IDS_LIST)
          ? config.REQUIRED_ROLE_IDS_LIST
          : String(config.REQUIRED_ROLE_ID || '').split(',').map(roleId => roleId.trim()).filter(Boolean);
        const hasRequiredRole = requiredRoles.some(roleId => interaction.member.roles.cache.has(roleId));
        if (!hasRequiredRole) {
          await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true });
          return;
        }
      } catch (err) {
        try { await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true }); } catch (e) {}
        return;
      }
    }

    const operation = interaction.options.getString('operation');
    const usersInput = interaction.options.getString('users');
    const amount = interaction.options.getInteger('amount');
    const mentionIds = Array.from(new Set(
      (String(usersInput).match(/<@!?(\d+)>/g) || []).map(mention => mention.match(/\d+/)[0])
    ));

    if (!mentionIds.length) {
      const invalidEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Time Update Failed')
        .setDescription('No valid user mentions were provided. Mention users like @user1 @user2.');
      return interaction.editReply({ embeds: [invalidEmbed] });
    }

    if (!config.GOOGLE_SHEET_ID) {
      return interaction.editReply('GOOGLE_SHEET_ID not configured.');
    }

    let credentials = config.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credentials && config.GOOGLE_SERVICE_ACCOUNT_PATH) {
      try {
        credentials = JSON.parse(require('fs').readFileSync(config.GOOGLE_SERVICE_ACCOUNT_PATH, 'utf8'));
      } catch (err) {
        return interaction.editReply('Failed to read service account JSON from path: ' + err.message);
      }
    }
    if (!credentials) {
      return interaction.editReply('Service account credentials not configured (set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_PATH).');
    }

    const jwt = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    try {
      await jwt.authorize();
      const sheets = google.sheets({ version: 'v4', auth: jwt });
      const quotedSheetName = "'Master'";
      const range = `${quotedSheetName}!A4:L`;
      const fetchRes = await sheets.spreadsheets.values.get({
        spreadsheetId: config.GOOGLE_SHEET_ID,
        range
      });
      const rows = (fetchRes.data && fetchRes.data.values) || [];
      if (!rows.length) {
        return interaction.editReply('No rows found in configured range.');
      }

      const succeeded = [];
      const notVerified = [];
      const notFoundInSheet = [];
      const failed = [];

      for (const discordId of mentionIds) {
        const mentionTag = `<@${discordId}>`;
        let verification;
        try {
          verification = await getByDiscord(discordId);
        } catch (err) {
          failed.push(`${mentionTag}: verification lookup failed (${err.message || String(err)})`);
          continue;
        }

        if (!verification || !verification.roblox_username) {
          notVerified.push(mentionTag);
          continue;
        }

        let username = String(verification.roblox_username).trim();
        let rowIndex = findRowIndex(rows, 0, username);
        if (rowIndex === -1) {
          const refreshed = await refreshUsername(verification).catch(() => verification);
          const refreshedUsername = String((refreshed && refreshed.roblox_username) || '').trim();
          if (refreshedUsername && refreshedUsername.toLowerCase() !== username.toLowerCase()) {
            username = refreshedUsername;
            rowIndex = findRowIndex(rows, 0, username);
          }
        }

        if (rowIndex === -1) {
          notFoundInSheet.push(`${mentionTag} -> ${username}`);
          continue;
        }

        const row = rows[rowIndex] || [];
        const currentWeekly = readMinutes(row[10]);
        const currentTotal = readMinutes(row[11]);
        if (currentWeekly === null || currentTotal === null) {
          failed.push(`${mentionTag} -> ${username}: weekly or total time in the sheet is not a valid non-negative number.`);
          continue;
        }

        let newWeekly;
        let newTotal;
        if (operation === 'add') {
          newWeekly = currentWeekly + amount;
          newTotal = currentTotal + amount;
        } else if (operation === 'subtract') {
          newWeekly = currentWeekly - amount;
          newTotal = currentTotal - amount;
        } else {
          newWeekly = amount;
          newTotal = currentTotal + (newWeekly - currentWeekly);
        }

        if (newWeekly < 0 || newTotal < 0) {
          failed.push(`${mentionTag} -> ${username}: this change would make weekly or total time negative.`);
          continue;
        }

        const sheetRow = rowIndex + 4;
        try {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: config.GOOGLE_SHEET_ID,
            requestBody: {
              valueInputOption: 'RAW',
              data: [
                { range: `${quotedSheetName}!K${sheetRow}`, values: [[String(newWeekly)]] },
                { range: `${quotedSheetName}!L${sheetRow}`, values: [[String(newTotal)]] }
              ]
            }
          });
          rows[rowIndex][10] = String(newWeekly);
          rows[rowIndex][11] = String(newTotal);
          succeeded.push(`${mentionTag} -> ${username}: weekly ${currentWeekly} -> ${newWeekly}, total ${currentTotal} -> ${newTotal} minutes`);
        } catch (err) {
          failed.push(`${mentionTag} -> ${username}: ${err.message || String(err)}`);
        }
      }

      const total = mentionIds.length;
      const successCount = succeeded.length;
      const summary = `${successCount}/${total} successful`;
      const resultEmbed = new EmbedBuilder()
        .setTitle('Time Update Results')
        .setColor(successCount === total ? 0x57f287 : (successCount > 0 ? 0xfee75c : 0xed4245))
        .setDescription(`${summary}. Operation: ${operation}. Amount: ${amount} minutes.`)
        .addFields(
          { name: 'Successful', value: succeeded.length ? succeeded.join('\n').slice(0, 1024) : 'None', inline: false },
          { name: 'Not Verified', value: notVerified.length ? notVerified.join(', ').slice(0, 1024) : 'None', inline: false },
          { name: 'Verified But Not Found In Sheet', value: notFoundInSheet.length ? notFoundInSheet.join('\n').slice(0, 1024) : 'None', inline: false },
          { name: 'Failed', value: failed.length ? failed.join('\n').slice(0, 1024) : 'None', inline: false }
        );

      return interaction.editReply({ embeds: [resultEmbed] });
    } catch (err) {
      console.error('time command failed:', err);
      const failedEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('Time Update Failed')
        .setDescription('Failed to update sheet: ' + (err.message || String(err)));
      return interaction.editReply({ embeds: [failedEmbed] });
    }
  }
};
