const config = require('../../config');
const axios = require('axios');
const { google } = require('googleapis');

async function fetchSheetRows(range) {
  const { GOOGLE_SHEET_ID, GOOGLE_SHEETS_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_PATH } = config;
  let rows = [];
  if (GOOGLE_SHEET_ID && GOOGLE_SHEETS_API_KEY) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?key=${GOOGLE_SHEETS_API_KEY}`;
    const res = await axios.get(url);
    rows = res.data.values || [];
    return rows;
  }

  if (GOOGLE_SHEET_ID && (GOOGLE_SERVICE_ACCOUNT_JSON || GOOGLE_SERVICE_ACCOUNT_PATH)) {
    let keyObj = null;
    try {
      if (GOOGLE_SERVICE_ACCOUNT_JSON) {
        keyObj = typeof GOOGLE_SERVICE_ACCOUNT_JSON === 'string' ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON) : GOOGLE_SERVICE_ACCOUNT_JSON;
      } else if (GOOGLE_SERVICE_ACCOUNT_PATH) {
        const fs = require('fs');
        keyObj = JSON.parse(fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_PATH, 'utf8'));
      }
    } catch (err) {
      throw new Error('Failed to parse Google service account credentials: ' + err.message);
    }

    const auth = new google.auth.JWT({
      email: keyObj.client_email,
      key: keyObj.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
    rows = (sheetRes && sheetRes.data && sheetRes.data.values) || [];
    return rows;
  }

  throw new Error('Google Sheets not configured (provide API key or service account)');
}

/**
 * Search the blacklist sheet for a username or userId.
 * Returns null if not found or if the type is COMPLETED/APPEALED.
 * Otherwise returns { name, type, endDate, reason, rowIndex }
 */
async function findBlacklistEntry({ robloxUsername, robloxUserId }) {
  if (!robloxUsername && !robloxUserId) return null;
  const range = config.BLACKLIST_SHEET_RANGE || config.GOOGLE_SHEETS_RANGE;
  const rows = await fetchSheetRows(range);

  const nameIdx = Number.isFinite(Number(config.BLACKLIST_NAME_COL)) ? Number(config.BLACKLIST_NAME_COL) : 0;
  const typeIdx = Number.isFinite(Number(config.BLACKLIST_TYPE_COL)) ? Number(config.BLACKLIST_TYPE_COL) : 1;
  const endIdx = Number.isFinite(Number(config.BLACKLIST_ENDDATE_COL)) ? Number(config.BLACKLIST_ENDDATE_COL) : 2;
  const reasonIdx = Number.isFinite(Number(config.BLACKLIST_REASON_COL)) ? Number(config.BLACKLIST_REASON_COL) : 4;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const nameCell = String(row[nameIdx] || '').trim();
    const typeCell = String(row[typeIdx] || '').trim();
    const rowStr = (row || []).join(' | ');

    const matchesName = robloxUsername && (
      (nameCell && nameCell.toLowerCase() === String(robloxUsername).toLowerCase()) ||
      String(rowStr).toLowerCase().includes(String(robloxUsername).toLowerCase())
    );
    const matchesId = robloxUserId && String(rowStr).includes(String(robloxUserId));

    if (matchesName || matchesId) {
      const typeNorm = (typeCell || '').toLowerCase();
      if (typeNorm === 'completed' || typeNorm === 'appealed') {
        return null; // ignore these
      }
      // treat others as blocking (temporary/permanent)
      const endDate = String(row[endIdx] || '').trim();
      const reason = String(row[reasonIdx] || '').trim();
      return { name: nameCell || rowStr, type: typeCell || 'unknown', endDate, reason, rowIndex: i };
    }
  }
  return null;
}

module.exports = { findBlacklistEntry };
