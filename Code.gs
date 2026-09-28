/**
 * Shared Drive access sync
 * -------------------------------------------------------------
 * Reads the ROLES sheet and grants/removes "Content manager" access on each
 * project's Shared Drive (IDs listed in CONFIG), so drive membership matches
 * the sheet.
 *
 * Rules
 *   - A person should be on a project's drive if their cell in that project's
 *     column is NOT empty, OR their "Core Team?" box is ticked (all drives).
 *   - Projects that share a Shared Drive ID are synced together: the drive's
 *     members are everyone assigned to ANY of those projects.
 *   - Missing members are added as Content manager (API role "fileOrganizer").
 *   - Existing members with a lower role (Viewer/Commenter/Contributor) are
 *     upgraded to Content manager.
 *   - Content managers who are no longer in the sheet are REMOVED.
 *   - Never touched: Managers ("organizer"), groups/domains, and the account
 *     running the script.
 *
 * Setup
 *   1. Extensions > Apps Script > Services (+) > add "Drive API" (v3), id "Drive".
 *      If it is already added as v2, change the version to v3 — this file uses
 *      v3 field names (permissions/emailAddress, Permissions.create).
 *   2. The account running the script must be a Manager of every Shared Drive.
 *   3. Reload the spreadsheet, then use the "Drive Sync" menu.
 *      Run "Preview (dry run)" first to check what would change.
 */

const SYNC = {
  ROLES_SHEET: 'ROLES',
  CONFIG_SHEET: 'CONFIG',
  LOG_SHEET: 'SYNC_LOG',

  ROLES_HEADER_ROWS: 2,              // ROLES has 2 header rows (merged "Role" + project names)
  CONFIG_HEADER_ROWS: 1,

  EMAIL_HEADER: 'Email',             // matched as "header contains this text"
  CORE_TEAM_HEADER: 'Core Team?',    // matched exactly (case-insensitive)

  CONFIG_ROLE_HEADER: 'Role Name',
  CONFIG_DRIVE_HEADER: 'Shared Drive ID',

  GRANT_ROLE: 'fileOrganizer',       // "Content manager" in the Drive UI
  SEND_NOTIFICATION_EMAIL: true,

  ACCESS_SHEET: 'DRIVE_ACCESS',      // output of listSharedDriveAccess()
};

// Lower number = less access. Used to decide whether to upgrade someone.
const ROLE_RANK = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5 };


/* ============================== Menu ============================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Drive Sync')
    .addItem('Preview (dry run)', 'previewDriveSync')
    .addItem('Sync Shared Drive access', 'runDriveSync')
    .addSeparator()
    .addItem('List current drive access', 'listSharedDriveAccess')
    .addToUi();
}

function previewDriveSync() {
  syncSharedDrives_(true);
}

function runDriveSync() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Sync Shared Drive access',
    'This will ADD and REMOVE Content managers on every project Shared Drive ' +
      'so they match the ROLES sheet.\n\nManagers are never removed. Continue?',
    ui.ButtonSet.OK_CANCEL
  );
  if (answer !== ui.Button.OK) return;
  syncSharedDrives_(false);
}


/* ============================== Main ============================== */

function syncSharedDrives_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30 * 1000)) {
    ui.alert('Another sync is already running. Try again in a minute.');
    return;
  }

  const log = [];
  const stamp = new Date();
  const me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();

  try {
    assertDriveV3_();
    const projects = readConfig_(ss);
    const desired = readRoles_(ss, projects);

    // Several projects may share one Shared Drive (e.g. RPM2 and RPM2 Long Ads).
    // Merge them so each drive is synced once against the union of its projects;
    // syncing per project would make each one remove the other's members.
    const drives = [];
    const driveById = {};
    projects.forEach(function (p) {
      let d = driveById[p.driveId];
      if (!d) {
        d = driveById[p.driveId] = { names: [], driveId: p.driveId, want: new Set() };
        drives.push(d);
      }
      d.names.push(p.name);
      desired[p.name].forEach(function (email) { d.want.add(email); });
    });

    drives.forEach(function (d) {
      const p = { name: d.names.join(' + '), driveId: d.driveId };
      const want = d.want;

      // Safety net: an empty target list almost always means a broken header
      // or an empty sheet. Refuse to wipe the drive in that case.
      if (want.size === 0) {
        log.push([stamp, p.name, 'SKIP', '', 'No one assigned in ROLES; drive left untouched']);
        return;
      }

      let current;
      try {
        current = listDriveMembers_(p.driveId);
      } catch (e) {
        log.push([stamp, p.name, 'ERROR', '', 'Cannot read drive members: ' + e.message]);
        return;
      }

      const currentByEmail = {};
      current.forEach(function (perm) {
        if (perm.type === 'user' && perm.emailAddress) {
          currentByEmail[perm.emailAddress.toLowerCase()] = perm;
        }
      });

      // 1) Add or upgrade people who should be on the drive.
      want.forEach(function (email) {
        const perm = currentByEmail[email];
        if (!perm) {
          applyChange_(dryRun, log, stamp, p.name, 'ADD', email, function () {
            Drive.Permissions.create(
              { type: 'user', role: SYNC.GRANT_ROLE, emailAddress: email },
              p.driveId,
              { supportsAllDrives: true, sendNotificationEmail: SYNC.SEND_NOTIFICATION_EMAIL }
            );
          });
        } else if (ROLE_RANK[perm.role] < ROLE_RANK[SYNC.GRANT_ROLE]) {
          applyChange_(dryRun, log, stamp, p.name, 'UPGRADE', email, function () {
            Drive.Permissions.update(
              { role: SYNC.GRANT_ROLE },
              p.driveId,
              perm.id,
              { supportsAllDrives: true }
            );
          }, perm.role + ' -> ' + SYNC.GRANT_ROLE);
        }
      });

      // 2) Remove people who are no longer in the sheet.
      Object.keys(currentByEmail).forEach(function (email) {
        const perm = currentByEmail[email];
        if (want.has(email)) return;
        if (perm.role === 'organizer') return;   // never remove Managers
        if (email === me) return;                 // never remove yourself

        applyChange_(dryRun, log, stamp, p.name, 'REMOVE', email, function () {
          Drive.Permissions.remove(p.driveId, perm.id, { supportsAllDrives: true });
        }, 'was ' + perm.role);
      });
    });
  } catch (e) {
    log.push([stamp, '', 'ERROR', '', e.message]);
  } finally {
    lock.releaseLock();
  }

  writeLog_(ss, log, dryRun);
  ui.alert(summarize_(log, dryRun));
}

function applyChange_(dryRun, log, stamp, project, action, email, fn, note) {
  const label = dryRun ? 'WOULD ' + action : action;
  if (dryRun) {
    log.push([stamp, project, label, email, note || '']);
    return;
  }
  try {
    fn();
    log.push([stamp, project, label, email, note || 'OK']);
  } catch (e) {
    log.push([stamp, project, action + ' FAILED', email, e.message]);
  }
}


/* ============================== Access report ============================== */

/**
 * Writes the current members of every Shared Drive listed in CONFIG to the
 * DRIVE_ACCESS sheet (created if missing). Read-only on the drives.
 */
function listSharedDriveAccess() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const rows = [];

  try {
    assertDriveV3_();
    readConfig_(ss).forEach(function (p) {
      let driveName = p.name;
      try {
        driveName = Drive.Drives.get(p.driveId).name;
        listDriveMembers_(p.driveId).forEach(function (perm) {
          const who = perm.emailAddress || perm.domain || 'Link sharing / Anyone';
          rows.push([p.name, driveName, who, perm.role, perm.type]);
        });
      } catch (e) {
        rows.push([p.name, driveName, '', 'ERROR', e.message]);
      }
    });
  } catch (e) {
    ui.alert('An error occurred: ' + e.message);
    return;
  }

  let sheet = ss.getSheetByName(SYNC.ACCESS_SHEET);
  if (!sheet) sheet = ss.insertSheet(SYNC.ACCESS_SHEET);
  sheet.clear();
  sheet.getRange(1, 1, 1, 5)
    .setValues([['Project', 'Shared Drive Name', 'User/Group Email', 'Role', 'Type']])
    .setFontWeight('bold')
    .setBackground('#e6f2ff');
  sheet.setFrozenRows(1);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, 5).setValues(rows);

  ui.alert('Retrieved ' + rows.length + ' permissions. See the "' + SYNC.ACCESS_SHEET + '" sheet.');
}


/* ============================== Readers ============================== */

/** Returns [{ name, driveId }] for every CONFIG row that has a Shared Drive ID. */
function readConfig_(ss) {
  const sheet = mustGetSheet_(ss, SYNC.CONFIG_SHEET);
  const values = sheet.getDataRange().getValues();
  const header = values[SYNC.CONFIG_HEADER_ROWS - 1].map(norm_);

  const nameCol = header.indexOf(norm_(SYNC.CONFIG_ROLE_HEADER));
  const driveCol = header.indexOf(norm_(SYNC.CONFIG_DRIVE_HEADER));
  if (nameCol < 0 || driveCol < 0) {
    throw new Error('CONFIG must have "' + SYNC.CONFIG_ROLE_HEADER + '" and "' +
      SYNC.CONFIG_DRIVE_HEADER + '" headers in row ' + SYNC.CONFIG_HEADER_ROWS + '.');
  }

  const projects = [];
  values.slice(SYNC.CONFIG_HEADER_ROWS).forEach(function (row) {
    const name = String(row[nameCol]).trim();
    const driveId = String(row[driveCol]).trim();
    if (name && driveId) projects.push({ name: name, driveId: driveId });
  });
  return projects;
}

/**
 * Returns { projectName: Set<email> } — who should be on each project's drive.
 * Project columns are located by matching CONFIG role names against the
 * ROLES header rows.
 */
function readRoles_(ss, projects) {
  const sheet = mustGetSheet_(ss, SYNC.ROLES_SHEET);
  const values = sheet.getDataRange().getValues();
  const headerRows = values.slice(0, SYNC.ROLES_HEADER_ROWS);
  const data = values.slice(SYNC.ROLES_HEADER_ROWS);

  const findCol = function (predicate) {
    for (let r = 0; r < headerRows.length; r++) {
      for (let c = 0; c < headerRows[r].length; c++) {
        if (predicate(norm_(headerRows[r][c]))) return c;
      }
    }
    return -1;
  };

  const emailCol = findCol(function (h) { return h.indexOf(norm_(SYNC.EMAIL_HEADER)) >= 0; });
  const coreCol = findCol(function (h) { return h === norm_(SYNC.CORE_TEAM_HEADER); });
  if (emailCol < 0) throw new Error('ROLES: no header containing "' + SYNC.EMAIL_HEADER + '" found.');
  if (coreCol < 0) throw new Error('ROLES: no "' + SYNC.CORE_TEAM_HEADER + '" header found.');

  const desired = {};
  const projectCols = {};
  projects.forEach(function (p) {
    const col = findCol(function (h) { return h === norm_(p.name); });
    if (col < 0) throw new Error('ROLES: no column header matching CONFIG role "' + p.name + '".');
    projectCols[p.name] = col;
    desired[p.name] = new Set();
  });

  data.forEach(function (row) {
    const email = String(row[emailCol]).trim().toLowerCase();
    if (!isEmail_(email)) return;
    const isCore = row[coreCol] === true;

    projects.forEach(function (p) {
      const cell = row[projectCols[p.name]];
      if (isCore || String(cell).trim() !== '') desired[p.name].add(email);
    });
  });

  return desired;
}

/** All permissions on a Shared Drive (its members). */
function listDriveMembers_(driveId) {
  const out = [];
  let pageToken;
  do {
    const res = Drive.Permissions.list(driveId, {
      supportsAllDrives: true,
      pageSize: 100,
      pageToken: pageToken,
      fields: 'nextPageToken, permissions(id, type, role, emailAddress, domain)',
    });
    (res.permissions || []).forEach(function (p) { out.push(p); });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}


/* ============================== Helpers ============================== */

function writeLog_(ss, rows, dryRun) {
  let sheet = ss.getSheetByName(SYNC.LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SYNC.LOG_SHEET);
    sheet.appendRow(['Timestamp', 'Project', 'Action', 'Email', 'Details']);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:E1').setFontWeight('bold');
  }
  if (rows.length === 0) {
    rows = [[new Date(), '', dryRun ? 'PREVIEW' : 'SYNC', '', 'No changes needed']];
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function summarize_(log, dryRun) {
  const counts = {};
  log.forEach(function (r) { counts[r[2]] = (counts[r[2]] || 0) + 1; });
  const lines = Object.keys(counts).map(function (k) { return k + ': ' + counts[k]; });
  const title = dryRun ? 'Preview only — nothing was changed.' : 'Sync finished.';
  return title + '\n\n' + (lines.length ? lines.join('\n') : 'No changes needed.') +
    '\n\nDetails are in the "' + SYNC.LOG_SHEET + '" sheet.';
}

/** v2 has Permissions.insert, v3 has Permissions.create. This file needs v3. */
function assertDriveV3_() {
  if (typeof Drive === 'undefined' || typeof Drive.Permissions.create !== 'function') {
    throw new Error('The Drive advanced service must be v3. In the Apps Script editor, ' +
      'click Services > Drive, set Version to v3, and save.');
  }
}

function mustGetSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found.');
  return sheet;
}

function norm_(v) {
  return String(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
