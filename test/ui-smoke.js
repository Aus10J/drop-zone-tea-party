'use strict';

/**
 * Boots the real application against a throwaway data folder and drives the
 * window the way a bartender would: scan a card, tap a drink, check the
 * ticket. Catches renderer crashes, broken IPC wiring and CSP violations that
 * the main-process tests cannot see.
 *
 * Run with:  npm run test:ui
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barpos-ui-'));
app.setPath('userData', tmp);           // must happen before the app boots

const consoleErrors = [];
const pageErrors = [];

let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${extra ? `  -> ${extra}` : ''}`); }
}
function eq(label, a, b) { check(label, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

require('../src/main/main.js');          // boots the genuine app

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expr, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript(expr)) return true;
    } catch { /* page may still be loading */ }
    await sleep(100);
  }
  console.log(`  (timed out waiting for: ${label})`);
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

app.whenReady().then(async () => {
  await sleep(300);
  const win = BrowserWindow.getAllWindows()[0];

  if (!win) {
    console.log('FAIL: no window was created');
    app.exit(1);
    return;
  }

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push(`${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => pageErrors.push(`renderer gone: ${d.reason}`));
  await js(win, 'window.addEventListener("error", e => { window.__err = (window.__err||[]).concat(String(e.message)); })')
    .catch(() => {});

  try {
    console.log('\nRenderer boot');
    check('window loaded', await waitFor(win, 'typeof window.api === "object"', 'preload bridge'));
    check('preload exposes the API surface',
      await js(win, '["bootstrap","scan","product","order","ticket","inventory","report","settings","exporter"].every(k => k in window.api)'));
    check('node is not reachable from the renderer',
      await js(win, 'typeof window.require === "undefined" && typeof window.process === "undefined"'));

    check('app finished booting', await waitFor(win, 'document.querySelectorAll(".prod").length > 0', 'product grid'));
    const prodCount = await js(win, 'document.querySelectorAll(".prod").length');
    eq('five beers on the Beer tab', prodCount, 5);
    const tabs = await js(win, 'JSON.stringify(Array.from(document.querySelectorAll(".cattab")).map(t => t.textContent))');
    eq('three menu categories, all alcoholic', tabs, '["Beer","Spirits","Wine"]');
    eq('venue name rendered', await js(win, 'document.querySelector("#venueName").textContent'), 'Drop Zone Tea Party');
    check('USAF blue is the active accent',
      await js(win, 'getComputedStyle(document.documentElement).getPropertyValue("--af-blue").trim()') === '#00308f');
    check('nav highlight uses the blue, not the old maroon',
      await js(win, 'getComputedStyle(document.querySelector(".navbtn.active")).backgroundColor') === 'rgb(0, 48, 143)');

    console.log('\nTicket flow');
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    check('ticket line appears', await waitFor(win, 'document.querySelectorAll(".tline").length === 1', 'ticket line'));
    eq('beer priced at $5.00', await js(win, 'document.querySelector("#tTotal").textContent'), '$5.00');
    eq('counted as one drink, with the ABV figure alongside',
      await js(win, 'document.querySelector("#tDrinks").textContent'), '1 (1.4 std)');
    check('no payment selector — card is the only tender',
      await js(win, 'document.querySelector("#paySelect") === null'));
    check('no walk-in escape hatch', await js(win, 'document.querySelector("#walkInBtn") === null'));
    check('the sale is blocked with no card scanned',
      await js(win, 'document.querySelector("#completeSale").disabled === true'));
    eq('and says why', await js(win, 'document.querySelector("#completeSale").textContent'),
      'Scan a card to sell');

    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    check('tapping again bumps the quantity',
      await waitFor(win, 'document.querySelector("#tTotal").textContent === "$10.00"', 'qty bump'));
    await js(win, 'document.querySelector(".qty-btn").click()');   // the minus button
    check('minus decrements',
      await waitFor(win, 'document.querySelector("#tTotal").textContent === "$5.00"', 'qty down'));

    console.log('\nSwitching categories');
    await js(win, 'Array.from(document.querySelectorAll(".cattab")).find(t => t.textContent === "Spirits").click()');
    check('spirits load', await waitFor(win, 'document.querySelectorAll(".prod").length === 6', 'spirit grid'));
    check('$6.00 spirits priced',
      await js(win, 'document.querySelector(".prod .prod-price").textContent === "$6.00"'));

    console.log('\nScanning a card');
    await js(win, `(async () => {
      const r = await window.api.scan.resolve({ raw: 'N1AB3CD4EF5DOE JOHN A       GH6IJ7KL8MN9OP0QR1ST2UV3' });
      window.__scan = r;
      return r.ok;
    })()`);
    check('scan resolved over IPC', await waitFor(win, 'window.__scan && window.__scan.ok', 'scan ipc'));
    check('new patron flagged as new', await js(win, 'window.__scan.data.isNew === true'));
    check('name read off the barcode',
      await js(win, 'window.__scan.data.parsed.suggestedName === "JOHN A DOE"'),
      await js(win, 'JSON.stringify(window.__scan.data.parsed)'));
    eq('drink count starts at zero', await js(win, 'window.__scan.data.status.today.servings'), 0);
    eq('night limit surfaced on the scan', await js(win, 'window.__scan.data.status.limits.total'), 4);

    console.log('\nTyping a DoD ID for someone new');
    await js(win, 'document.querySelector("#manualScan").value = "7654321098"; document.querySelector("#manualScanBtn").click()');
    check('an unknown ID offers to add them',
      await waitFor(win, '!document.querySelector("#modalRoot").classList.contains("hidden")', 'add prompt'));
    check('the add dialog takes first and last name separately',
      await js(win, 'document.querySelectorAll("#modalBody input").length') === 3);
    check('the typed ID is carried into the DoD ID field',
      await js(win, 'document.querySelectorAll("#modalBody input")[2].value') === '7654321098');
    await js(win, `Array.from(document.querySelectorAll('#modalActions .btn'))
      .find(b => b.textContent === 'Add Patron').click()`);
    check('adding with no name at all works',
      await waitFor(win, '!document.querySelector("#patronCard").classList.contains("hidden")', 'panel'));
    eq('labelled by the stored DoD ID',
      await js(win, 'document.querySelector("#pName").textContent'), 'ID 7654321098');
    eq('and is already counting', await js(win, 'document.querySelector("#pCount").textContent'), '0 / 4');
    check('the identifier is on the record', await js(win, `(async () => {
      const r = await window.api.patron.list({ search: '7654321098' });
      return r.data.length === 1 && r.data[0].dod_id === '7654321098';
    })()`));

    // A scanned card payload is unambiguous, so it still needs no confirmation.
    await js(win, 'document.querySelector("#manualScan").value = "QQZZ4417738299100237764411AABB"; document.querySelector("#manualScanBtn").click()');
    await sleep(600);
    check('a scanned card still keys in nothing',
      await js(win, 'document.querySelector("#modalRoot").classList.contains("hidden")'));
    check('and gets a readable card reference',
      await js(win, 'document.querySelector("#pName").textContent').then((t) => /^Card …/.test(t)),
      await js(win, 'document.querySelector("#pName").textContent'));

    console.log('\nPartial DoD ID in the bar lookup box');
    const patronsBefore = await js(win,
      '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()');

    // A fragment of an ID already on file must load that person — this used to
    // hash the fragment and silently create a junk patron instead.
    await js(win, `(() => {
      document.querySelector('#clearPatron') && document.querySelector('#clearPatron').click();
      const s = document.querySelector('#manualScan');
      s.value = '765432';
      document.querySelector('#manualScanBtn').click();
    })()`);
    check('a partial ID loads the existing patron', await waitFor(win,
      'document.querySelector("#pName") && document.querySelector("#pName").textContent === "ID 7654321098"',
      'partial lookup'));
    eq('no new patron was created',
      await js(win, '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()'),
      patronsBefore);

    // The last four works the same way.
    await js(win, 'document.querySelector("#clearPatron").click()');
    await sleep(200);
    await js(win, `(() => {
      const s = document.querySelector('#manualScan');
      s.value = '1098';
      document.querySelector('#manualScanBtn').click();
    })()`);
    check('the last four loads them too', await waitFor(win,
      'document.querySelector("#pName") && document.querySelector("#pName").textContent === "ID 7654321098"',
      'last four lookup'));

    // A term matching nobody offers to add them rather than creating silently.
    await js(win, `(() => {
      const s = document.querySelector('#manualScan');
      s.value = 'Thibodeaux';
      document.querySelector('#manualScanBtn').click();
    })()`);
    check('an unmatched entry offers to add them', await waitFor(win,
      '!document.querySelector("#modalRoot").classList.contains("hidden")', 'add prompt'));
    check('a typed word lands in the last-name field',
      await js(win, 'document.querySelectorAll("#modalBody input")[1].value') === 'Thibodeaux');
    check('the first name is left empty and optional',
      await js(win, 'document.querySelectorAll("#modalBody input")[0].value') === ''
      && await js(win, 'document.querySelectorAll("#modalBody input")[0].placeholder') === 'optional');
    check('and the DoD ID is optional too', await js(win,
      'document.querySelectorAll("#modalBody input")[2].placeholder') === 'optional');

    await js(win, `Array.from(document.querySelectorAll('#modalActions .btn'))
      .find(b => b.textContent === 'Cancel').click()`);
    eq('cancelling creates nobody',
      await js(win, '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()'),
      patronsBefore);

    // Adding by surname alone — no DoD ID anywhere in the flow.
    await js(win, `(() => {
      const s = document.querySelector('#manualScan');
      s.value = 'Thibodeaux';
      document.querySelector('#manualScanBtn').click();
    })()`);
    await waitFor(win, '!document.querySelector("#modalRoot").classList.contains("hidden")', 'add prompt');
    await js(win, `(() => {
      document.querySelectorAll('#modalBody input')[0].value = 'Dominique';
      Array.from(document.querySelectorAll('#modalActions .btn'))
        .find(b => b.textContent === 'Add Patron').click();
    })()`);
    check('they are added and loaded straight away', await waitFor(win,
      'document.querySelector("#pName") && document.querySelector("#pName").textContent === "Dominique Thibodeaux"',
      'added by name'));
    check('first and last are stored separately', await js(win, `(async () => {
      const r = await window.api.patron.find({ term: 'Thibodeaux' });
      return r.data.length === 1 && r.data[0].first_name === 'Dominique'
        && r.data[0].last_name === 'Thibodeaux';
    })()`));
    check('and the first name finds them too', await js(win, `(async () => {
      const r = await window.api.patron.find({ term: 'Dominiq' });
      return r.data.length === 1;
    })()`));
    eq('exactly one patron was created',
      await js(win, '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()'),
      patronsBefore + 1);
    check('and searching the surname now finds them', await js(win, `(async () => {
      const r = await window.api.patron.find({ term: 'thibo' });
      return r.data.length === 1 && r.data[0].display_name === 'Dominique Thibodeaux';
    })()`));

    await js(win, 'document.querySelector("#clearPatron").click()');
    await sleep(200);

    console.log('\nCompleting a sale');
    await js(win, 'document.querySelector(\'.navbtn[data-view="patrons"]\').click()');
    check('the scanned patron is in the roster',
      await waitFor(win, 'document.querySelectorAll("#patronTable tbody tr").length >= 1', 'patron row'));
    // Open a known patron, so later assertions can name who did the drinking.
    await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
      const row = rows.find(r => /7654321098/.test(r.textContent));
      Array.from(row.querySelectorAll('.btn')).find(b => b.textContent === 'Open').click();
    })()`);
    check('opening a patron jumps back to the bar with them loaded', await waitFor(win,
      'document.querySelector("#view-bar").classList.contains("active") && !document.querySelector("#patronCard").classList.contains("hidden")',
      'patron loaded'));

    await js(win, 'document.querySelector("#clearTicket").click()');
    await sleep(250);
    await js(win, 'Array.from(document.querySelectorAll(".cattab")).find(t => t.textContent === "Beer").click()');
    await sleep(200);
    // Two of the same drink, so a later single-drink removal leaves the order
    // standing rather than emptying it.
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    await sleep(200);
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    check('ticket built', await waitFor(win,
      'document.querySelectorAll(".tline").length === 1 && document.querySelector(".qty-val").textContent === "2"',
      'ticket line'));

    await js(win, 'document.querySelector("#completeSale").click()');
    check('sale completes and lands in Recent',
      await waitFor(win, 'document.querySelectorAll("#recentList .rline").length >= 1', 'recent order'));
    check('ticket clears after the sale',
      await js(win, 'document.querySelectorAll(".tline").length === 0'));

    console.log('\nUndo last sale');
    check('the undo button is enabled once there is a sale', await waitFor(win,
      'document.querySelector("#undoLast").disabled === false', 'undo enabled'));
    check('and names what it would reverse', await js(win,
      'document.querySelector("#undoLast").title').then((t) => /\$/.test(t)));

    await js(win, 'document.querySelector("#undoLast").click()');
    check('undo asks for a reason and a PIN', await waitFor(win,
      'document.querySelectorAll("#modalBody input").length === 2', 'undo confirm'));
    await js(win, `(() => {
      const i = document.querySelectorAll('#modalBody input');
      i[0].value = 'wrong button';
      i[1].value = '1234';
      Array.from(document.querySelectorAll('#modalActions .btn'))
        .find(b => b.textContent === 'Undo Sale').click();
    })()`);
    check('the sale is reversed', await waitFor(win, `(async () => {
      const r = await window.api.patron.find({ term: '7654321098' });
      return r.data.length === 1 && r.data[0].drinks_today === 0;
    })()`, 'undone'));
    check('the order shows as voided in Recent', await waitFor(win,
      'document.querySelectorAll("#recentList .rline.voided").length >= 1', 'voided row'));
    check('and undo disables itself with nothing left to reverse',
      await js(win, 'document.querySelector("#undoLast").disabled === true'));

    // Ring it back up so the rest of the suite has a sale to work with.
    await js(win, `(() => {
      const s = document.querySelector('#manualScan');
      s.value = '7654321098';
      document.querySelector('#manualScanBtn').click();
    })()`);
    await waitFor(win, '!document.querySelector("#patronCard").classList.contains("hidden")', 'reloaded');
    await js(win, 'Array.from(document.querySelectorAll(".cattab")).find(t => t.textContent === "Beer").click()');
    await sleep(200);
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    await sleep(200);
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    await waitFor(win, 'document.querySelector(".qty-val").textContent === "2"', 'rebuilt ticket');
    await js(win, 'document.querySelector("#completeSale").click()');
    check('re-rung for the remaining tests', await waitFor(win, `(async () => {
      const r = await window.api.patron.find({ term: '7654321098' });
      return r.data.length === 1 && r.data[0].drinks_today === 2;
    })()`, 're-rung'));

    console.log('\nScreen resets for the next customer');
    check('the patron panel clears', await waitFor(win,
      'document.querySelector("#patronCard").classList.contains("hidden")', 'panel cleared'));
    check('the scan prompt is back',
      await js(win, '!document.querySelector("#scanIdle").classList.contains("hidden")'));
    check('the lookup box is focused and empty', await waitFor(win,
      'document.activeElement === document.querySelector("#manualScan") && document.querySelector("#manualScan").value === ""',
      'lookup focused'));
    check('and the sale is confirmed on screen', await js(win,
      'Array.from(document.querySelectorAll("#toastRoot .toast")).some(t => /Ready for the next card/.test(t.textContent))'));

    // Bring them back up to confirm the drink actually landed on their count.
    await js(win, `(() => {
      const s = document.querySelector('#manualScan');
      s.value = '7654321098';
      document.querySelector('#manualScanBtn').click();
    })()`);
    check('re-finding them shows the drink on their count', await waitFor(win,
      'document.querySelector("#pCount") && document.querySelector("#pCount").textContent === "2 / 4"',
      'drink count'));
    check('pips reflect the poured drinks',
      await js(win, 'document.querySelectorAll("#pPips .pip.on").length === 2'));

    console.log('\nCategory caps on the patron panel');
    check('three category meters shown',
      await js(win, 'document.querySelectorAll("#pGroups .gmeter").length === 3'));
    const meters = await js(win, `JSON.stringify(
      Array.from(document.querySelectorAll('#pGroups .gmeter')).map(m => ({
        label: m.querySelector('.gm-label').textContent,
        count: m.querySelector('.gm-count').textContent,
        full: m.classList.contains('full'),
      })))`);
    check('the beer meter moved', meters.includes('"label":"Beer","count":"2 / 4"'), meters);
    check('liquor still untouched at 0 of 3',
      meters.includes('"label":"Liquor","count":"0 / 3"'), meters);
    check('nothing is cut off yet', !JSON.parse(meters).some((m) => m.full), meters);

    // The meters must track the live ticket, not just what is already rung up.
    await js(win, 'Array.from(document.querySelectorAll(".cattab")).find(t => t.textContent === "Spirits").click()');
    await sleep(250);
    await js(win, 'document.querySelectorAll(".prod")[0].click()');
    await sleep(450);
    const liveMeters = await js(win, `JSON.stringify(
      Array.from(document.querySelectorAll('#pGroups .gmeter')).map(m =>
        m.querySelector('.gm-label').textContent + ' ' + m.querySelector('.gm-count').textContent))`);
    check('adding a spirit moves the liquor meter immediately',
      liveMeters.includes('Liquor 1 / 3'), liveMeters);
    check('and leaves beer where it was', liveMeters.includes('Beer 2 / 4'), liveMeters);
    await js(win, 'document.querySelector("#clearTicket").click()');
    await sleep(300);

    console.log('\nSearching the roster');
    await js(win, 'document.querySelector(\'.navbtn[data-view="patrons"]\').click()');
    await sleep(600);
    // The patron who just bought a beer must be findable by the last four of
    // their ID, with their drink count intact — this is what was broken.
    await js(win, `(() => {
      const s = document.querySelector('#patronSearch');
      s.value = '1098';
      s.dispatchEvent(new Event('input'));
    })()`);
    check('searching the last four finds them', await waitFor(win,
      'document.querySelectorAll("#patronTable tbody tr").length === 1', 'search hit'));
    const hit = await js(win, `(() => {
      const cells = document.querySelectorAll('#patronTable tbody tr td');
      return JSON.stringify({ dod: cells[1].textContent, tonight: cells[2].textContent });
    })()`);
    check('the row shows the right DoD ID', hit.includes('"dod":"7654321098"'), hit);
    check('and their drinks tonight are not zeroed by the search',
      hit.includes('"tonight":"2"'), hit);

    await js(win, `(() => {
      const s = document.querySelector('#patronSearch');
      s.value = '';
      s.dispatchEvent(new Event('input'));
    })()`);
    check('clearing the search restores the full roster', await waitFor(win,
      'document.querySelectorAll("#patronTable tbody tr").length > 1', 'roster back'));
    check('and the drinker is sorted to the top', await js(win,
      'document.querySelectorAll("#patronTable tbody tr")[0].querySelectorAll("td")[2].textContent') === '2');

    console.log('\nRemoving a drink from a patron profile');
    await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
      const row = rows.find(r => /7654321098/.test(r.textContent));
      Array.from(row.querySelectorAll('.btn')).find(b => b.textContent === 'Drinks').click();
    })()`);
    check('the drinks history opens from the roster', await waitFor(win,
      '!document.querySelector("#modalRoot").classList.contains("hidden") && document.querySelectorAll("#modalBody .hist-order").length >= 1',
      'history modal'));
    check('their drink is listed', await js(win,
      'document.querySelector("#modalBody .hist-item .hist-name").textContent').then((t) => t.length > 0));
    check('with a Remove button per drink', await js(win,
      'document.querySelectorAll("#modalBody .hist-item .btn").length >= 1'));

    await js(win, 'document.querySelector("#modalBody .hist-item .btn").click()');
    check('removing asks for a reason and a PIN', await waitFor(win,
      'document.querySelectorAll(\'#modalBody input\').length === 2', 'remove confirm'));
    await js(win, `(() => {
      const inputs = document.querySelectorAll('#modalBody input');
      inputs[0].value = 'rung up by mistake';
      inputs[1].value = '1234';
      Array.from(document.querySelectorAll('#modalActions .btn'))
        .find(b => b.textContent === 'Remove Drink').click();
    })()`);
    check('the drink comes off their count', await waitFor(win, `(async () => {
      const r = await window.api.patron.find({ term: '7654321098' });
      return r.data.length === 1 && r.data[0].drinks_today === 1;
    })()`, 'count dropped'));
    check('and the roster reflects it', await waitFor(win,
      `Array.from(document.querySelectorAll('#patronTable tbody tr'))
         .filter(r => /7654321098/.test(r.textContent))
         .every(r => r.querySelectorAll('td')[2].textContent === '1')`,
      'roster updated'));
    await js(win, `(() => {
      const btn = Array.from(document.querySelectorAll('#modalActions .btn')).find(b => b.textContent === 'Close');
      if (btn) btn.click();
    })()`);
    await sleep(300);

    console.log('\nEditing and deleting patrons');
    await js(win, 'document.querySelector(\'.navbtn[data-view="patrons"]\').click()');
    await sleep(600);
    check('each row offers Open, Edit and Delete', await js(win,
      'Array.from(document.querySelectorAll("#patronTable tbody tr")[0].querySelectorAll(".btn")).map(b => b.textContent).join(",")')
      === 'Open,Drinks,Edit,Delete');

    // Edit a patron from the roster and confirm it lands.
    await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
      const row = rows.find(r => /7654321098/.test(r.textContent));
      window.__editId = row;
      Array.from(row.querySelectorAll('.btn')).find(b => b.textContent === 'Edit').click();
    })()`);
    check('the details modal opens', await waitFor(win,
      '!document.querySelector("#modalRoot").classList.contains("hidden")', 'edit modal'));
    await js(win, `(() => {
      const inputs = document.querySelectorAll('#modalBody input');
      inputs[0].value = 'Renamed Patron';
      Array.from(document.querySelectorAll('#modalActions .btn')).find(b => b.textContent === 'Save').click();
    })()`);
    check('the edit saves and the table refreshes', await waitFor(win,
      'Array.from(document.querySelectorAll("#patronTable tbody tr")).some(r => /Renamed Patron/.test(r.textContent))',
      'renamed'));

    // Delete asks for the PIN and states what happens to the history.
    await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll('#patronTable tbody tr'));
      const row = rows.find(r => /Renamed Patron/.test(r.textContent));
      Array.from(row.querySelectorAll('.btn')).find(b => b.textContent === 'Delete').click();
    })()`);
    check('the delete confirm opens', await waitFor(win,
      '!document.querySelector("#modalRoot").classList.contains("hidden")', 'delete modal'));
    check('it says the sales are kept', await js(win,
      '/kept and stay in the reports|no orders on record/.test(document.querySelector("#modalBody").textContent)'));
    check('and asks for a manager PIN',
      await js(win, 'document.querySelectorAll(\'#modalBody input[type="password"]\').length === 1'));

    await js(win, `(() => {
      document.querySelector('#modalBody input[type="password"]').value = '1234';
      Array.from(document.querySelectorAll('#modalActions .btn')).find(b => b.textContent === 'Delete Patron').click();
    })()`);
    check('the patron is removed from the roster', await waitFor(win,
      '!Array.from(document.querySelectorAll("#patronTable tbody tr")).some(r => /Renamed Patron/.test(r.textContent))',
      'deleted'));

    console.log('\nViews');
    for (const view of ['inventory', 'patrons', 'reports', 'admin']) {
      await js(win, `document.querySelector('.navbtn[data-view="${view}"]').click()`);
      await sleep(400);
      check(`${view} view renders`,
        await js(win, `document.querySelector('#view-${view}').classList.contains('active')`));
    }

    console.log('\nAdmin lock');
    check('admin starts locked', await js(win, '!document.querySelector("#adminLock").classList.contains("hidden")'));
    check('admin body hidden while locked', await js(win, 'document.querySelector("#adminBody").classList.contains("hidden")'));
    await js(win, 'document.querySelector("#adminPin").value = "0000"; document.querySelector("#adminUnlock").click()');
    await sleep(500);
    check('wrong PIN keeps it locked', await js(win, '!document.querySelector("#adminLock").classList.contains("hidden")'));
    await js(win, 'document.querySelector("#adminPin").value = "1234"; document.querySelector("#adminUnlock").click()');
    check('correct PIN unlocks', await waitFor(win, 'document.querySelector("#adminLock").classList.contains("hidden")', 'unlock'));

    console.log('\nDrink limit control');
    eq('limit dial shows the night total', await js(win, 'document.querySelector("#limitNum").textContent'), '4');
    eq('beer cap shown', await js(win, 'document.querySelector("#setLimitBeer").value'), '4');
    eq('liquor cap shown', await js(win, 'document.querySelector("#setLimitLiquor").value'), '3');
    check('the policy is spelled out in words', await js(win,
      'document.querySelector("#limitExplain").textContent') ===
      'In practice: 4 drinks a night per patron, with no more than 3 liquor. Beer and wine are capped only by the night total.');

    await js(win, 'document.querySelector("#limitUp").click(); document.querySelector("#limitUp").click()');
    eq('stepper raises the limit in whole drinks',
      await js(win, 'document.querySelector("#limitNum").textContent'), '6');
    await js(win, 'document.querySelector("#limitDown").click()');
    eq('stepper lowers it', await js(win, 'document.querySelector("#limitNum").textContent'), '5');
    await js(win, 'document.querySelector("#saveLimits").click()');
    check('limit persists', await waitFor(win,
      '(async () => { const r = await window.api.settings.all(); return r.data.drink_limit === "5"; })()', 'limit save'));

    await js(win, 'document.querySelector("#setLimitLiquor").value = "2"; document.querySelector("#saveLimits").click()');
    check('category caps persist too', await waitFor(win,
      '(async () => { const r = await window.api.settings.all(); return r.data.limit_liquor === "2"; })()', 'cap save'));

    // put it back
    await js(win, `
      document.querySelector("#setLimit").value = "4";
      document.querySelector("#setLimit").dispatchEvent(new Event("input"));
      document.querySelector("#setLimitLiquor").value = "3";
      document.querySelector("#saveLimits").click();
    `);
    await sleep(400);
    check('price summary rendered', await js(win, 'document.querySelectorAll("#priceSummary .stat").length >= 3'));

    console.log('\nBackups');
    check('the panel warns when no folder is set', await waitFor(win,
      'document.querySelector("#backupStatus").textContent.includes("No backup folder chosen")',
      'backup warning'));
    check('automatic backups default to on',
      await js(win, 'document.querySelector("#backupEnabled").checked === true'));
    check('with a retention count', await js(win,
      'parseInt(document.querySelector("#backupKeep").value, 10) > 0'));
    check('backing up with no folder says why, and does not throw', await js(win, `(async () => {
      const r = await window.api.backup.now();
      return r.ok && r.data.skipped === 'no-folder';
    })()`));
    check('status reports unconfigured over IPC', await js(win, `(async () => {
      const r = await window.api.backup.status();
      return r.ok && r.data.configured === false && r.data.enabled === true;
    })()`));

    console.log('\nEditing a price');
    await js(win, 'document.querySelector(".navbtn[data-view=\\"inventory\\"]").click()');
    check('inventory table populated',
      await waitFor(win, 'document.querySelectorAll("#invTable tbody tr").length >= 14', 'inventory rows'));
    check('every row has an editable price field',
      await js(win, 'document.querySelectorAll("#invTable .price-cell input").length >= 14'));
    check('non-alcoholic is not offered when adding an item', await js(win, `(() => {
      document.querySelector('#newProductBtn').click();
      const opts = Array.from(document.querySelectorAll('#modalBody select option')).map(o => o.value);
      const has = opts.includes('na');
      document.querySelector('#modalRoot .modal-backdrop').dispatchEvent(new KeyboardEvent('keydown'));
      Array.from(document.querySelectorAll('#modalActions .btn')).find(b => b.textContent === 'Cancel').click();
      return !has;
    })()`));
    await js(win, `(() => {
      const rows = Array.from(document.querySelectorAll('#invTable tbody tr'));
      const row = rows.find(r => r.textContent.includes('Tuborg Green'));
      const inp = row.querySelector('.price-cell input');
      window.__priceBefore = inp.value;
      inp.value = '5.75';
      inp.dispatchEvent(new Event('blur'));
    })()`);
    check('inline price edit saves', await waitFor(win,
      '(async () => { const r = await window.api.product.list({}); return r.data.find(p => p.name === "Tuborg Green").price_cents === 575; })()',
      'price save'));
    check('the menu button picked up the new price', await waitFor(win,
      '(() => { const b = Array.from(document.querySelectorAll(".prod")).find(x => x.textContent.includes("Tuborg")); return !b || b.textContent.includes("$5.75"); })()',
      'menu reprice'));
    console.log('\nReports');
    await js(win, 'document.querySelector(".navbtn[data-view=\\"reports\\"]").click()');
    check('report cards render', await waitFor(win, 'document.querySelectorAll("#repCards .stat").length === 5', 'report cards'));
    check('export report list filled', await waitFor(win, 'document.querySelector("#expReport").options.length >= 8', 'report names'));
    check('one filter row scopes the page — no per-card date pickers',
      await js(win, 'document.querySelectorAll("#view-reports input[type=date]").length === 2'));

    console.log('\nSales chart');
    check('chart renders bars', await waitFor(win, 'document.querySelectorAll("#salesChart .bar").length >= 1', 'bars'));
    // Polled, not sampled once: the chart redraws on load and again on resize,
    // and getComputedStyle on a node detached mid-redraw returns a default.
    const fillOk = await waitFor(win, `(() => {
      const b = document.querySelector('#salesChart .bar');
      return !!b && getComputedStyle(b).fill === 'rgb(59, 125, 216)';
    })()`, 'bar fill settles');
    check('bar uses the lighter dark-mode step, not the too-dark brand blue', fillOk,
      await js(win, `(() => {
        const b = document.querySelector('#salesChart .bar');
        return b ? getComputedStyle(b).fill + ' class=' + b.getAttribute('class') : 'no bar';
      })()`));
    check('gridlines are solid hairlines, never dashed',
      await js(win, '(() => { const g = document.querySelector("#salesChart .grid"); return g ? getComputedStyle(g).strokeDasharray : "missing"; })()') === 'none');
    check('single series carries no legend box',
      await js(win, 'document.querySelectorAll("#view-reports .legend").length === 0'));
    check('only the peak is directly labelled',
      await js(win, 'document.querySelectorAll("#salesChart .peak-label").length <= 1'));
    check('every night has a full-height hit target',
      await js(win, 'document.querySelectorAll("#salesChart .hit").length === document.querySelectorAll("#salesTable tbody tr").length'));

    await js(win, 'document.querySelector("#salesChart .hit").dispatchEvent(new FocusEvent("focus"))');
    check('tooltip opens on keyboard focus, not just hover',
      await waitFor(win, '!document.querySelector("#chartTip").classList.contains("hidden")', 'tooltip'));
    check('tooltip carries the value', await js(win, 'document.querySelector("#chartTip").textContent.includes("$")'));

    await js(win, 'Array.from(document.querySelectorAll("#chartToggle .segbtn")).find(b => b.dataset.mode === "table").click()');
    check('table view twin exists for the chart', await waitFor(win,
      '!document.querySelector("#salesTableWrap").classList.contains("hidden") && document.querySelector("#chartWrap").classList.contains("hidden")',
      'table twin'));
    await js(win, 'Array.from(document.querySelectorAll("#chartToggle .segbtn")).find(b => b.dataset.mode === "chart").click()');

    console.log('\nDate ranges');
    await js(win, 'document.querySelector(\'#quickRanges .rangebtn[data-range="7"]\').click()');
    check('last-7 range gives a continuous 7-night axis',
      await waitFor(win, 'document.querySelectorAll("#salesChart .hit").length === 7', '7 nights'));
    check('range note explains what it compares against',
      await js(win, 'document.querySelector("#repRangeNote").textContent.includes("7 days")'));
    check('breakdown tables populated',
      await js(win, 'document.querySelectorAll("#repCat tbody tr").length >= 1'));
    check('busiest-hours table populated',
      await js(win, 'document.querySelectorAll("#repHour tbody tr").length >= 1'));
    check('no by-payment table now that card is the only tender',
      await js(win, 'document.querySelector("#repPay") === null'));
    check('reports lead with drinks served',
      await js(win, 'document.querySelector("#repCards .stat:nth-child(2) .stat-label").textContent') === 'Drinks served');

    console.log('\nPDF report');
    {
      const dbMod = require('../src/main/db');
      const exportsMod = require('../src/main/exports');
      const day = dbMod.businessDate();
      const html = exportsMod.buildReportHtml(dbMod.salesReport(day, day), 'Drop Zone Tea Party');
      const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
      let buf = null;
      try {
        await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        buf = await pdfWin.webContents.printToPDF({
          printBackground: true, pageSize: 'Letter', preferCSSPageSize: true,
        });
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
      }
      check('report HTML renders to a real PDF', !!buf && buf.length > 2000, buf ? `${buf.length} bytes` : 'null');
      check('PDF has a valid header', !!buf && buf.subarray(0, 5).toString('latin1') === '%PDF-');
    }

    console.log('\nBusiness-day rollover');
    {
      const dbMod = require('../src/main/db');
      const today = dbMod.businessDate();
      // Drive the exact event the clock watcher emits at the rollover hour.
      win.webContents.send('business-date', {
        businessDate: today, previous: dbMod.addDays(today, -1),
      });
      check('the bartender is told every count reset', await waitFor(win,
        'Array.from(document.querySelectorAll("#toastRoot .toast")).some(t => /drink count has reset/.test(t.textContent))',
        'rollover toast'));
      check('and that the old shift was closed out', await js(win,
        'Array.from(document.querySelectorAll("#toastRoot .toast")).some(t => /closed out automatically/.test(t.textContent))'));
      check('the window re-synced without error', await waitFor(win,
        'document.querySelectorAll(".prod").length > 0 && document.querySelector("#venueName").textContent.length > 0',
        'resync'));
      eq('and still shows the right business date',
        await js(win, 'document.querySelector("#topMeta").textContent.split("  ·  ")[0]'),
        new Date(`${today}T12:00:00`).toLocaleDateString(undefined,
          { year: 'numeric', month: 'short', day: 'numeric' }));
    }

    console.log('\nBarcode scanner (keyboard wedge)');
    {
      // A wedge scanner is just a keyboard that types very fast and presses
      // Enter. These dispatch the same events one would.
      const CARD = 'N7QQ2WW3EE4MURPHY SEAN T     ZZ1XX2CC3VV4BB5NN6MM7';
      const wedge = (text) => `(() => {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        const fire = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        for (const ch of ${JSON.stringify(text)}) fire(ch);
        fire('Enter');
      })()`;

      await js(win, 'document.querySelector(\'.navbtn[data-view="bar"]\').click()');
      await sleep(300);
      await js(win, 'if (document.querySelector("#clearPatron")) document.querySelector("#clearPatron").click()');
      await sleep(300);

      // 1. Nothing focused — the global capture should pick it up.
      await js(win, wedge(CARD));
      check('a scan with nothing focused loads a patron', await waitFor(win,
        '!document.querySelector("#patronCard").classList.contains("hidden")', 'wedge scan'));
      const firstLabel = await js(win, 'document.querySelector("#pName").textContent');
      check('and reads the name off the barcode', /MURPHY|SEAN/i.test(firstLabel), firstLabel);

      // 2. Same card again — must be the same person, not a duplicate.
      const countAfterFirst = await js(win,
        '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()');
      await js(win, 'document.querySelector("#clearPatron").click()');
      await sleep(300);
      await js(win, wedge(CARD));
      await waitFor(win, '!document.querySelector("#patronCard").classList.contains("hidden")', 'rescan');
      eq('re-scanning the same card creates nobody new',
        await js(win, '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()'),
        countAfterFirst);
      eq('and lands on the same patron',
        await js(win, 'document.querySelector("#pName").textContent'), firstLabel);

      // 3. Scanned into the focused lookup box — the state the app parks in
      //    after every sale, so this is the common case in service.
      await js(win, 'document.querySelector("#clearPatron").click()');
      await sleep(400);
      check('the lookup box holds focus between customers',
        await js(win, 'document.activeElement === document.querySelector("#manualScan")'));
      await js(win, `(() => {
        const s = document.querySelector('#manualScan');
        s.focus();
        s.value = ${JSON.stringify(CARD)};
        s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      check('a scan typed into the focused box finds the same patron', await waitFor(win,
        `document.querySelector("#pName") && document.querySelector("#pName").textContent === ${JSON.stringify(firstLabel)}`,
        'focused scan'));
      eq('still no duplicate',
        await js(win, '(async () => (await window.api.patron.list({ limit: 500 })).data.length)()'),
        countAfterFirst);

      // 4. Scanning while on another screen should bring the bar up.
      await js(win, 'document.querySelector("#clearPatron").click()');
      await sleep(200);
      await js(win, 'document.querySelector(\'.navbtn[data-view="reports"]\').click()');
      await sleep(500);
      await js(win, wedge(CARD));
      check('scanning from another screen jumps back to the bar', await waitFor(win,
        'document.querySelector("#view-bar").classList.contains("active")', 'view switch'));
      check('with the patron loaded', await js(win,
        '!document.querySelector("#patronCard").classList.contains("hidden")'));
    }

    console.log('\nConsole health');
    const inPageErrors = await js(win, 'JSON.stringify(window.__err || [])');
    check('no uncaught errors in the page', inPageErrors === '[]', inPageErrors);
    check('no console errors or CSP violations', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('renderer stayed alive', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (err) {
    console.log(`\nUI harness crashed: ${err && err.stack ? err.stack : err}`);
    failures.push('harness crash');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('='.repeat(56));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(failures.length ? 1 : 0);
});
