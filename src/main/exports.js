'use strict';

/**
 * Export paths. Two flavours:
 *   - CSV bundle: human/Excel readable, written with a UTF-8 BOM so Excel on
 *     Windows does not mangle names.
 *   - Database backup: a single consistent .db file. This is the one to copy
 *     onto a thumb drive or hand to whoever needs the data downstream — it is
 *     a complete, self-contained SQLite database.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const BOM = '﻿';

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

function money(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Report queries shaped for export
 * ------------------------------------------------------------------ */

const QUERIES = {
  orders: (h, from, to) => h.prepare(`
    SELECT o.id AS order_id, o.business_date, o.created_at, o.shift_id,
           COALESCE(p.display_name, p.dod_id, '#'||p.last4, 'Walk-in') AS patron,
           p.dod_id AS patron_customer_id,
           o.standard_drinks, o.subtotal_cents, o.payment_method, o.bartender,
           o.voided, o.void_reason, o.override_reason
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date BETWEEN ? AND ?
     ORDER BY o.created_at`).all(from, to),

  line_items: (h, from, to) => h.prepare(`
    SELECT oi.id AS line_id, o.id AS order_id, o.business_date, o.created_at,
           oi.category, oi.product_name, oi.qty,
           oi.unit_price_cents, (oi.qty * oi.unit_price_cents) AS line_cents,
           oi.standard_drinks, o.payment_method, o.bartender, o.voided
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ?
     ORDER BY o.created_at, oi.id`).all(from, to),

  patron_drinks_by_day: (h, from, to) => h.prepare(`
    SELECT o.business_date,
           COALESCE(p.display_name, p.dod_id, '#'||p.last4, 'Patron '||p.id) AS patron,
           p.dod_id AS patron_customer_id,
           COUNT(*) AS orders,
           ROUND(SUM(o.standard_drinks), 2) AS standard_drinks,
           SUM(o.subtotal_cents) AS spend_cents,
           MIN(o.created_at) AS first_drink,
           MAX(o.created_at) AS last_drink,
           SUM(CASE WHEN o.override_reason IS NOT NULL THEN 1 ELSE 0 END) AS overrides
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0 AND o.patron_id IS NOT NULL
     GROUP BY o.business_date, o.patron_id
     ORDER BY o.business_date, standard_drinks DESC`).all(from, to),

  daily_totals: (h, from, to) => h.prepare(`
    SELECT business_date, COUNT(*) AS orders,
           COUNT(DISTINCT patron_id) AS patrons,
           ROUND(SUM(standard_drinks), 2) AS standard_drinks,
           SUM(subtotal_cents) AS gross_cents
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0
     GROUP BY business_date ORDER BY business_date`).all(from, to),

  product_mix: (h, from, to) => h.prepare(`
    SELECT oi.category, oi.product_name,
           SUM(oi.qty) AS units_sold,
           SUM(oi.qty * oi.unit_price_cents) AS gross_cents,
           ROUND(SUM(oi.standard_drinks), 2) AS standard_drinks
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0
     GROUP BY oi.category, oi.product_name
     ORDER BY units_sold DESC`).all(from, to),

  inventory_on_hand: (h) => h.prepare(`
    SELECT p.id AS product_id, p.category, p.brand, p.name, p.sku,
           p.abv, p.serving_oz, p.price_cents, p.standard_drinks,
           i.qty_on_hand, i.unit, i.par_level, i.last_counted_at, p.active
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
     ORDER BY p.category, p.name`).all(),

  inventory_adjustments: (h, from, to) => h.prepare(`
    SELECT a.created_at, p.category, p.name AS product_name,
           a.delta, a.new_qty, a.reason, a.order_id, a.actor, a.note
      FROM inventory_adjustments a JOIN products p ON p.id = a.product_id
     WHERE DATE(a.created_at) BETWEEN ? AND ?
     ORDER BY a.created_at`).all(from, to),

  shifts: (h, from, to) => h.prepare(`
    SELECT s.id AS shift_id, s.business_date, s.opened_at, s.closed_at,
           s.opened_by, s.closed_by, s.drink_limit, s.note,
           (SELECT COUNT(*) FROM orders o WHERE o.shift_id = s.id AND o.voided = 0) AS orders,
           (SELECT COALESCE(SUM(o.subtotal_cents),0) FROM orders o WHERE o.shift_id = s.id AND o.voided = 0) AS gross_cents
      FROM shifts s WHERE s.business_date BETWEEN ? AND ?
     ORDER BY s.opened_at`).all(from, to),

  audit_log: (h, from, to) => h.prepare(`
    SELECT created_at, event, detail, actor FROM audit_log
     WHERE DATE(created_at) BETWEEN ? AND ? ORDER BY created_at`).all(from, to),
};

/** Add a dollars column next to any *_cents column, for spreadsheet sanity. */
function withDollars(rows) {
  return rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = v;
      if (/_cents$/.test(k)) out[k.replace(/_cents$/, '_usd')] = money(v);
    }
    return out;
  });
}

function reportNames() { return Object.keys(QUERIES); }

function runReport(name, from, to) {
  const q = QUERIES[name];
  if (!q) throw new Error(`Unknown report: ${name}`);
  return withDollars(q(db.handle(), from, to));
}

/** Write one report to a .csv file. */
function exportCsv({ name, from, to, filePath }) {
  const rows = runReport(name, from, to);
  fs.writeFileSync(filePath, toCsv(rows), 'utf8');
  db.audit('export_csv', `${name} ${from}..${to} -> ${path.basename(filePath)}`, 'bartender');
  return { name, rows: rows.length, filePath };
}

/** Write every report into one folder, plus a consistent .db snapshot. */
function exportBundle({ from, to, dirPath, includeDb = true }) {
  fs.mkdirSync(dirPath, { recursive: true });
  const written = [];

  for (const name of reportNames()) {
    const rows = runReport(name, from, to);
    const fp = path.join(dirPath, `${name}.csv`);
    fs.writeFileSync(fp, toCsv(rows), 'utf8');
    written.push({ name, rows: rows.length, file: path.basename(fp) });
  }

  if (includeDb) {
    const dbFile = path.join(dirPath, 'bar.db');
    backupDb(dbFile);
    written.push({ name: 'database', rows: null, file: 'bar.db' });
  }

  const readme = [
    `${db.getSetting('venue_name') || 'Drop Zone Tea Party'} — data export`,
    `Generated: ${new Date().toString()}`,
    `Business dates covered: ${from} to ${to}`,
    ``,
    `CSV files are UTF-8 with a BOM so Excel opens them cleanly on Windows.`,
    `Every *_cents column has a matching *_usd column in dollars.`,
    ``,
    `bar.db is a complete SQLite database — open it with DB Browser for SQLite,`,
    `Power BI, Python, or any ODBC/SQLite tool. It is the authoritative copy.`,
    ``,
    `Patrons are identified by the customer ID read from their card, or by the raw`,
    `barcode payload where no ID could be parsed. These files therefore contain`,
    `personal identifiers — handle and store them accordingly.`,
    ``,
    `Contents:`,
    ...written.map((w) => `  ${w.file}${w.rows == null ? '' : `  (${w.rows} rows)`}`),
  ].join('\r\n');
  fs.writeFileSync(path.join(dirPath, 'README.txt'), readme, 'utf8');

  db.audit('export_bundle', `${from}..${to} -> ${dirPath}`, 'bartender');
  return { dirPath, written };
}

/**
 * Consistent copy of the live database, using SQLite's own backup API so an
 * open WAL cannot produce a torn file.
 */
function backupDb(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // VACUUM INTO refuses to write over an existing file.
  if (fs.existsSync(destPath)) fs.rmSync(destPath);
  const h = db.handle();
  h.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  h.prepare('VACUUM INTO ?').run(destPath);
  db.audit('backup_db', destPath, 'bartender');
  return { filePath: destPath, bytes: fs.statSync(destPath).size };
}

/* ------------------------------------------------------------------ *
 * Printable sales report (HTML -> PDF)
 * ------------------------------------------------------------------ */

/**
 * Display currency. Distinct from money(), which deliberately returns a bare
 * number because it fills the *_usd columns of the CSVs, where a currency
 * symbol would stop Excel treating the column as numeric.
 */
const usd = (cents) => `$${money(cents)}`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const CATEGORY_LABELS = {
  beer: 'Beer', spirit: 'Spirits', wine: 'Wine',
  cocktail: 'Cocktails', na: 'Non-alcoholic', other: 'Other',
};

function prettyDate(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  return Number.isNaN(d.getTime()) ? ymd
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function delta(now, before) {
  if (!before) return 'no prior period to compare';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'level with the period before';
  return `${pct > 0 ? '+' : ''}${pct}% vs the period before`;
}

function table(headers, rows, aligns = []) {
  if (!rows.length) return '<p class="none">Nothing recorded in this range.</p>';
  const th = headers.map((h, i) => `<th${aligns[i] === 'r' ? ' class="r"' : ''}>${esc(h)}</th>`).join('');
  const tr = rows.map((r) =>
    `<tr>${r.map((c, i) => `<td${aligns[i] === 'r' ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/**
 * A single-series column chart of nightly takings, as inline SVG.
 * One hue, no legend (the heading names the series), and only the best night
 * is labelled — the table underneath carries every value.
 */
function chartSvg(series) {
  if (!series.length) return '';
  const W = 720, H = 190, PAD_L = 48, PAD_R = 10, PAD_T = 12, PAD_B = 30;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...series.map((d) => d.gross_cents));

  // Round the axis top to a clean number.
  const step = Math.pow(10, Math.floor(Math.log10(max))) / 2 || 1;
  const top = Math.ceil(max / step) * step;

  const slot = plotW / series.length;
  const barW = Math.max(1, Math.min(24, slot - 2));   // 2px surface gap, 24px cap
  const best = series.reduce((a, b) => (b.gross_cents > a.gross_cents ? b : a), series[0]);

  const gridVals = [0, top / 2, top];
  const grid = gridVals.map((v) => {
    const y = PAD_T + plotH - (v / top) * plotH;
    return `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" class="grid"/>` +
           `<text x="${PAD_L - 6}" y="${(y + 3.5).toFixed(1)}" class="tick">$${Math.round(v / 100)}</text>`;
  }).join('');

  const bars = series.map((d, i) => {
    const h = (d.gross_cents / top) * plotH;
    const x = PAD_L + i * slot + (slot - barW) / 2;
    const y = PAD_T + plotH - h;
    if (h <= 0) return '';
    const r = Math.min(4, barW / 2, h);
    // Rounded data-end, square at the baseline.
    return `<path d="M${x.toFixed(1)} ${(y + h).toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)} ` +
           `Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} ` +
           `L${(x + barW - r).toFixed(1)} ${y.toFixed(1)} Q${(x + barW).toFixed(1)} ${y.toFixed(1)} ` +
           `${(x + barW).toFixed(1)} ${(y + r).toFixed(1)} L${(x + barW).toFixed(1)} ${(y + h).toFixed(1)} Z" class="bar"/>`;
  }).join('');

  // Label only the extreme, and only when there is something to contrast it
  // against — a lone bar is not a "best night".
  let bestLabel = '';
  const bi = series.indexOf(best);
  if (best.gross_cents > 0 && series.filter((d) => d.gross_cents > 0).length > 1) {
    const h = (best.gross_cents / top) * plotH;
    const x = PAD_L + bi * slot + slot / 2;
    const y = PAD_T + plotH - h - 5;
    bestLabel = `<text x="${x.toFixed(1)}" y="${Math.max(PAD_T + 8, y).toFixed(1)}" class="peak">${usd(best.gross_cents)}</text>`;
  }

  // Keep the x-axis readable: at most ~10 ticks.
  const every = Math.max(1, Math.ceil(series.length / 10));
  const xlabels = series.map((d, i) => {
    if (i % every !== 0) return '';
    const x = PAD_L + i * slot + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 10}" class="xtick">${esc(d.date.slice(5))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
    aria-label="Takings per night from ${esc(series[0].date)} to ${esc(series[series.length - 1].date)}">
    ${grid}${bars}${bestLabel}${xlabels}
  </svg>`;
}

function buildReportHtml(rep, venueName) {
  const t = rep.totals, p = rep.previous;
  const single = rep.from === rep.to;
  const heading = single ? prettyDate(rep.from) : `${prettyDate(rep.from)} — ${prettyDate(rep.to)}`;

  const kpis = [
    ['Gross sales', usd(t.gross_cents), delta(t.gross_cents, p.gross_cents)],
    ['Orders', String(t.orders), delta(t.orders, p.orders)],
    ['Drinks served', String(t.servings), delta(t.servings, p.servings)],
    ['Patrons served', String(t.patrons), delta(t.patrons, p.patrons)],
  ].map(([label, value, sub]) =>
    `<div class="kpi"><div class="kl">${esc(label)}</div><div class="kv">${esc(value)}</div>` +
    `<div class="ks">${esc(sub)}</div></div>`).join('');

  const peakHour = rep.hourly.slice().sort((a, b) => b.cents - a.cents)[0];
  const hourLabel = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Sales report</title>
<style>
  @page { size: letter; }
  * { box-sizing: border-box; }
  body { font: 11px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #16191d; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #5b646e;
       margin: 20px 0 7px; border-bottom: 1px solid #d8dde2; padding-bottom: 4px; }
  .sub { color: #5b646e; font-size: 11px; margin: 0 0 16px; }
  .kpis { display: flex; gap: 10px; margin-bottom: 4px; }
  .kpi { flex: 1; border: 1px solid #d8dde2; border-radius: 6px; padding: 9px 11px; }
  .kl { font-size: 9px; text-transform: uppercase; letter-spacing: .07em; color: #5b646e; }
  .kv { font-size: 21px; font-weight: 600; margin-top: 2px; }
  .ks { font-size: 9.5px; color: #5b646e; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 4px 7px; border-bottom: 1px solid #e6eaee;
           font-variant-numeric: tabular-nums; }
  th { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #5b646e; }
  td.r, th.r { text-align: right; }
  .none { color: #7b848d; font-size: 10.5px; font-style: italic; }
  .two { display: flex; gap: 22px; }
  .two > div { flex: 1; min-width: 0; }
  .chart { width: 100%; height: auto; margin-top: 6px; }
  .bar { fill: #00308f; }
  .grid { stroke: #dfe4e9; stroke-width: 1; }
  .tick, .xtick { fill: #7b848d; font-size: 9px; font-variant-numeric: tabular-nums; }
  .tick { text-anchor: end; } .xtick { text-anchor: middle; }
  .peak { fill: #16191d; font-size: 9.5px; font-weight: 600; text-anchor: middle; }
  footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #d8dde2;
           color: #7b848d; font-size: 9px; }
</style></head>
<body>
  <h1>${esc(venueName)} — Sales Report</h1>
  <p class="sub">${esc(heading)}${single ? '' : ` · ${rep.span} days, ${rep.nightsOpen} with sales`}
     · generated ${esc(new Date().toLocaleString())}</p>

  <div class="kpis">${kpis}</div>

  <h2>Takings per night</h2>
  ${chartSvg(rep.series)}
  ${table(['Night', 'Orders', 'Patrons', 'Drinks', 'Std drinks', 'Gross'],
    rep.series.filter((d) => d.orders > 0).map((d) => [
      prettyDate(d.date), d.orders, d.patrons, d.servings, d.drinks, usd(d.gross_cents)]),
    ['l', 'r', 'r', 'r', 'r', 'r'])}

  <div class="two">
    <div>
      <h2>By category</h2>
      ${table(['Category', 'Units', 'Sales'], rep.byCategory.map((c) => [
        CATEGORY_LABELS[c.category] || c.category, c.units, usd(c.cents)]), ['l', 'r', 'r'])}
      <h2>Busiest hours</h2>
      ${table(['Hour', 'Orders', 'Sales'],
        rep.hourly.filter((h) => h.orders > 0).sort((a, b) => b.cents - a.cents).slice(0, 8)
          .map((h) => [hourLabel(h.hour), h.orders, usd(h.cents)]), ['l', 'r', 'r'])}
    </div>
    <div>
      <h2>Top sellers</h2>
      ${table(['Item', 'Units', 'Sales'], rep.topProducts.slice(0, 12).map((c) => [
        c.product_name, c.units, usd(c.cents)]), ['l', 'r', 'r'])}
    </div>
  </div>

  <h2>Averages</h2>
  ${table(['Measure', 'Value'], [
    ['Gross per night open', usd(rep.avgPerNight.gross_cents)],
    ['Patrons per night open', String(rep.avgPerNight.patrons)],
    ['Standard drinks per night open', String(rep.avgPerNight.drinks)],
    ['Spend per patron', usd(rep.avgPerPatron.cents)],
    ['Standard drinks per patron', String(rep.avgPerPatron.drinks)],
    ['Busiest hour', peakHour && peakHour.cents ? `${hourLabel(peakHour.hour)} (${usd(peakHour.cents)})` : '—'],
    ['Busiest night', rep.busiest ? `${prettyDate(rep.busiest.date)} (${usd(rep.busiest.gross_cents)})` : '—'],
  ], ['l', 'r'])}

  <h2>Highest consumption</h2>
  ${table(['Patron', 'Nights', 'Orders', 'Std drinks', 'Spend'],
    rep.heavyPatrons.slice(0, 15).map((h) => [h.label, h.nights, h.orders, h.drinks, usd(h.cents)]),
    ['l', 'r', 'r', 'r', 'r'])}

  <h2>Limit overrides &amp; voids</h2>
  <p class="sub" style="margin:0 0 6px">
    ${rep.voids.n} voided order${rep.voids.n === 1 ? '' : 's'} totalling ${usd(rep.voids.cents)}.
  </p>
  ${table(['Night', 'Patron', 'Reason', 'Authorised by'],
    rep.overrides.map((o) => [o.business_date, o.label, o.override_reason || '', o.bartender || '—']))}

  <footer>
    Generated offline by ${esc(venueName)} POS. Patrons are identified by the
    customer ID read from their card, or by a short card reference where none
    could be parsed. Contains personal identifiers — handle accordingly.
  </footer>
</body></html>`;
}

/* ------------------------------------------------------------------ *
 * Automatic backups
 *
 * Everything lives in one SQLite file on one machine, so that machine is a
 * single point of failure for the whole season's records. These copies go
 * somewhere else — a USB stick or a shared drive — on their own, because a
 * backup that depends on somebody remembering is not a backup.
 * ------------------------------------------------------------------ */

const BACKUP_PREFIX = 'bar-backup-';

function backupFolder() {
  const dir = db.getSetting('backup_dir');
  if (!dir) return { configured: false, dir: null, reachable: false };
  let reachable = false;
  try {
    reachable = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch { reachable = false; }
  return { configured: true, dir, reachable };
}

function listBackups() {
  const { dir, reachable } = backupFolder();
  if (!reachable) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db'))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { name: f, path: full, bytes: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** Keep the newest `keep` copies; delete the rest so a stick cannot fill up. */
function pruneBackups(keep) {
  const limit = Math.max(1, Number(keep) || 30);
  const excess = listBackups().slice(limit);
  let removed = 0;
  for (const f of excess) {
    try { fs.rmSync(f.path); removed++; } catch { /* leave it rather than fail the backup */ }
  }
  return removed;
}

/**
 * Take a copy now. Returns `{ skipped: reason }` rather than throwing when it
 * simply cannot run — an unplugged USB stick must never interrupt service.
 */
function runBackup({ reason = 'manual', force = false } = {}) {
  if (!force && db.getSetting('backup_enabled') !== '1') return { skipped: 'disabled' };

  const folder = backupFolder();
  if (!folder.configured) return { skipped: 'no-folder' };
  if (!folder.reachable) {
    db.audit('backup_failed', `folder not reachable: ${folder.dir}`, 'system');
    return { skipped: 'unreachable', dir: folder.dir };
  }

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${db.businessDate()}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const filePath = path.join(folder.dir, `${BACKUP_PREFIX}${stamp}.db`);

  try {
    backupDb(filePath);
  } catch (err) {
    db.audit('backup_failed', `${reason}: ${err.message}`, 'system');
    return { skipped: 'error', error: err.message };
  }

  const pruned = pruneBackups(db.getSetting('backup_keep'));
  db.setSetting('last_backup_at', now.toISOString());
  db.audit('backup',
    `${reason} -> ${path.basename(filePath)}${pruned ? ` (pruned ${pruned})` : ''}`, 'system');

  return { filePath, bytes: fs.statSync(filePath).size, pruned, reason };
}

/** True when nothing has been backed up yet on the current business day. */
function backupIsDue() {
  const last = db.getSetting('last_backup_at');
  if (!last) return true;
  return db.businessDate(last) !== db.businessDate();
}

function runBackupIfDue(reason) {
  if (!backupIsDue()) return { skipped: 'already-today' };
  return runBackup({ reason });
}

function backupStatus() {
  const folder = backupFolder();
  const copies = listBackups();
  return {
    ...folder,
    enabled: db.getSetting('backup_enabled') === '1',
    keep: Number(db.getSetting('backup_keep') || 30),
    lastAt: db.getSetting('last_backup_at') || null,
    due: backupIsDue(),
    count: copies.length,
    newest: copies[0] || null,
    recent: copies.slice(0, 5),
  };
}

module.exports = {
  exportCsv, exportBundle, backupDb, reportNames, runReport, toCsv, money,
  buildReportHtml,
  runBackup, runBackupIfDue, backupStatus, listBackups, pruneBackups, backupIsDue,
};
