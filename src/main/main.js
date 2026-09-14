'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const db = require('./db');
const cac = require('./cac');
const exports_ = require('./exports');

/* ------------------------------------------------------------------ *
 * Last-resort error handling
 *
 * Without this Electron shows a raw Node stack trace in a modal, which is
 * useless to a bartender mid-service and looks like the till has died. Every
 * sale is committed to SQLite as it is rung up, so the safe move is to say
 * what happened in plain language, write the details to a log, and keep
 * serving rather than taking the bar offline.
 * ------------------------------------------------------------------ */

function logCrash(kind, err) {
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(file,
      `\n[${new Date().toISOString()}] ${kind}\n${err && err.stack ? err.stack : String(err)}\n`);
    return file;
  } catch {
    return null;
  }
}

function reportCrash(kind, err) {
  console.error(`[${kind}]`, err);
  const file = logCrash(kind, err);
  if (!app.isReady()) return;
  dialog.showMessageBox({
    type: 'error',
    title: 'Something went wrong',
    message: 'That last action did not complete.',
    detail:
      `${err && err.message ? err.message : String(err)}\n\n` +
      'Your sales and drink counts are safe — every sale is saved the moment ' +
      'it is rung up. You can carry on serving.' +
      (file ? `\n\nDetails were written to:\n${file}` : ''),
    buttons: ['Continue'],
    noLink: true,
  }).catch(() => { /* never let the reporter itself throw */ });
}

process.on('uncaughtException', (err) => reportCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));

// Single instance: two copies of the POS writing the same SQLite file on one
// machine is a good way to lose a night of sales.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#07090c',
    show: false,
    title: 'Drop Zone Tea Party',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Data…',
          accelerator: 'CmdOrCtrl+E',
          click: () => win && win.webContents.send('nav', 'export'),
        },
        {
          label: 'Open Data Folder',
          click: () => shell.showItemInFolder(db.getDbPath()),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Bar', accelerator: 'CmdOrCtrl+1', click: () => win && win.webContents.send('nav', 'bar') },
        { label: 'Inventory', accelerator: 'CmdOrCtrl+2', click: () => win && win.webContents.send('nav', 'inventory') },
        { label: 'Patrons', accelerator: 'CmdOrCtrl+3', click: () => win && win.webContents.send('nav', 'patrons') },
        { label: 'Reports', accelerator: 'CmdOrCtrl+4', click: () => win && win.webContents.send('nav', 'reports') },
        { label: 'Admin', accelerator: 'CmdOrCtrl+5', click: () => win && win.webContents.send('nav', 'admin') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Business-day rollover
 *
 * Drink limits are scoped to the business date, so they reset on their own the
 * moment the date ticks over. The catch is a POS that is simply left running:
 * nothing would tell the window, so the bartender would be looking at
 * yesterday's date and a stale patron panel. This watches the clock and tells
 * the renderer to refresh itself.
 * ------------------------------------------------------------------ */

let rolloverTimer = null;
let lastBusinessDate = null;

function checkRollover() {
  const now = db.businessDate();
  if (now === lastBusinessDate) return;

  const previous = lastBusinessDate;
  lastBusinessDate = now;
  if (!previous) return;                 // first call just records where we are

  db.audit('business_day_rollover', `${previous} -> ${now}`, 'system');
  db.rollShiftIfStale();
  db.purgeOldPii();
  exports_.runBackupIfDue('business day rollover');

  if (win && !win.isDestroyed()) {
    win.webContents.send('business-date', { businessDate: now, previous });
  }
}

function startRolloverWatch() {
  lastBusinessDate = db.businessDate();
  // 30s is plenty: the only thing that turns over is a date.
  rolloverTimer = setInterval(checkRollover, 30_000);
}

function stopRolloverWatch() {
  if (rolloverTimer) { clearInterval(rolloverTimer); rolloverTimer = null; }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/** Wrap a handler so renderer calls get {ok,data} / {ok,error} instead of throws. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  /* --- boot ------------------------------------------------------- */
  handle('app:bootstrap', () => ({
    version: app.getVersion(),
    dbPath: db.getDbPath(),
    settings: db.allSettings(),
    businessDate: db.businessDate(),
    shift: db.currentShift(),
    products: db.listProducts(),
    lowStock: db.lowStock(),
    layoutCalibrated: !!cac.getLayout(),
    pinIsDefault: db.getSetting('manager_pin_is_default') === '1',
  }));

  /* --- scanning --------------------------------------------------- */
  handle('scan:resolve', ({ raw }) => {
    const parsed = cac.parseScan(raw);
    if (!parsed.raw) throw new Error('Empty scan.');
    const { patron, isNew } = db.resolveCard(parsed);
    return {
      parsed: { kind: parsed.kind, length: parsed.length, parsedBy: parsed.parsedBy,
                nameConfidence: parsed.nameConfidence, suggestedName: parsed.name,
                suggestedDob: parsed.dob, last4: parsed.last4 },
      isNew,
      status: db.patronStatus(patron.id),
    };
  });

  handle('scan:preview', ({ raw }) => {
    const parsed = cac.parseScan(raw);
    return { parsed, layout: cac.getLayout() };
  });

  handle('layout:preview', ({ raw, start, len }) =>
    cac.previewSlice(cac.normalize(raw), Number(start) || 0, Number(len) || 0));

  handle('layout:save', ({ layout }) => ({ layout: cac.saveLayout(layout) }));
  handle('layout:deduce', ({ raw, knownId }) => ({
    candidates: cac.deduceIdLayout(raw, knownId),
  }));
  handle('layout:get', () => ({ layout: cac.getLayout() }));

  /* --- patrons ---------------------------------------------------- */
  handle('patron:status', ({ id }) => db.patronStatus(id));
  handle('patron:update', ({ id, fields }) => db.updatePatron(id, fields || {}));
  handle('patron:ban', ({ id, banned, reason, pin }) => {
    if (db.getSetting('require_pin_for_override') === '1' && !db.verifyPin(pin)) {
      throw new Error('Manager PIN incorrect.');
    }
    return db.setBan(id, banned, reason);
  });
  handle('patron:list', ({ search, limit }) => db.listPatrons({ search, limit }));
  handle('patron:history', ({ id, limit }) => db.patronHistory(id, limit));
  handle('patron:find', ({ term, limit }) => db.findPatrons(term, limit));
  handle('patron:create', ({ name, firstName, lastName, dodId, cardRaw }) => {
    const cardParsed = cardRaw ? cac.parseScan(cardRaw) : null;
    const { patron, isNew } = db.createPatron({ name, firstName, lastName, dodId, cardParsed });
    return { isNew, status: db.patronStatus(patron.id) };
  });
  handle('patron:linkCard', ({ id, raw }) => db.linkCard(id, cac.parseScan(raw)));
  handle('patron:footprint', ({ id }) => db.patronFootprint(id));
  handle('patron:delete', ({ id, pin }) => {
    if (db.getSetting('require_pin_for_admin') === '1' && !db.verifyPin(pin)) {
      throw new Error('Manager PIN incorrect.');
    }
    return db.deletePatron(id);
  });

  /* --- products + inventory --------------------------------------- */
  handle('product:list', ({ includeInactive }) => db.listProducts({ includeInactive }));
  handle('product:save', ({ product }) => {
    const id = db.saveProduct(product);
    return { id, products: db.listProducts({ includeInactive: true }) };
  });
  handle('product:archive', ({ id }) => {
    db.archiveProduct(id);
    return { products: db.listProducts({ includeInactive: true }) };
  });
  handle('product:setPrice', ({ id, priceCents, actor }) => {
    const r = db.setProductPrice(id, priceCents, actor);
    return { ...r, products: db.listProducts({ includeInactive: true }) };
  });
  handle('product:bulkPrice', ({ category, mode, amount, actor, pin }) => {
    if (db.getSetting('require_pin_for_admin') === '1' && !db.verifyPin(pin)) {
      throw new Error('Manager PIN incorrect.');
    }
    const r = db.bulkSetPrice({ category, mode, amount, actor });
    return { ...r, products: db.listProducts({ includeInactive: true }) };
  });
  handle('inventory:adjust', (p) => {
    const r = db.adjustInventory(p);
    return { ...r, lowStock: db.lowStock() };
  });
  handle('inventory:meta', ({ productId, unit, par_level }) => {
    db.setInventoryMeta(productId, { unit, par_level });
    return { products: db.listProducts({ includeInactive: true }) };
  });
  handle('inventory:adjustments', ({ limit }) => db.inventoryAdjustments({ limit }));
  handle('inventory:lowStock', () => db.lowStock());

  /* --- tickets + orders ------------------------------------------- */
  handle('ticket:price', ({ patronId, items }) => db.priceTicket({ patronId, items }));
  handle('order:create', (p) => {
    const r = db.createOrder(p);
    return { ...r, lowStock: db.lowStock(), products: db.listProducts() };
  });
  handle('order:void', (p) => {
    const r = db.voidOrder(p);
    return { ...r, products: db.listProducts() };
  });
  handle('order:removeItem', (p) => {
    const r = db.removeOrderItem(p);
    return { ...r, products: db.listProducts(), lowStock: db.lowStock() };
  });
  handle('order:recent', ({ limit, shiftId }) => db.recentOrders({ limit, shiftId }));

  /* --- shifts ----------------------------------------------------- */
  handle('shift:current', () => ({ shift: db.currentShift(), summary: db.currentShift() ? db.shiftSummary(db.currentShift().id) : null }));
  handle('shift:open', ({ openedBy }) => db.openShift(openedBy));
  handle('shift:close', ({ closedBy, note, pin }) => {
    if (db.getSetting('require_pin_for_void') === '1' && !db.verifyPin(pin)) {
      throw new Error('Manager PIN incorrect.');
    }
    const summary = db.closeShift(closedBy, note);
    // The end of a shift is the natural moment to get the night off the box.
    return { ...summary, backup: exports_.runBackup({ reason: 'shift close' }) };
  });

  /* --- backups ---------------------------------------------------- */
  handle('backup:status', () => exports_.backupStatus());
  handle('backup:now', () => exports_.runBackup({ reason: 'manual', force: true }));
  handle('backup:list', () => exports_.listBackups());
  handle('backup:chooseDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for automatic backups',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Back Up Here',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    db.setSetting('backup_dir', res.filePaths[0]);
    db.audit('backup_folder_set', res.filePaths[0], 'manager');
    // Prove it works immediately rather than at 2am when nobody is watching.
    const first = exports_.runBackup({ reason: 'folder chosen', force: true });
    return { dir: res.filePaths[0], first, status: exports_.backupStatus() };
  });
  handle('backup:openDir', () => {
    const { dir, reachable } = exports_.backupStatus();
    if (dir && reachable) shell.openPath(dir);
    return { ok: !!(dir && reachable) };
  });

  /* --- reports ---------------------------------------------------- */
  handle('report:day', ({ date }) => db.dayReport(date));
  handle('report:range', ({ from, to }) => db.rangeReport(from, to));
  handle('report:sales', ({ from, to }) => db.salesReport(from, to));

  /**
   * Render the sales report to a PDF. The report HTML is built in the main
   * process and printed from a throwaway hidden window, so the output is a
   * clean paginated document rather than a screenshot of the app.
   */
  handle('report:pdf', async ({ from, to, open }) => {
    const rep = db.salesReport(from, to);
    const html = exports_.buildReportHtml(rep, db.getSetting('venue_name') || 'Drop Zone Tea Party');

    const res = await dialog.showSaveDialog(win, {
      title: 'Save sales report',
      defaultPath: from === to
        ? `sales-report-${from}.pdf`
        : `sales-report-${from}_to_${to}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };

    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
    });
    try {
      await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const buf = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        preferCSSPageSize: true,
      });
      fs.writeFileSync(res.filePath, buf);
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
    }

    db.audit('export_pdf', `${from}..${to} -> ${path.basename(res.filePath)}`, 'bartender');
    if (open) shell.openPath(res.filePath);
    return { filePath: res.filePath, bytes: fs.statSync(res.filePath).size };
  });
  handle('report:table', ({ name, from, to }) => ({
    name, rows: exports_.runReport(name, from, to),
  }));
  handle('report:names', () => exports_.reportNames());

  /* --- settings --------------------------------------------------- */
  handle('settings:all', () => db.allSettings());
  handle('settings:save', ({ patch }) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'manager_pin' || k === 'id_salt') continue; // guarded below
      db.setSetting(k, v);
    }
    db.audit('settings_saved', Object.keys(patch || {}).join(','), 'manager');
    return db.allSettings();
  });
  handle('settings:setPin', ({ currentPin, newPin }) => {
    if (!db.verifyPin(currentPin)) throw new Error('Current PIN is incorrect.');
    if (!/^\d{4,8}$/.test(String(newPin))) throw new Error('PIN must be 4 to 8 digits.');
    db.setPin(newPin);
    return { ok: true };
  });
  handle('settings:verifyPin', ({ pin }) => ({ valid: db.verifyPin(pin) }));
  handle('settings:purgePii', ({ pin }) => {
    if (!db.verifyPin(pin)) throw new Error('Manager PIN incorrect.');
    return db.purgeOldPii();
  });

  /* --- export ----------------------------------------------------- */
  handle('export:bundle', async ({ from, to }) => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for the export',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Export Here',
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const stamp = `${from}_to_${to}`.replace(/[^\w.-]/g, '');
    const dirPath = path.join(res.filePaths[0], `club-bar-export_${stamp}`);
    return exports_.exportBundle({ from, to, dirPath });
  });

  handle('export:csv', async ({ name, from, to }) => {
    const res = await dialog.showSaveDialog(win, {
      title: `Export ${name}`,
      defaultPath: `${name}_${from}_to_${to}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    return exports_.exportCsv({ name, from, to, filePath: res.filePath });
  });

  handle('export:backupDb', async () => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save database backup',
      defaultPath: `bar-backup-${db.businessDate()}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    return exports_.backupDb(res.filePath);
  });

  handle('export:revealData', () => {
    shell.showItemInFolder(db.getDbPath());
    return { ok: true };
  });

  handle('export:openPath', ({ target }) => {
    if (target && fs.existsSync(target)) shell.openPath(target);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  try {
    db.open(userData);
    cac.init(userData);
    db.purgeOldPii();
  } catch (err) {
    dialog.showErrorBox(
      'Database could not be opened',
      `${err.message}\n\nData folder:\n${path.join(userData, 'data')}\n\n` +
      'If another copy of Drop Zone Tea Party is running, close it and try again.'
    );
    app.quit();
    return;
  }

  // An app closed before the rollover and reopened after it still has to tidy
  // up the shift it left open.
  db.rollShiftIfStale();

  // Catch up on a missed day — the bar may have been shut, or the machine off.
  try {
    const caught = exports_.runBackupIfDue('daily, on launch');
    if (caught && caught.filePath) console.log(`[backup] ${caught.filePath}`);
  } catch (err) {
    console.error('[backup] startup backup failed', err);
  }

  registerIpc();
  buildMenu();
  createWindow();
  startRolloverWatch();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('before-quit', () => {
  stopRolloverWatch();
  try { db.close(); } catch { /* ignore */ }
});

// Never let a stray renderer navigate the POS somewhere else.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
});
