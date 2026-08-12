const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ROLES_SHEET = process.env.ROLES_SHEET_NAME || 'ROLES';
const BASE_DATA_SHEET = process.env.BASE_DATA_SHEET_NAME || 'BASE DATA';
const CONFIG_SHEET = process.env.CONFIG_SHEET_NAME || 'CONFIG';
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS) || 5 * 60 * 1000;

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  // Two ways to supply the service-account credentials:
  //   1. GOOGLE_SERVICE_ACCOUNT_KEY — the JSON contents inline as a string.
  //      Used on Railway / Render / any serverless-ish host that doesn't have
  //      a Secret File concept. Recommended.
  //   2. GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to a JSON file on disk.
  //      Used for local dev. Same as the original setup.
  let keyFile;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    keyFile = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } else {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
    if (!keyPath) {
      throw new Error(
        'Neither GOOGLE_SERVICE_ACCOUNT_KEY nor GOOGLE_SERVICE_ACCOUNT_KEY_PATH is set.'
      );
    }
    keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }

  const auth = new google.auth.GoogleAuth({
    credentials: keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

async function getRolesSheetData() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ROLES_SHEET}!A1:ZZ1000`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) throw new Error('ROLES sheet is empty');

  // Find the row containing BOTH "Email" AND "Core Team?" — skips the group label row above
  let headerRowIndex = -1;
  let fallbackRowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hasEmail = row.some((cell) => typeof cell === 'string' && /email/i.test(cell));
    const hasCoreTeam = row.some((cell) => typeof cell === 'string' && /core.?team/i.test(cell));
    if (hasEmail) fallbackRowIndex = i;
    if (hasEmail && hasCoreTeam) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) headerRowIndex = fallbackRowIndex;
  if (headerRowIndex === -1) {
    throw new Error('Could not locate header row in ROLES sheet (no cell matched "Email")');
  }

  const headers = rows[headerRowIndex];

  const colIndex = {
    fullname: findColumn(headers, /ชื่อ\s*นามสกุล|full ?name/i, 2),
    nickname: findColumn(headers, /ชื่อเล่น|nickname/i, 3),
    email: findColumn(headers, /email/i, 4),
    coreTeam: findColumn(headers, /core ?team/i, 5),
    it: findColumn(headers, /^it\??$/i, 6),
  };

  // The row immediately after the header row contains the actual role names
  // (HOUSE, 2026-TWAL, etc.) under the merged "Role" group label cell.
  const subHeaderRow = rows[headerRowIndex + 1] || [];
  const hasSubHeader = subHeaderRow.some((cell, idx) => {
    return idx > colIndex.it && (cell || '').toString().trim().length > 0;
  }) && !subHeaderRow.some((cell) => typeof cell === 'string' && /email/i.test(cell));

  const roleSourceRow = hasSubHeader ? subHeaderRow : headers;
  const dataStartIndex = hasSubHeader ? headerRowIndex + 2 : headerRowIndex + 1;

  const roleColumns = [];
  for (let c = colIndex.it + 1; c < roleSourceRow.length; c++) {
    const header = (roleSourceRow[c] || '').toString().trim();
    if (header) {
      roleColumns.push({ index: c, name: header });
    }
  }

  const dataRows = rows.slice(dataStartIndex).filter((r) => r.length > 0);

  // DEBUG — remove after confirming correct detection
  console.log('[DEBUG] headerRowIndex:', headerRowIndex);
  console.log('[DEBUG] headers row:', JSON.stringify(headers));
  console.log('[DEBUG] colIndex:', JSON.stringify(colIndex));
  console.log('[DEBUG] roleColumns detected:', JSON.stringify(roleColumns));
  if (dataRows[0]) console.log('[DEBUG] first data row:', JSON.stringify(dataRows[0]));

  return { headers, colIndex, roleColumns, dataRows, headerRowIndex, dataStartIndex };
}

function findColumn(headers, regex, fallbackIndex) {
  const idx = headers.findIndex((h) => typeof h === 'string' && regex.test(h));
  return idx !== -1 ? idx : fallbackIndex;
}

let configCache = null;

async function getRoleIdMap(forceRefresh = false) {
  const isStale = !configCache || Date.now() - configCache.fetchedAt > CONFIG_CACHE_TTL_MS;
  if (!forceRefresh && !isStale) return configCache.map;

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!A2:B`,
  });

  const rows = res.data.values || [];
  const map = new Map();

  for (const row of rows) {
    const roleName = (row[0] || '').toString().trim();
    const roleId = (row[1] || '').toString().trim();
    if (roleName && roleId) {
      map.set(roleName, roleId);
    }
  }

  configCache = { map, fetchedAt: Date.now() };
  return map;
}

function invalidateConfigCache() {
  configCache = null;
}

async function lookupByEmail(email) {
  const { colIndex, roleColumns, dataRows, dataStartIndex } = await getRolesSheetData();
  const normalizedTarget = email.trim().toLowerCase();

  const matches = [];
  dataRows.forEach((row, i) => {
    const rowEmail = (row[colIndex.email] || '').toString().trim().toLowerCase();
    if (rowEmail && rowEmail === normalizedTarget) {
      matches.push({ row, sheetRowNumber: dataStartIndex + 1 + i });
    }
  });

  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'duplicate' };

  const { row, sheetRowNumber } = matches[0];

  const coreTeamChecked = isChecked(row[colIndex.coreTeam]);

  const roles = roleColumns.map((col) => {
    const cellValue = (row[col.index] || '').toString().trim();
    return {
      name: col.name,
      hasValue: cellValue.length > 0,
      isDotOnly: cellValue === '.',
      rawValue: cellValue,
    };
  });

  return {
    status: 'found',
    fullname: (row[colIndex.fullname] || '').toString().trim(),
    nickname: (row[colIndex.nickname] || '').toString().trim(),
    email: (row[colIndex.email] || '').toString().trim(),
    coreTeam: coreTeamChecked,
    roles,
    rowNumber: sheetRowNumber,
  };
}

function isChecked(cellValue) {
  if (cellValue === true) return true;
  if (typeof cellValue === 'string') {
    return ['true', 'checked', 'yes', '1', 'x', '✓'].includes(cellValue.trim().toLowerCase());
  }
  return false;
}

async function getBaseDataSheetData() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BASE_DATA_SHEET}!A1:ZZ5000`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) throw new Error('BASE DATA sheet is empty');

  const headerRowIndex = 0;
  const headers = rows[headerRowIndex];

  const discordIdCol = findColumn(headers, /discord[\s_]?id/i, 8);
  const skipCol = 0;

  return { headers, discordIdCol, skipCol, rows, headerRowIndex };
}

async function upsertBaseDataRow(discordId, rowDataByHeaderName) {
  const sheets = await getSheetsClient();
  const { headers, discordIdCol, skipCol, rows, headerRowIndex } = await getBaseDataSheetData();

  let existingRowIndex = -1;
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const cell = (rows[i][discordIdCol] || '').toString().trim();
    if (cell && cell === discordId.toString()) {
      existingRowIndex = i;
      break;
    }
  }

  if (existingRowIndex !== -1) {
    const skipFlag = isChecked(rows[existingRowIndex][skipCol]);
    if (skipFlag) {
      return { status: 'skipped_protected_row' };
    }

    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetObj = sheetMeta.data.sheets.find(
      (s) => s.properties.title === BASE_DATA_SHEET
    );
    const sheetId = sheetObj.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: existingRowIndex,
                endIndex: existingRowIndex + 1,
              },
            },
          },
        ],
      },
    });
  }

  const newRow = headers.map((h) => {
    const key = Object.keys(rowDataByHeaderName).find(
      (k) => k.toLowerCase() === (h || '').toString().trim().toLowerCase()
    );
    return key ? rowDataByHeaderName[key] : '';
  });

  newRow[discordIdCol] = discordId.toString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BASE_DATA_SHEET}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });

  return { status: existingRowIndex !== -1 ? 'overwritten' : 'inserted' };
}

module.exports = {
  lookupByEmail,
  upsertBaseDataRow,
  getRolesSheetData,
  getBaseDataSheetData,
  getRoleIdMap,
  invalidateConfigCache,
};
