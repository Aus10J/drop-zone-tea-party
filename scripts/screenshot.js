'use strict';

/**
 * Dev tool. Boots the app against a throwaway database seeded with a couple of
 * weeks of plausible trade, then screenshots the Reports view and renders the
 * PDF report to a PNG — so the charts can actually be looked at rather than
 * assumed correct.
 *
 *   npm run shot        (writes to .shots/)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Piping this script into something that closes early (`npm run shot | head`)
// kills stdout mid-write. Without this the EPIPE escapes as an uncaught
// exception and Electron throws up a crash dialog over the screenshot.
process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', () => {});

const OUT = path.join(__dirname, '..', '.shots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barpos-shot-'));
app.setPath('userData', tmp);

const db = require('../src/main/db');
const cac = require('../src/main/cac');
const exporter = require('../src/main/exports');

/* --- deterministic pseudo-random, so shots are reproducible --- */
let seed = 20260913;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

function seedDemo() {
  db.open(tmp);
  cac.init(tmp);

  const products = db.listProducts();
  for (const p of products) {
    db.adjustInventory({ productId: p.id, newQty: 200, reason: 'recount', actor: 'seed' });
  }

  // A pool of regulars.
  const patrons = [];
  const first = ['J.', 'T.', 'M.', 'S.', 'D.', 'A.', 'R.', 'P.', 'K.', 'C.', 'L.', 'H.', 'B.', 'N.', 'E.'];
  const last = ['Rivera', 'Okafor', 'Bennett', 'Nakamura', 'Whitfield', 'Castellanos',
                'Lindqvist', 'Mwangi', 'Delacroix', 'Ferreira', 'Vasquez', 'Abernathy',
                'Kowalski', 'Thibodeaux', 'Ashworth', 'Nguyen', 'Petrov', 'Quintero'];
  for (let i = 0; i < 84; i++) {
    const r = db.resolveCard(cac.parseScan(String(1000000000 + i * 7919)));
    db.updatePatron(r.patron.id, {
      display_name: `${first[i % first.length]} ${last[(i * 7) % last.length]}`,
      dob: `199${i % 10}-0${(i % 9) + 1}-1${i % 10}`,
    });
    patrons.push(r.patron.id);
  }

  const today = db.businessDate();
  const insOrder = db.handle().prepare(`INSERT INTO orders
    (shift_id, patron_id, business_date, created_at, subtotal_cents,
     payment_method, standard_drinks, bartender, override_reason)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insItem = db.handle().prepare(`INSERT INTO order_items
    (order_id, product_id, product_name, category, qty, unit_price_cents, standard_drinks)
    VALUES (?,?,?,?,?,?,?)`);

  for (let back = 29; back >= 0; back--) {
    const date = db.addDays(today, -back);
    const dow = new Date(`${date}T12:00:00`).getDay();
    // Quiet Monday-to-Wednesday, busy Friday and Saturday.
    const busy = dow === 5 || dow === 6 ? 1 : dow === 4 || dow === 0 ? 0.55 : 0.18;
    if (rnd() > busy * 1.25) continue;

    const shift = db.handle().prepare(
      'INSERT INTO shifts (business_date, opened_at, opened_by, drink_limit) VALUES (?,?,?,?)'
    ).run(date, `${date}T22:00:00.000Z`, 'SSgt Rivera', 3);

    const orderCount = Math.round(8 + busy * 34 * (0.6 + rnd() * 0.8));
    for (let o = 0; o < orderCount; o++) {
      const hour = 17 + Math.floor(rnd() * 7);          // 5pm–11pm
      const minute = Math.floor(rnd() * 60);
      const stamp = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
      const lines = [];
      const n = 1 + Math.floor(rnd() * 2);
      for (let l = 0; l < n; l++) {
        const p = pick(products);
        lines.push({ p, qty: 1 + Math.floor(rnd() * 2) });
      }
      const cents = lines.reduce((s, l) => s + l.p.price_cents * l.qty, 0);
      const drinks = Math.round(lines.reduce((s, l) => s + l.p.standard_drinks * l.qty, 0) * 100) / 100;

      const r = insOrder.run(
        shift.lastInsertRowid, pick(patrons), date, stamp.toISOString(), cents,
        rnd() < 0.62 ? 'cash' : 'card', drinks, 'SSgt Rivera',
        rnd() < 0.04 ? 'DD confirmed, food served' : null
      );
      for (const l of lines) {
        insItem.run(r.lastInsertRowid, l.p.id, l.p.name, l.p.category, l.qty,
                    l.p.price_cents, Math.round(l.p.standard_drinks * l.qty * 100) / 100);
      }
    }
    db.handle().prepare('UPDATE shifts SET closed_at = ? WHERE id = ?')
      .run(`${date}T02:30:00.000Z`, shift.lastInsertRowid);
  }

  const rep = db.salesReport(db.addDays(today, -29), today);
  console.log(`seeded ${rep.nightsOpen} trading nights, ${rep.totals.orders} orders, ` +
              `${(rep.totals.gross_cents / 100).toFixed(2)} gross`);
  db.close();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  seedDemo();

  require('../src/main/main.js');
  await app.whenReady();
  await sleep(1200);

  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1480, 1000);
  const js = (e) => win.webContents.executeJavaScript(e);

  // Reports, last 30 days.
  await js('document.querySelector(\'.navbtn[data-view="reports"]\').click()');
  await sleep(500);
  await js('document.querySelector(\'#quickRanges .rangebtn[data-range="30"]\').click()');
  await sleep(900);

  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'reports.png'), img.toPNG());
  console.log('wrote .shots/reports.png');

  // Hover the tallest bar so the tooltip is in the shot.
  await js(`(() => {
    const hits = Array.from(document.querySelectorAll('#salesChart .hit'));
    const bars = Array.from(document.querySelectorAll('#salesChart .bar'));
    const peak = document.querySelector('#salesChart .bar.peak');
    const i = peak ? bars.indexOf(peak) : 0;
    (hits[i] || hits[0]).dispatchEvent(new FocusEvent('focus'));
  })()`);
  await sleep(400);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'reports-tooltip.png'), img.toPNG());
  console.log('wrote .shots/reports-tooltip.png');

  // The bar (sales) screen, with a real patron loaded through the UI so the
  // category meters are populated.
  await js('document.querySelector(\'.navbtn[data-view="patrons"]\').click()');
  await sleep(600);
  await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
    const busy = rows.find(r => {
      const n = parseFloat(r.children[2].textContent);
      return n >= 2;
    }) || rows[0];
    busy.querySelector('.btn').click();
  })()`);
  await sleep(600);
  await js('Array.from(document.querySelectorAll(".cattab")).find(t => t.textContent === "Spirits").click()');
  await sleep(250);
  await js('document.querySelectorAll(".prod")[0].click()');
  await sleep(600);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'bar.png'), img.toPNG());
  console.log('wrote .shots/bar.png');

  // The patron roster, with its per-row actions.
  await js('document.querySelector(\'.navbtn[data-view="patrons"]\').click()');
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'patrons.png'), img.toPNG());
  console.log('wrote .shots/patrons.png');

  // A patron's drink history, where individual drinks can be removed.
  await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
    const busy = rows.find(r => parseFloat(r.children[2].textContent) >= 2) || rows[0];
    Array.from(busy.querySelectorAll('.btn')).find(b => b.textContent === 'Drinks').click();
  })()`);
  await sleep(800);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'history.png'), img.toPNG());
  console.log('wrote .shots/history.png');
  await js(`Array.from(document.querySelectorAll('#modalActions .btn')).find(b => b.textContent === 'Close').click()`);
  await sleep(300);

  // Admin, unlocked, showing the limit policy.
  await js('document.querySelector(\'.navbtn[data-view="admin"]\').click()');
  await sleep(350);
  await js('document.querySelector("#adminPin").value = "1234"; document.querySelector("#adminUnlock").click()');
  await sleep(700);
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'admin.png'), img.toPNG());
  console.log('wrote .shots/admin.png');

  // The printable report, rendered as an image so it can be eyeballed too.
  const pdfWin = new BrowserWindow({ show: false, width: 850, height: 1400,
    webPreferences: { javascript: false } });
  const dbNow = require('../src/main/db');
  const rep = dbNow.salesReport(dbNow.addDays(dbNow.businessDate(), -29), dbNow.businessDate());
  const html = exporter.buildReportHtml(rep, 'Drop Zone Tea Party');
  await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await sleep(700);
  const shot = await pdfWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'pdf-page1.png'), shot.toPNG());
  const pdf = await pdfWin.webContents.printToPDF({
    printBackground: true, pageSize: 'Letter', preferCSSPageSize: true });
  fs.writeFileSync(path.join(OUT, 'sales-report.pdf'), pdf);
  pdfWin.destroy();
  console.log('wrote .shots/pdf-page1.png and .shots/sales-report.pdf');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(0);
}

main().catch((err) => { console.error(err); app.exit(1); });
