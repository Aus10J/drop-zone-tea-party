'use strict';

/**
 * End-to-end exercise of the main-process logic: scanning, drink limits,
 * overrides, inventory, voids, reporting and export.
 *
 * Run with:  npm test
 * (ELECTRON_RUN_AS_NODE makes Electron behave as plain Node while keeping the
 * same ABI the native better-sqlite3 binary was built for.)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../src/main/db');
const cac = require('../src/main/cac');
const exporter = require('../src/main/exports');

let passed = 0;
const failures = [];

function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${extra ? `  -> ${extra}` : ''}`); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function near(label, actual, expected, tol = 0.011) {
  check(label, Math.abs(actual - expected) <= tol, `got ${actual}, want ~${expected}`);
}
function section(name) { console.log(`\n${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barpos-test-'));

function main() {
  console.log(`temp data dir: ${tmp}`);

  /* ---------------------------------------------------------------- */
  section('Database bootstrap');
  const dbPath = db.open(tmp);
  cac.init(tmp);
  check('database file created', fs.existsSync(dbPath));
  eq('default night limit', db.getSetting('drink_limit'), '4');
  eq('default beer cap', db.getSetting('limit_beer'), '4');
  eq('default wine cap', db.getSetting('limit_wine'), '4');
  eq('default liquor cap', db.getSetting('limit_liquor'), '3');
  check('id salt generated', (db.getSetting('id_salt') || '').length === 64);
  check('default PIN verifies', db.verifyPin('1234'));
  check('wrong PIN rejected', !db.verifyPin('9999'));
  check('settings never leak the PIN or salt',
    !('manager_pin' in db.allSettings()) && !('id_salt' in db.allSettings()));

  const products = db.listProducts();
  eq('menu board seeded', products.length, 14);
  check('nothing non-alcoholic on the menu',
    !products.some((p) => p.category === 'na'),
    products.filter((p) => p.category === 'na').map((p) => p.name).join(','));
  const ipa = products.find((p) => p.name.includes('Metamorphosis'));
  near('7% / 12oz IPA is 1.4 standard drinks', ipa.standard_drinks, 1.4);
  const woodford = products.find((p) => p.name === 'Woodford Reserve');
  near('45.2% / 1.5oz pour is 1.13 standard drinks', woodford.standard_drinks, 1.13);
  eq('spirits priced at $6', woodford.price_cents, 600);

  eq('venue named', db.getSetting('venue_name'), 'Drop Zone Tea Party');
  eq('admin locked by default', db.getSetting('require_pin_for_admin'), '1');

  /* ---------------------------------------------------------------- */
  section('Pricing controls');
  const priceBeer = products.find((p) => p.name === 'Tuborg Green').id;
  eq('starts at $5.00', db.listProducts().find((p) => p.id === priceBeer).price_cents, 500);

  const bumped = db.setProductPrice(priceBeer, 650, 'SSgt Rivera');
  check('single price change applies', bumped.changed && bumped.price_cents === 650);
  eq('reflected on the menu', db.listProducts().find((p) => p.id === priceBeer).price_cents, 650);
  check('price change is audited with the old and new value',
    db.handle().prepare("SELECT detail FROM audit_log WHERE event='price_changed' ORDER BY id DESC LIMIT 1")
      .get().detail.includes('5.00 -> 6.50'));
  check('re-setting the same price is a no-op', !db.setProductPrice(priceBeer, 650).changed);
  db.setProductPrice(priceBeer, 500);

  const flat = db.bulkSetPrice({ category: 'beer', mode: 'set', amount: 550, actor: 'test' });
  eq('flat re-price hits every beer', flat.changed, 5);
  check('all beers now $5.50',
    db.listProducts().filter((p) => p.category === 'beer').every((p) => p.price_cents === 550));
  check('wine untouched by a beer re-price',
    db.listProducts().filter((p) => p.category === 'wine').every((p) => p.price_cents === 700));

  const raised = db.bulkSetPrice({ category: 'beer', mode: 'add', amount: 50, actor: 'test' });
  eq('dollar bump applies', raised.changed, 5);
  eq('beer is now $6.00', db.listProducts().find((p) => p.id === priceBeer).price_cents, 600);

  db.bulkSetPrice({ category: 'spirit', mode: 'percent', amount: 10, actor: 'test' });
  eq('10% on a $6 spirit is $6.60',
    db.listProducts().find((p) => p.name === "Tito's Vodka").price_cents, 660);

  db.bulkSetPrice({ category: 'beer', mode: 'add', amount: -100, actor: 'test' });
  eq('negative bump cuts the price', db.listProducts().find((p) => p.id === priceBeer).price_cents, 500);
  db.bulkSetPrice({ category: 'spirit', mode: 'set', amount: 600, actor: 'test' });

  const everything = db.bulkSetPrice({ category: 'all', mode: 'percent', amount: 0, actor: 'test' });
  eq('a 0% change touches nothing', everything.changed, 0);

  const floored = db.bulkSetPrice({ category: 'wine', mode: 'add', amount: -99999, actor: 'test' });
  check('prices never go negative',
    db.listProducts().filter((p) => p.category === 'wine').every((p) => p.price_cents === 0),
    JSON.stringify(floored.items));
  db.bulkSetPrice({ category: 'wine', mode: 'set', amount: 700, actor: 'test' });
  check('wine restored to $7.00',
    db.listProducts().filter((p) => p.category === 'wine').every((p) => p.price_cents === 700));
  check('bulk changes are audited',
    db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='bulk_price_changed'").get().n >= 4);

  /* ---------------------------------------------------------------- */
  section('Standard drink math');
  near('12oz @ 5% = 1.0', db.standardDrinks(12, 5), 1.0);
  near('1.5oz @ 40% = 1.0', db.standardDrinks(1.5, 40), 1.0);
  near('5oz @ 12% = 1.0', db.standardDrinks(5, 12), 1.0);
  eq('zero ABV is zero drinks', db.standardDrinks(12, 0), 0);

  /* ---------------------------------------------------------------- */
  section('CAC / ID scan parsing');
  const bare = cac.parseScan('1234567890');
  eq('bare 10 digits read as a DoD ID', bare.edipi, '1234567890');
  eq('last four extracted', bare.last4, '7890');

  const padded = cac.parseScan('  123456789\r\n');
  eq('9 digits pad to 10', padded.edipi, '0123456789');

  const synthetic = 'N1AB3CD4EF5' + 'SMITH JOHN Q'.padEnd(27, ' ') + 'GH6IJ7KL8MN9OP0QR1ST2UV3';
  const pdf = cac.parseScan(synthetic);
  eq('long payload classified as a card', pdf.kind, 'cac-pdf417');
  check('name guessed and reordered to First Last',
    pdf.name === 'JOHN Q SMITH', `got ${JSON.stringify(pdf.name)}`);
  eq('parse route recorded', pdf.parsedBy, 'heuristic');

  const dl = cac.parseScan('@\nANSI 636000080102DL00410288ZV03290015DLDAQT64235789DCSDOE\nDACJANE\nDBB19900415\n');
  eq('AAMVA licence detected', dl.kind, 'aamva');
  check('licence name read', /JANE/.test(dl.name || '') && /DOE/.test(dl.name || ''), dl.name);
  eq('licence DOB read', dl.dob, '1990-04-15');

  eq('base32 decode', cac.base32ToInt('1F'), 47);
  eq('Julian day 2451545 is 2000-01-01', cac.jdnToIso(2451545), '2000-01-01');

  // Calibrated layout beats heuristics.
  const layoutPayload = 'XX19900415XXXXDOE JANE A XXXX';
  cac.saveLayout({ version: 1, fields: {
    dob:  { start: 2,  len: 8,  encoding: 'yyyymmdd' },
    name: { start: 14, len: 10, encoding: 'ascii' },
  } });
  const viaLayout = cac.parseScan(layoutPayload);
  eq('layout drives the parse', viaLayout.parsedBy, 'layout');
  eq('layout reads the DOB', viaLayout.dob, '1990-04-15');
  eq('layout reads and reorders the name', viaLayout.name, 'JANE A DOE');
  const slice = cac.previewSlice(layoutPayload, 2, 8);
  eq('slice preview decodes YYYYMMDD', slice.yyyymmdd, '1990-04-15');
  cac.saveLayout(null);
  check('layout cleared', cac.getLayout() === null);

  /* ---------------------------------------------------------------- */
  section('Finding a DoD ID inside a scan');
  // Pack a known ID the way a card does — base32, not readable digits — and
  // check it can be located without anyone counting characters.
  const B32 = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
  const toBase32 = (n, width) => {
    let out = '';
    let v = n;
    while (v > 0) { out = B32[v % 32] + out; v = Math.floor(v / 32); }
    return out.padStart(width, '0');
  };

  const realId = '1234567890';
  const packed = toBase32(Number(realId), 7);
  const cardPayload = `N1AB3CD${packed}MURPHY SEAN T     ZZ9XX8CC7VV6`;

  const hits = cac.deduceIdLayout(cardPayload, realId);
  check('the packed ID is located', hits.length >= 1, JSON.stringify(hits.slice(0, 3)));
  eq('at the right offset', hits[0].start, cardPayload.indexOf(packed));
  eq('with the right width', hits[0].len, packed.length);
  eq('and the right encoding', hits[0].encoding, 'base32-int');

  // Feed the discovered offsets back in and confirm they decode.
  cac.saveLayout({ version: 1, fields: { edipi: {
    start: hits[0].start, len: hits[0].len, encoding: hits[0].encoding,
  } } });
  const decoded = cac.parseScan(cardPayload);
  eq('so a scan now yields the DoD ID', decoded.edipi, realId);
  eq('parsed via the saved layout', decoded.parsedBy, 'layout');
  eq('and the last four come with it', decoded.last4, '7890');
  cac.saveLayout(null);

  // Plain digits, if a card generation ever stores them that way.
  const plain = cac.deduceIdLayout('XXXX1234567890YYYY', realId);
  eq('readable digits are found too', plain[0].encoding, 'int');
  eq('at their offset', plain[0].start, 4);

  eq('a wrong ID finds nothing', cac.deduceIdLayout(cardPayload, '9999999999').length, 0);
  eq('no ID finds nothing', cac.deduceIdLayout(cardPayload, '').length, 0);
  eq('no scan finds nothing', cac.deduceIdLayout('', realId).length, 0);
  check('dashes in the typed ID are tolerated',
    cac.deduceIdLayout(cardPayload, '123-456-7890').length >= 1);

  /* ---------------------------------------------------------------- */
  section('Patron identity');
  const rawCard = 'N1AB3CD4EF5DOE JOHN A       GH6IJ7KL8MN9OP0QR1ST2UV3';
  const first = db.resolveCard(cac.parseScan(rawCard));
  check('first scan creates a patron', first.isNew);
  const second = db.resolveCard(cac.parseScan(rawCard));
  check('rescanning the same card is the same patron', !second.isNew && second.patron.id === first.patron.id);

  const other = db.resolveCard(cac.parseScan('N9ZZ1YY2XX3ROE RICHARD      QQ7WW8EE9RR0TT1YY2UU3'));
  check('a different card is a different patron', other.patron.id !== first.patron.id);

  const stored = db.handle().prepare('SELECT * FROM patrons WHERE id = ?').get(first.patron.id);
  check('lookup key is a hash', stored.card_hash.length === 64 && !stored.card_hash.includes('DOE'));
  eq('the scanned barcode is stored verbatim', stored.card_payload, rawCard);
  check('no name had to be typed for the record to exist', !!stored.card_hash);

  // A typed or scanned DoD ID is stored as the identifier.
  const byId = db.resolveCard(cac.parseScan('1928374650'));
  eq('DoD ID stored', byId.patron.dod_id, '1928374650');
  eq('and kept as the payload too', byId.patron.card_payload, '1928374650');
  eq('labelled by DoD ID with no name on file', db.labelFor(byId.patron), 'DoD 1928374650');

  // A barcode with no readable ID still gets a usable label, unprompted.
  const opaque = db.resolveCard(cac.parseScan('ZZQQ9911223344556677889900AABBCCDDEEFF0011'));
  eq('no DoD ID could be parsed', opaque.patron.dod_id, null);
  check('still labelled from the card tail',
    /^Card …/.test(db.labelFor(opaque.patron)), db.labelFor(opaque.patron));
  check('and it tracks drinks like any other patron',
    db.patronStatus(opaque.patron.id).limits.total === 4);

  const patronId = first.patron.id;
  db.updatePatron(patronId, { display_name: 'John Doe', dob: '1995-06-15', last4: '4321' });
  const st0 = db.patronStatus(patronId);
  eq('name saved', st0.patron.display_name, 'John Doe');
  check('age computed', st0.age >= 29 && st0.age <= 32, String(st0.age));
  check('not underage', !st0.underage);
  eq('starts the night at zero', st0.today.servings, 0);
  eq('night limit surfaced', st0.limits.total, 4);
  eq('category caps surfaced', st0.limits.liquor, 3);
  eq('full headroom to begin with', st0.remaining.total, 4);

  /* ---------------------------------------------------------------- */
  section('Schema migration');
  {
    // Simulate a database created before the identifier columns existed.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barpos-legacy-'));
    const Database = require('better-sqlite3');
    const legacy = new Database(path.join(legacyDir, 'old.db'));
    legacy.exec(`CREATE TABLE patrons (
      id INTEGER PRIMARY KEY, card_hash TEXT NOT NULL UNIQUE, dod_id_hash TEXT,
      last4 TEXT, display_name TEXT, dob TEXT, branch TEXT, rank TEXT,
      is_banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, notes TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
    legacy.prepare(`INSERT INTO patrons (card_hash, display_name, first_seen_at, last_seen_at)
      VALUES ('deadbeef', 'Existing Regular', '2026-01-01', '2026-01-01')`).run();

    // ...and a menu from before non-alcoholic drinks were dropped.
    legacy.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, brand TEXT, name TEXT NOT NULL,
      abv REAL, serving_oz REAL, price_cents INTEGER NOT NULL DEFAULT 0,
      standard_drinks REAL NOT NULL DEFAULT 1, sku TEXT,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)`);
    legacy.exec(`INSERT INTO products (category, name, abv, serving_oz, price_cents, standard_drinks)
      VALUES ('beer','Legacy Lager',5,12,500,1.0),
             ('na','Legacy Bottled Water',0,16,100,0),
             ('na','Legacy Coffee',0,8,100,0)`);
    legacy.close();

    const before = db.getDbPath();
    db.close();
    fs.mkdirSync(path.join(legacyDir, 'data'), { recursive: true });
    fs.copyFileSync(path.join(legacyDir, 'old.db'), path.join(legacyDir, 'data', 'bar.db'));
    db.open(legacyDir);

    const cols = db.handle().prepare('PRAGMA table_info(patrons)').all().map((c) => c.name);
    check('dod_id added to an existing database', cols.includes('dod_id'), cols.join(','));
    check('card_payload added too', cols.includes('card_payload'));
    eq('existing rows survive the migration',
      db.handle().prepare("SELECT display_name FROM patrons WHERE card_hash='deadbeef'").get().display_name,
      'Existing Regular');
    check('migration is recorded in the audit log',
      db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='schema_migrated'").get().n === 1);

    eq('an existing free-text name is split into first and last',
      db.handle().prepare("SELECT last_name FROM patrons WHERE card_hash='deadbeef'").get().last_name,
      'Regular');
    eq('with the rest as the first name',
      db.handle().prepare("SELECT first_name FROM patrons WHERE card_hash='deadbeef'").get().first_name,
      'Existing');
    check('so the legacy roster is searchable by surname',
      db.findPatrons('Regular').some((r) => r.card_hash === 'deadbeef'));

    eq('legacy non-alcoholic items are taken off the menu',
      db.listProducts().filter((p) => p.category === 'na').length, 0);
    eq('but their rows survive for order history',
      db.listProducts({ includeInactive: true }).filter((p) => p.category === 'na').length, 2);
    check('the alcoholic legacy item is untouched',
      db.listProducts().some((p) => p.name === 'Legacy Lager'));
    check('the retirement is audited',
      /2 non-alcoholic/.test(db.handle().prepare(
        "SELECT detail FROM audit_log WHERE event='products_retired' ORDER BY id DESC LIMIT 1").get().detail));
    check('the legacy menu was not re-seeded over',
      db.listProducts({ includeInactive: true }).length === 3);

    db.close();
    db.open(tmp);
    eq('reopened the real test database', db.getDbPath(), before);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  section('Reissued card follows the patron');
  // Same DoD ID arriving on a brand new card payload.
  const dodId = '1112223333';
  const p1 = db.resolveCard(cac.parseScan(dodId));
  db.updatePatron(p1.patron.id, { display_name: 'Reissue Test' });
  const p2 = db.resolveCard({ raw: 'COMPLETELY-DIFFERENT-PAYLOAD-XYZ', edipi: dodId });
  eq('new card re-links to the existing patron', p2.patron.id, p1.patron.id);
  eq('history stays attached', p2.patron.display_name, 'Reissue Test');

  /* ---------------------------------------------------------------- */
  section('Inventory');
  const beerId = products.find((p) => p.name === 'Tuborg Green').id;
  const ginId = products.find((p) => p.name === 'Tanqueray Gin').id;
  const wineId = products.find((p) => p.name === 'Dark Horse Merlot').id;

  db.adjustInventory({ productId: beerId, newQty: 48, reason: 'recount', actor: 'test' });
  db.adjustInventory({ productId: ginId, newQty: 20, reason: 'recount', actor: 'test' });
  db.adjustInventory({ productId: wineId, newQty: 12, reason: 'recount', actor: 'test' });
  const afterCount = db.listProducts().find((p) => p.id === beerId);
  eq('recount sets stock', afterCount.qty_on_hand, 48);
  check('recount stamps the count time', !!afterCount.last_counted_at);

  db.adjustInventory({ productId: beerId, delta: 24, reason: 'delivery', actor: 'test' });
  eq('delivery adds stock', db.listProducts().find((p) => p.id === beerId).qty_on_hand, 72);
  db.adjustInventory({ productId: beerId, delta: -2, reason: 'spill', actor: 'test', note: 'dropped a case corner' });
  eq('spill removes stock', db.listProducts().find((p) => p.id === beerId).qty_on_hand, 70);

  const adjLog = db.inventoryAdjustments({ limit: 10 });
  check('every change is logged with a reason',
    adjLog.some((a) => a.reason === 'spill' && a.delta === -2 && a.note));

  db.setInventoryMeta(wineId, { unit: 'bottle', par_level: 15 });
  const low = db.lowStock();
  check('par level drives the low-stock list', low.some((l) => l.id === wineId), JSON.stringify(low));

  /* ---------------------------------------------------------------- */
  section('Ringing up a sale');
  db.setSetting('bartender_name', 'SSgt Rivera');
  const shift = db.openShift('SSgt Rivera');
  check('shift opens', !!shift && !shift.closed_at);
  eq('reopening returns the same shift', db.openShift('x').id, shift.id);

  const quote1 = db.priceTicket({ patronId, items: [{ productId: beerId, qty: 2 }] });
  eq('two beers priced', quote1.subtotalCents, 1000);
  eq('two beers count as two drinks', quote1.servings, 2);
  eq('counted against the beer cap', quote1.byGroup.beer, 2);
  eq('liquor untouched by a beer ticket', quote1.byGroup.liquor, 0);
  near('standard drinks still calculated for reporting', quote1.standardDrinks, 1.84);
  check('under the limit, no override needed', !quote1.needsOverride);

  const sale1 = db.createOrder({
    patronId, items: [{ productId: beerId, qty: 2 }], bartender: 'SSgt Rivera',
  });
  eq('order total', sale1.subtotalCents, 1000);
  const afterSale1 = db.patronStatus(patronId);
  eq('count advances in drinks served, not ABV units', afterSale1.today.servings, 2);
  eq('the beer group advances', afterSale1.today.byGroup.beer, 2);
  eq('two left on the night total', afterSale1.remaining.total, 2);
  eq('stock decremented by the sale', db.listProducts().find((p) => p.id === beerId).qty_on_hand, 68);
  eq('card is the recorded tender by default',
    db.handle().prepare('SELECT payment_method FROM orders WHERE id = ?').get(sale1.orderId).payment_method,
    'card');

  const saleAdj = db.inventoryAdjustments({ limit: 5 }).find((a) => a.reason === 'sale');
  check('the sale wrote an inventory adjustment', !!saleAdj && saleAdj.order_id === sale1.orderId);

  /* ---------------------------------------------------------------- */
  section('Drink limits: night total');
  const caps = db.limitSettings();
  eq('night total', caps.total, 4);
  eq('beer cap', caps.beer, 4);
  eq('liquor cap', caps.liquor, 3);
  eq('wine cap', caps.wine, 4);

  // patronId has had 2 beers already.
  const toTotal = db.priceTicket({ patronId, items: [{ productId: beerId, qty: 2 }] });
  eq('two more beers reaches exactly four', toTotal.projected.total, 4);
  check('reaching the limit exactly is allowed',
    !toTotal.needsOverride && toTotal.breaches.length === 0);

  // 2 beers already + 3 liquors = 5 total, but liquor lands on 3 exactly. So
  // the night total is the only cap broken — a clean test that the total is
  // enforced independently of the category caps.
  const pastTotal = db.priceTicket({ patronId, items: [{ productId: ginId, qty: 3 }] });
  eq('three liquors on top of two beers would be five', pastTotal.projected.total, 5);
  eq('liquor lands exactly on its cap', pastTotal.projected.liquor, 3);
  check('past the night total is flagged', pastTotal.overLimit && pastTotal.needsOverride);
  check('only the night cap is named',
    pastTotal.breaches.length === 1 && pastTotal.breaches[0].group === 'total',
    JSON.stringify(pastTotal.breaches));
  check('message explains which cap and by how much',
    /Night limit is 4 drinks — this ticket would make 5/.test(pastTotal.limitMessage),
    pastTotal.limitMessage);

  // Both caps can break at once, and both get named.
  const bothCaps = db.priceTicket({ patronId, items: [{ productId: beerId, qty: 3 }] });
  eq('five beers total breaks the beer cap too', bothCaps.projected.beer, 5);
  check('both the night and beer caps are reported',
    bothCaps.breaches.length === 2 &&
    bothCaps.breaches.some((b) => b.group === 'total') &&
    bothCaps.breaches.some((b) => b.group === 'beer'),
    JSON.stringify(bothCaps.breaches));

  // Four beers from a standing start is fine — the beer cap equals the total.
  const beerOnly = db.resolveCard(cac.parseScan('5553334444'));
  const bid = beerOnly.patron.id;
  db.updatePatron(bid, { display_name: 'Beer Only', dob: '1990-01-01' });
  check('four beers in one ticket is allowed', (() => {
    const q = db.priceTicket({ patronId: bid, items: [{ productId: beerId, qty: 4 }] });
    return !q.needsOverride && q.breaches.length === 0;
  })());
  check('five beers is not', db.priceTicket({ patronId: bid, items: [{ productId: beerId, qty: 5 }] }).needsOverride);

  /* ---------------------------------------------------------------- */
  section('Drink limits: category caps');
  const liq = db.resolveCard(cac.parseScan('5551112222'));
  const lid = liq.patron.id;
  db.updatePatron(lid, { display_name: 'Liquor Test', dob: '1990-01-01' });

  check('three liquors is allowed',
    !db.priceTicket({ patronId: lid, items: [{ productId: ginId, qty: 3 }] }).needsOverride);
  db.createOrder({ patronId: lid, items: [{ productId: ginId, qty: 3 }], bartender: 'SSgt Rivera' });

  const liqStatus = db.patronStatus(lid);
  eq('liquor count', liqStatus.today.byGroup.liquor, 3);
  eq('one drink left on the night', liqStatus.remaining.total, 1);
  eq('no liquor left', liqStatus.remaining.liquor, 0);
  check('liquor reported as cut off', liqStatus.blockedGroups.includes('liquor'));
  check('beer is not cut off', !liqStatus.blockedGroups.includes('beer'));
  check('not yet at the night total', !liqStatus.atLimit);

  // The whole point of the policy: a 4th drink is fine, a 4th LIQUOR is not.
  const fourthLiquor = db.priceTicket({ patronId: lid, items: [{ productId: ginId, qty: 1 }] });
  eq('a fourth liquor is still inside the night total', fourthLiquor.projected.total, 4);
  check('but the liquor cap blocks it', fourthLiquor.needsOverride);
  check('liquor named as the binding cap',
    fourthLiquor.breaches.length === 1 && fourthLiquor.breaches[0].group === 'liquor');
  check('the night total is not blamed', !fourthLiquor.breaches.some((b) => b.group === 'total'));
  check('message names liquor',
    /Liquor limit is 3 — this ticket would make 4/.test(fourthLiquor.limitMessage),
    fourthLiquor.limitMessage);

  const fourthBeer = db.priceTicket({ patronId: lid, items: [{ productId: beerId, qty: 1 }] });
  check('a beer as their fourth drink is fine',
    !fourthBeer.needsOverride && fourthBeer.breaches.length === 0);

  // Cocktails are liquor.
  const cocktailId = db.saveProduct({
    category: 'cocktail', name: 'Old Fashioned', abv: 32, serving_oz: 3,
    price_cents: 900, active: 1, qty_on_hand: 40,
  });
  const cocktailQuote = db.priceTicket({ patronId: lid, items: [{ productId: cocktailId, qty: 1 }] });
  eq('a cocktail counts against liquor', cocktailQuote.byGroup.liquor, 1);
  eq('and not against beer', cocktailQuote.byGroup.beer, 0);
  check('so it hits the liquor cap too', cocktailQuote.needsOverride);

  // The counting rule keys off alcohol content, not the category name — so a
  // 0% item would still be exempt if one ever existed. Nothing on the menu is.
  const zeroAbvId = db.saveProduct({
    category: 'beer', name: 'Test Zero-Proof', abv: 0, serving_oz: 12,
    price_cents: 300, active: 1, qty_on_hand: 10,
  });
  const zeroQuote = db.priceTicket({ patronId: lid, items: [{ productId: zeroAbvId, qty: 3 }] });
  eq('a zero-alcohol item adds no servings', zeroQuote.servings, 0);
  eq('and no group counts', zeroQuote.byGroup.beer, 0);
  check('so it is never blocked', !zeroQuote.needsOverride && zeroQuote.breaches.length === 0);
  db.archiveProduct(zeroAbvId);

  /* ---------------------------------------------------------------- */
  section('Overrides');
  let blocked = false;
  try {
    db.createOrder({ patronId: lid, items: [{ productId: ginId, qty: 1 }] });
  } catch (err) {
    blocked = /liquor/i.test(err.message);
  }
  check('sale past a category cap is refused, naming the category', blocked);

  let badPin = false;
  try {
    db.createOrder({
      patronId: lid, items: [{ productId: ginId, qty: 1 }],
      overrideReason: 'manager said ok', pin: '0000',
    });
  } catch (err) { badPin = /PIN/i.test(err.message); }
  check('override with the wrong PIN is refused', badPin);

  const over = db.createOrder({
    patronId: lid, items: [{ productId: ginId, qty: 1 }],
    bartender: 'SSgt Rivera', overrideReason: 'DD confirmed, food served', pin: '1234',
  });
  check('override with the right PIN goes through', !!over.orderId);
  const overRow = db.handle().prepare('SELECT * FROM orders WHERE id = ?').get(over.orderId);
  eq('override reason recorded on the order', overRow.override_reason, 'DD confirmed, food served');
  const overAudit = db.handle().prepare(
    "SELECT detail FROM audit_log WHERE event='limit_override' ORDER BY id DESC LIMIT 1").get();
  check('audit log records which cap was broken',
    /Liquor 4\/3/.test(overAudit.detail), overAudit.detail);

  // warn mode lets it through without a PIN; track mode says nothing at all
  db.setSetting('limit_mode', 'warn');
  const warnQuote = db.priceTicket({ patronId: lid, items: [{ productId: ginId, qty: 1 }] });
  check('warn mode still flags', warnQuote.overLimit);
  check('warn mode does not demand an override', !warnQuote.needsOverride);
  db.setSetting('limit_mode', 'track');
  const trackQuote = db.priceTicket({ patronId: lid, items: [{ productId: ginId, qty: 1 }] });
  check('track mode is silent', !trackQuote.overLimit && !trackQuote.needsOverride);
  db.setSetting('limit_mode', 'block');

  /* ---------------------------------------------------------------- */
  section('Every sale needs a card');
  let noCard = false;
  try {
    db.createOrder({ patronId: null, items: [{ productId: wineId, qty: 1 }] });
  } catch (err) { noCard = /scan a card/i.test(err.message); }
  check('a sale with no patron is refused', noCard);
  let noCardUndefined = false;
  try {
    db.createOrder({ items: [{ productId: wineId, qty: 1 }] });
  } catch (err) { noCardUndefined = /scan a card/i.test(err.message); }
  check('and so is one with no patron field at all', noCardUndefined);
  eq('nothing was taken off the shelf',
    db.listProducts().find((p) => p.id === wineId).qty_on_hand, 12);

  /* ---------------------------------------------------------------- */
  section('Editing and deleting patrons');
  const doomed = db.resolveCard(cac.parseScan('9998887770'));
  const did = doomed.patron.id;
  db.updatePatron(did, { display_name: 'Temp Patron', notes: 'to be removed' });
  eq('edits apply', db.patronStatus(did).patron.display_name, 'Temp Patron');
  eq('notes save', db.patronStatus(did).patron.notes, 'to be removed');
  db.updatePatron(did, { display_name: '' });
  eq('clearing a name falls back to the DoD ID', db.patronStatus(did).label, 'DoD 9998887770');

  eq('no footprint before they buy anything', db.patronFootprint(did).orders, 0);
  const doomedOrder = db.createOrder({
    patronId: did, items: [{ productId: beerId, qty: 2 }], bartender: 'SSgt Rivera',
  });
  const foot = db.patronFootprint(did);
  eq('footprint counts their orders', foot.orders, 1);
  eq('and their spend', foot.cents, doomedOrder.subtotalCents);

  const grossBefore = db.salesReport(db.businessDate(), db.businessDate()).totals.gross_cents;
  const del = db.deletePatron(did);
  eq('reports how much history was detached', del.orders, 1);
  eq('the patron is gone',
    db.handle().prepare('SELECT COUNT(*) n FROM patrons WHERE id = ?').get(did).n, 0);
  eq('their order survives',
    db.handle().prepare('SELECT COUNT(*) n FROM orders WHERE id = ?').get(doomedOrder.orderId).n, 1);
  eq('detached from the deleted patron',
    db.handle().prepare('SELECT patron_id FROM orders WHERE id = ?').get(doomedOrder.orderId).patron_id,
    null);
  eq('so the night’s takings are unchanged',
    db.salesReport(db.businessDate(), db.businessDate()).totals.gross_cents, grossBefore);
  check('the deletion is audited',
    db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='patron_deleted'").get().n === 1);
  check('deleting a patron who does not exist is refused', (() => {
    try { db.deletePatron(did); return false; } catch (err) { return /not found/i.test(err.message); }
  })());

  /* ---------------------------------------------------------------- */
  section('Patron search');
  // Regression: positional bindings used to shift by one as soon as a search
  // term was supplied, so the business-date comparison received the search
  // string and every row came back with zero drinks.
  const searchPatron = db.resolveCard(cac.parseScan('7418529630'));
  const sid = searchPatron.patron.id;
  db.updatePatron(sid, { display_name: 'Search Target', notes: 'saturday regular' });
  db.createOrder({ patronId: sid, items: [{ productId: beerId, qty: 2 }], bartender: 'SSgt Rivera' });

  const found = (term) => db.listPatrons({ search: term, limit: 500 }).find((r) => r.id === sid);

  check('found by the last four', !!found('9630'));
  eq('and the drink count survives the search', found('9630').drinks_today, 2);
  check('found by the full DoD ID', !!found('7418529630'));
  eq('count is right there too', found('7418529630').drinks_today, 2);
  check('found by name', !!found('Search Tar'));
  eq('count is right there too as well', found('Search Tar').drinks_today, 2);
  check('found by notes', !!found('saturday'));
  check('search is case-insensitive', !!found('search target'));

  const unfiltered = db.listPatrons({ limit: 500 }).find((r) => r.id === sid);
  eq('the unsearched list agrees with the searched one',
    unfiltered.drinks_today, found('9630').drinks_today);

  check('a term that matches nothing returns nothing',
    db.listPatrons({ search: 'zzz-no-such-patron' }).length === 0);
  check('an empty search behaves like no search',
    db.listPatrons({ search: '   ', limit: 500 }).length === db.listPatrons({ limit: 500 }).length);

  const ordered = db.listPatrons({ limit: 500 });
  check('patrons already drinking tonight sort to the top',
    ordered.every((r, i) => i === 0 || ordered[i - 1].drinks_today >= r.drinks_today),
    ordered.slice(0, 6).map((r) => `${r.label}:${r.drinks_today}`).join(' '));

  // A card with no readable ID is still findable by its payload.
  const opaqueSearch = db.resolveCard(cac.parseScan('WWXX7788990011223344556677'));
  check('found by the tail of an unparseable card',
    db.listPatrons({ search: '556677', limit: 500 }).some((r) => r.id === opaqueSearch.patron.id));

  // last4 is derived from the ID, so it is searchable without anyone typing it.
  eq('last four derived automatically from the scan',
    db.handle().prepare('SELECT last4 FROM patrons WHERE id = ?').get(sid).last4, '9630');

  /* ---------------------------------------------------------------- */
  section('Partial DoD ID lookup');
  const ids = (rows) => rows.map((r) => r.id);

  check('a partial ID from the start matches', ids(db.findPatrons('741852')).includes(sid));
  check('a partial from the middle matches', ids(db.findPatrons('185296')).includes(sid));
  check('the last four matches', ids(db.findPatrons('9630')).includes(sid));
  check('the full ID matches', ids(db.findPatrons('7418529630')).includes(sid));
  check('a name fragment matches', ids(db.findPatrons('Sear')).includes(sid));
  eq('the drink count rides along', db.findPatrons('741852')[0].drinks_today, 2);

  // An exact ID must outrank a patron who merely contains those digits.
  const decoy = db.resolveCard(cac.parseScan('9630111222'));
  check('a decoy sharing digits also matches the fragment',
    ids(db.findPatrons('9630')).includes(decoy.patron.id));
  eq('but an exact ID match is ranked first',
    db.findPatrons('9630111222')[0].id, decoy.patron.id);
  eq('and an ID prefix outranks a mid-string hit',
    db.findPatrons('963011')[0].id, decoy.patron.id);

  eq('an empty term finds nobody', db.findPatrons('').length, 0);
  eq('whitespace finds nobody', db.findPatrons('   ').length, 0);
  eq('gibberish finds nobody', db.findPatrons('zzzqqq').length, 0);

  // The bug this replaced: a fragment used to be hashed into a new patron.
  const before = db.handle().prepare('SELECT COUNT(*) n FROM patrons').get().n;
  db.findPatrons('765432');
  db.findPatrons('not-a-real-person');
  eq('looking someone up never creates a record',
    db.handle().prepare('SELECT COUNT(*) n FROM patrons').get().n, before);

  /* ---------------------------------------------------------------- */
  section('Attaching a DoD ID after the fact');
  // A card whose barcode yielded no ID is unfindable by ID until one is added.
  // No run of exactly ten digits, so the heuristic finds no ID to lift.
  const noIdCard = db.resolveCard(cac.parseScan('MMNN5566AABB7788CCDD9900EEFF3344'));
  const nid = noIdCard.patron.id;
  eq('no ID came off the card', noIdCard.patron.dod_id, null);
  check('so searching their real ID finds nothing',
    !ids(db.findPatrons('5551239876')).includes(nid));

  db.updatePatron(nid, { dod_id: '5551239876' });
  const withId = db.patronStatus(nid).patron;
  eq('the ID is stored', withId.dod_id, '5551239876');
  eq('last four is derived from it', withId.last4, '9876');
  check('the ID hash is set so a reissued card re-links', !!withId.dod_id_hash);
  check('now a partial ID finds them', ids(db.findPatrons('555123')).includes(nid));
  check('and the last four finds them', ids(db.findPatrons('9876')).includes(nid));
  eq('and they label by ID', db.patronStatus(nid).label, 'DoD 5551239876');

  // Scanning that ID now lands on the same patron rather than making a new one.
  const rescan = db.resolveCard(cac.parseScan('5551239876'));
  eq('scanning the ID re-links to the existing patron', rescan.patron.id, nid);

  check('the same ID cannot be given to two patrons', (() => {
    try { db.updatePatron(sid, { dod_id: '5551239876' }); return false; }
    catch (err) { return /already on/i.test(err.message); }
  })());
  check('non-digits are stripped from a typed ID', (() => {
    db.updatePatron(nid, { dod_id: '555-123-9876' });
    return db.patronStatus(nid).patron.dod_id === '5551239876';
  })());
  db.updatePatron(nid, { dod_id: '' });
  eq('clearing it is allowed', db.patronStatus(nid).patron.dod_id, null);
  db.updatePatron(nid, { dod_id: '5551239876' });

  /* ---------------------------------------------------------------- */
  section('Removing a single drink after the fact');
  const rmPatron = db.resolveCard(cac.parseScan('8008008000'));
  const rmId = rmPatron.patron.id;
  const wineStock = db.listProducts().find((p) => p.id === wineId).qty_on_hand;
  const beerStock = db.listProducts().find((p) => p.id === beerId).qty_on_hand;

  // One ticket, two different drinks, one of them ×2.
  const mixedOrder = db.createOrder({
    patronId: rmId,
    items: [{ productId: beerId, qty: 2 }, { productId: wineId, qty: 1 }],
    bartender: 'SSgt Rivera',
  });
  eq('three drinks on the ticket', db.patronStatus(rmId).today.servings, 3);
  eq('beer counted twice', db.patronStatus(rmId).today.byGroup.beer, 2);
  eq('wine counted once', db.patronStatus(rmId).today.byGroup.wine, 1);
  const orderTotal = mixedOrder.subtotalCents;

  const hist = db.patronHistory(rmId, 10);
  const theOrder = hist.find((o) => o.id === mixedOrder.orderId);
  const beerLine = theOrder.items.find((i) => i.product_id === beerId);
  const wineLine = theOrder.items.find((i) => i.product_id === wineId);

  // Take one of the two beers back.
  const removed = db.removeOrderItem({
    orderId: mixedOrder.orderId, itemId: beerLine.id, qty: 1,
    reason: 'poured in error', pin: '1234', actor: 'SSgt Rivera',
  });
  eq('one unit removed', removed.removed, 1);
  check('the order is not voided — other drinks remain', !removed.orderVoided);
  eq('their night count drops by one', db.patronStatus(rmId).today.servings, 2);
  eq('the beer count drops', db.patronStatus(rmId).today.byGroup.beer, 1);
  eq('wine is untouched', db.patronStatus(rmId).today.byGroup.wine, 1);
  eq('the beer goes back on the shelf',
    db.listProducts().find((p) => p.id === beerId).qty_on_hand, beerStock - 1);

  const afterOne = db.handle().prepare('SELECT * FROM orders WHERE id = ?').get(mixedOrder.orderId);
  eq('the order total is recomputed, not left stale',
    afterOne.subtotal_cents, orderTotal - beerLine.unit_price_cents);
  check('and still reconciles with its remaining lines',
    afterOne.subtotal_cents === db.handle().prepare(
      'SELECT SUM(qty * unit_price_cents) c FROM order_items WHERE order_id = ?')
      .get(mixedOrder.orderId).c);
  check('the removal is audited',
    /1× Tuborg Green off order/.test(db.handle().prepare(
      "SELECT detail FROM audit_log WHERE event='order_item_removed' ORDER BY id DESC LIMIT 1").get().detail));
  check('and it shows in the stock adjustment log',
    db.inventoryAdjustments({ limit: 5 }).some((a) => a.reason === 'void' && a.delta === 1));

  // Removing the rest empties the order, which should void it outright.
  db.removeOrderItem({
    orderId: mixedOrder.orderId, itemId: beerLine.id, qty: 1,
    reason: 'also wrong', pin: '1234',
  });
  const lastRemoval = db.removeOrderItem({
    orderId: mixedOrder.orderId, itemId: wineLine.id, qty: 1,
    reason: 'wrong too', pin: '1234',
  });
  check('emptying the order voids it', lastRemoval.orderVoided);
  eq('their count is back to zero', db.patronStatus(rmId).today.servings, 0);
  eq('all stock is back', db.listProducts().find((p) => p.id === beerId).qty_on_hand, beerStock);
  eq('wine stock too', db.listProducts().find((p) => p.id === wineId).qty_on_hand, wineStock);
  const emptied = db.handle().prepare('SELECT * FROM orders WHERE id = ?').get(mixedOrder.orderId);
  eq('the emptied order is marked voided', emptied.voided, 1);
  eq('and zeroed', emptied.subtotal_cents, 0);
  check('so it drops out of the takings',
    !db.salesReport(db.businessDate(), db.businessDate()).series
      .some((d) => d.gross_cents < 0));

  check('removing from an already-voided order is refused', (() => {
    try {
      db.removeOrderItem({ orderId: mixedOrder.orderId, itemId: wineLine.id, pin: '1234' });
      return false;
    } catch (err) { return /already voided/i.test(err.message); }
  })());
  check('a wrong PIN is refused', (() => {
    const o = db.createOrder({ patronId: rmId, items: [{ productId: beerId, qty: 1 }] });
    const line = db.patronHistory(rmId, 5).find((x) => x.id === o.orderId).items[0];
    try {
      db.removeOrderItem({ orderId: o.orderId, itemId: line.id, pin: '0000' });
      return false;
    } catch (err) { return /PIN/i.test(err.message); }
  })());
  check('a line from another order is refused', (() => {
    try {
      db.removeOrderItem({ orderId: sale1.orderId, itemId: wineLine.id, pin: '1234' });
      return false;
    } catch (err) { return /not on this order/i.test(err.message); }
  })());

  /* ---------------------------------------------------------------- */
  section('Adding a patron without a DoD ID');
  // First and last are entered separately, and kept in step with the single
  // display string used everywhere else.
  const split = db.createPatron({ firstName: 'Renata', lastName: 'Ferreira' });
  eq('first name stored', split.patron.first_name, 'Renata');
  eq('last name stored', split.patron.last_name, 'Ferreira');
  eq('display name composed', split.patron.display_name, 'Renata Ferreira');
  eq('and that is the label', db.labelFor(split.patron), 'Renata Ferreira');
  check('findable by first name', ids(db.findPatrons('Renata')).includes(split.patron.id));
  check('findable by last name', ids(db.findPatrons('Ferre')).includes(split.patron.id));
  check('and by the two together', ids(db.findPatrons('Renata Ferr')).includes(split.patron.id));

  const lastOnly = db.createPatron({ lastName: 'Okafor' });
  eq('a last name alone is enough', lastOnly.patron.last_name, 'Okafor');
  eq('with no first name', lastOnly.patron.first_name, null);
  eq('label is just the surname', db.labelFor(lastOnly.patron), 'Okafor');

  const firstOnly = db.createPatron({ firstName: 'Mononym' });
  eq('a first name alone also works', firstOnly.patron.first_name, 'Mononym');
  eq('and composes', firstOnly.patron.display_name, 'Mononym');

  // A single typed string still splits sensibly.
  eq('one word is treated as a surname', db.splitName('Bennett').last, 'Bennett');
  eq('with no first name', db.splitName('Bennett').first, null);
  eq('two words split cleanly', db.splitName('Ada Bennett').first, 'Ada');
  eq('surname is the last word', db.splitName('John Q Smith').last, 'Smith');
  eq('everything before it is the first name', db.splitName('John Q Smith').first, 'John Q');
  eq('extra whitespace is tolerated', db.splitName('  Ada   Bennett  ').last, 'Bennett');
  eq('an empty name yields nothing', db.splitName('').last, null);

  // Editing keeps all three fields consistent.
  db.updatePatron(split.patron.id, { first_name: 'Renata M.', last_name: 'Ferreira-Lopes' });
  const edited = db.patronStatus(split.patron.id).patron;
  eq('edited first name', edited.first_name, 'Renata M.');
  eq('edited last name', edited.last_name, 'Ferreira-Lopes');
  eq('display name follows the edit', edited.display_name, 'Renata M. Ferreira-Lopes');
  check('and the new surname is searchable', ids(db.findPatrons('Ferreira-Lo')).includes(split.patron.id));

  db.updatePatron(split.patron.id, { first_name: '', last_name: 'Ferreira-Lopes' });
  eq('clearing the first name leaves the surname',
    db.patronStatus(split.patron.id).patron.display_name, 'Ferreira-Lopes');

  const byNameOnly = db.createPatron({ name: 'Ferreira' });
  check('a name alone is enough', byNameOnly.isNew && byNameOnly.patron.id > 0);
  eq('no ID is stored', byNameOnly.patron.dod_id, null);
  eq('they label by name', db.labelFor(byNameOnly.patron), 'Ferreira');
  check('and are findable by it', ids(db.findPatrons('ferre')).includes(byNameOnly.patron.id));
  check('they can buy a drink like anyone else',
    db.createOrder({ patronId: byNameOnly.patron.id, items: [{ productId: beerId, qty: 1 }] }).orderId > 0);
  eq('and it counts', db.patronStatus(byNameOnly.patron.id).today.servings, 1);

  const sameName = db.createPatron({ name: 'Ferreira' });
  check('a second person with the same name is a separate record',
    sameName.isNew && sameName.patron.id !== byNameOnly.patron.id);

  const byIdOnly = db.createPatron({ dodId: '3216549870' });
  check('an ID alone is enough', byIdOnly.isNew);
  eq('the ID is stored', byIdOnly.patron.dod_id, '3216549870');
  eq('last four derived', byIdOnly.patron.last4, '9870');
  eq('adding the same ID twice returns the existing record',
    db.createPatron({ dodId: '3216549870' }).patron.id, byIdOnly.patron.id);
  check('and does not duplicate', !db.createPatron({ dodId: '3216549870' }).isNew);

  // The point of keying on the ID: a later scan lands on the same person.
  eq('scanning that ID finds the manually added patron',
    db.resolveCard(cac.parseScan('3216549870')).patron.id, byIdOnly.patron.id);
  check('and is not treated as a new card',
    !db.resolveCard(cac.parseScan('3216549870')).isNew);

  const both = db.createPatron({ name: 'D. Whitfield', dodId: '4449998880' });
  eq('name and ID together', both.patron.display_name, 'D. Whitfield');
  eq('with the ID attached', both.patron.dod_id, '4449998880');
  eq('label prefers the name', db.labelFor(both.patron), 'D. Whitfield');
  check('findable by either', ids(db.findPatrons('Whitf')).includes(both.patron.id)
    && ids(db.findPatrons('444999')).includes(both.patron.id));
  check('dashes and spaces in a typed ID are stripped',
    db.createPatron({ name: 'Punctuated', dodId: '111-222 3333' }).patron.dod_id === '1112223333');

  check('an empty submission is refused', (() => {
    try { db.createPatron({}); return false; }
    catch (err) { return /name or a DoD ID/i.test(err.message); }
  })());
  check('whitespace only is refused', (() => {
    try { db.createPatron({ name: '   ', dodId: '  ' }); return false; }
    catch (err) { return /name or a DoD ID/i.test(err.message); }
  })());

  /* ---------------------------------------------------------------- */
  section('Legacy walk-in rows still read');
  // Orders detached by a patron deletion have a null patron_id, exactly like
  // the walk-in rows an older build could create. Reporting must not choke.
  const detached = db.recentOrders({ limit: 40 })
    .find((o) => o.patron_id === null);
  check('a detached order is listed', !!detached);
  eq('and labelled rather than left blank', detached.patron_label, 'Walk-in');
  check('day report still builds', db.dayReport().totals.orders > 0);
  check('sales report still builds', db.salesReport(db.businessDate(), db.businessDate()).totals.orders > 0);
  check('CSV export still builds',
    exporter.runReport('orders', db.businessDate(), db.businessDate()).length > 0);

  /* ---------------------------------------------------------------- */
  section('Underage and barred patrons');
  const minor = db.resolveCard(cac.parseScan('4445556666'));
  db.updatePatron(minor.patron.id, { display_name: 'Too Young', dob: '2010-01-01' });
  check('flagged underage', db.patronStatus(minor.patron.id).underage);
  let underageBlocked = false;
  try {
    db.createOrder({ patronId: minor.patron.id, items: [{ productId: beerId, qty: 1 }] });
  } catch (err) { underageBlocked = /under/i.test(err.message); }
  check('underage sale refused', underageBlocked);
  check('every item on the menu is alcoholic, so nothing can be sold to a minor',
    db.listProducts().every((p) => {
      const q = db.priceTicket({ patronId: minor.patron.id, items: [{ productId: p.id, qty: 1 }] });
      return q.underage;
    }));

  // With nothing non-alcoholic left, a cut-off patron can be sold nothing.
  const atLimit = db.patronStatus(lid);
  check('patron is at the night limit', atLimit.atLimit, String(atLimit.today.servings));
  const boozeQuote = db.priceTicket({ patronId: lid, items: [{ productId: beerId, qty: 1 }] });
  check('alcohol needs an override', boozeQuote.needsOverride);
  check('and there is no zero-alcohol item left to fall back on',
    db.listProducts().every((p) => p.standard_drinks > 0),
    db.listProducts().filter((p) => !(p.standard_drinks > 0)).map((p) => p.name).join(','));

  db.setBan(other.patron.id, true, 'fight in the parking lot');
  check('ban flag set', db.patronStatus(other.patron.id).banned);
  let banBlocked = false;
  try {
    db.createOrder({ patronId: other.patron.id, items: [{ productId: beerId, qty: 1 }] });
  } catch (err) { banBlocked = /barred/i.test(err.message); }
  check('barred patron refused', banBlocked);
  db.setBan(other.patron.id, false);
  check('ban lifted', !db.patronStatus(other.patron.id).banned);

  /* ---------------------------------------------------------------- */
  section('Voids');
  const beforeVoid = db.patronStatus(lid);
  const stockBeforeVoid = db.listProducts().find((p) => p.id === ginId).qty_on_hand;
  db.voidOrder({ orderId: over.orderId, reason: 'rung up on the wrong tab', pin: '1234', actor: 'SSgt Rivera' });
  const afterVoid = db.patronStatus(lid);
  eq('voided drinks come off the night count', afterVoid.today.servings, beforeVoid.today.servings - 1);
  eq('and off the category count', afterVoid.today.byGroup.liquor, beforeVoid.today.byGroup.liquor - 1);
  eq('which puts them back on the liquor cap, not under it', afterVoid.today.byGroup.liquor, 3);
  eq('so liquor is still exhausted', afterVoid.remaining.liquor, 0);
  check('liquor stays cut off', afterVoid.blockedGroups.includes('liquor'));
  eq('but a drink of something else is available again', afterVoid.remaining.total, 1);
  check('and a beer is allowed',
    !db.priceTicket({ patronId: lid, items: [{ productId: beerId, qty: 1 }] }).needsOverride);
  eq('voided stock goes back', db.listProducts().find((p) => p.id === ginId).qty_on_hand, stockBeforeVoid + 1);

  let doubleVoid = false;
  try { db.voidOrder({ orderId: over.orderId, reason: 'again', pin: '1234' }); }
  catch (err) { doubleVoid = /already/i.test(err.message); }
  check('an order cannot be voided twice', doubleVoid);

  let voidPin = false;
  try { db.voidOrder({ orderId: sale1.orderId, reason: 'nope', pin: '5555' }); }
  catch (err) { voidPin = /PIN/i.test(err.message); }
  check('void needs the right PIN', voidPin);

  /* ---------------------------------------------------------------- */
  section('Business date rollover');
  const rollover = Number(db.getSetting('day_rollover_hour'));
  eq('rollover default is 0600', rollover, 6);
  const lateNight = new Date(); lateNight.setHours(1, 30, 0, 0);
  const evening = new Date(); evening.setHours(21, 0, 0, 0);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  eq('0130 belongs to the night before', db.businessDate(lateNight), ymd(yesterday));
  eq('2100 belongs to today', db.businessDate(evening), ymd(new Date()));

  // A rollover hour of 0 makes the business day the calendar day.
  db.setSetting('day_rollover_hour', '0');
  eq('with no rollover, 0130 is its own day', db.businessDate(lateNight), ymd(new Date()));
  db.setSetting('day_rollover_hour', '6');
  eq('rollover restored', db.businessDate(lateNight), ymd(yesterday));

  // A bare YYYY-MM-DD must be read as a local calendar day, not UTC midnight,
  // or everyone west of Greenwich is a day young on their birthday.
  const bday = new Date();
  const thirtyYearsAgoToday =
    `${bday.getFullYear() - 30}-${p(bday.getMonth() + 1)}-${p(bday.getDate())}`;
  eq('someone born exactly 30 years ago today is 30', db.ageOn(thirtyYearsAgoToday), 30);
  eq('and 29 the day before their birthday',
    db.ageOn(thirtyYearsAgoToday, new Date(bday.getTime() - 86400000)), 29);

  /* ---------------------------------------------------------------- */
  section('Limits reset on the new business day');
  const resetPatron = db.resolveCard(cac.parseScan('6006006000'));
  const rid = resetPatron.patron.id;

  // Put this patron at their cap, then back-date the orders a day.
  const yesterdayDate = db.addDays(db.businessDate(), -1);
  const capOrder = db.createOrder({
    patronId: rid, items: [{ productId: ginId, qty: 3 }, { productId: beerId, qty: 1 }],
    bartender: 'SSgt Rivera',
  });
  eq('patron is at the night cap', db.patronStatus(rid).today.servings, 4);
  check('and cut off on liquor', db.patronStatus(rid).blockedGroups.includes('liquor'));

  db.handle().prepare('UPDATE orders SET business_date = ? WHERE id = ?')
    .run(yesterdayDate, capOrder.orderId);

  const fresh = db.patronStatus(rid);
  eq('today the night count is back to zero', fresh.today.servings, 0);
  eq('the beer count reset', fresh.today.byGroup.beer, 0);
  eq('the liquor count reset', fresh.today.byGroup.liquor, 0);
  eq('full headroom again', fresh.remaining.total, 4);
  eq('and full liquor headroom', fresh.remaining.liquor, 3);
  check('nothing is cut off', fresh.blockedGroups.length === 0);
  check('not at the limit', !fresh.atLimit);

  check('so a liquor sells again today',
    !db.priceTicket({ patronId: rid, items: [{ productId: ginId, qty: 1 }] }).needsOverride);
  check('and three liquors are available once more',
    !db.priceTicket({ patronId: rid, items: [{ productId: ginId, qty: 3 }] }).needsOverride);
  check('but four are still refused',
    db.priceTicket({ patronId: rid, items: [{ productId: ginId, qty: 4 }] }).needsOverride);

  // Yesterday's record is intact — the counts moved, the history did not.
  const yday = db.countsToday(rid, yesterdayDate);
  eq('yesterday still shows the four drinks', yday.servings, 4);
  eq('with the liquor split preserved', yday.byGroup.liquor, 3);
  check('and it still appears in reporting',
    db.salesReport(yesterdayDate, yesterdayDate).totals.servings >= 4);

  /* ---------------------------------------------------------------- */
  section('Shift rollover');
  eq('no roll needed on the same business day', db.rollShiftIfStale(), null);

  const staleShift = db.currentShift();
  check('a shift is open', !!staleShift);
  db.handle().prepare('UPDATE shifts SET business_date = ? WHERE id = ?')
    .run(yesterdayDate, staleShift.id);

  const rolled = db.rollShiftIfStale();
  eq('the stale shift is closed out', rolled, staleShift.id);
  const closedRow = db.handle().prepare('SELECT * FROM shifts WHERE id = ?').get(staleShift.id);
  check('it has a close time', !!closedRow.closed_at);
  check('and says why', /rollover/i.test(closedRow.note || ''), closedRow.note);
  check('the rollover is audited',
    db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='shift_rollover'").get().n === 1);
  eq('nothing left open', db.currentShift(), null);

  const newShift = db.openShift('SSgt Rivera');
  eq('opening again starts a shift on the current day', newShift.business_date, db.businessDate());
  check('which is a different shift', newShift.id !== staleShift.id);
  eq('and a second call is idempotent', db.openShift('x').id, newShift.id);

  /* ---------------------------------------------------------------- */
  section('Reports');
  const day = db.dayReport();
  check('orders counted', day.totals.orders >= 3, String(day.totals.orders));
  check('gross sales add up', day.totals.gross_cents > 0);
  check('category breakdown present', day.byCategory.length >= 2);
  check('top sellers present', day.topProducts.length >= 2);
  check('heavy drinkers listed', day.heavyPatrons.length >= 1);
  // Three gins were sold and a fourth was voided, so the void must not show up.
  const ginRow = day.topProducts.find((t) => t.product_name === 'Tanqueray Gin');
  eq('voided units excluded from the totals', ginRow ? ginRow.units : 0, 3);

  /* ---------------------------------------------------------------- */
  section('Sales report');
  const salesToday = db.businessDate();
  const sales = db.salesReport(salesToday, salesToday);
  eq('single-day span', sales.span, 1);
  eq('series covers exactly one night', sales.series.length, 1);
  eq('series total matches the headline', sales.series[0].gross_cents, sales.totals.gross_cents);
  check('gross is positive', sales.totals.gross_cents > 0);
  check('comparison window is the day before',
    sales.previousWindow.from === db.addDays(salesToday, -1) &&
    sales.previousWindow.to === db.addDays(salesToday, -1));
  check('payment breakdown present', sales.byPayment.length >= 1);
  check('card sale recorded', sales.byPayment.some((p) => p.payment_method === 'card'));
  check('hourly buckets cover the clock', sales.hourly.length === 24);
  eq('hourly orders reconcile with the total',
    sales.hourly.reduce((n, h) => n + h.orders, 0), sales.totals.orders);
  eq('hourly cents reconcile with gross',
    sales.hourly.reduce((n, h) => n + h.cents, 0), sales.totals.gross_cents);
  check('busiest night identified', sales.busiest && sales.busiest.date === salesToday);
  eq('nights open counted', sales.nightsOpen, 1);
  check('spend per patron computed', sales.avgPerPatron.cents > 0);
  const salesGin = sales.topProducts.find((t) => t.product_name === 'Tanqueray Gin');
  eq('voided units excluded from the series', salesGin ? salesGin.units : 0, 3);
  check('drinks served reported alongside standard drinks',
    sales.totals.servings > 0 && sales.totals.servings !== sales.totals.drinks);
  eq('series servings reconcile with the total',
    sales.series.reduce((n, d) => n + d.servings, 0), sales.totals.servings);

  // A range with quiet days must still produce a continuous time axis.
  const weekFrom = db.addDays(salesToday, -6);
  const week = db.salesReport(weekFrom, salesToday);
  eq('seven-day span', week.span, 7);
  eq('every date in the range appears, sales or not', week.series.length, 7);
  check('quiet nights are zero, not missing',
    week.series.filter((d) => d.orders === 0).length === 7 - week.nightsOpen,
    `${week.nightsOpen} active of 7`);
  check('dates are in ascending order',
    week.series.every((d, i) => i === 0 || d.date > week.series[i - 1].date));
  eq('range gross is the sum of its nights',
    week.series.reduce((n, d) => n + d.gross_cents, 0), week.totals.gross_cents);
  check("and includes tonight's takings",
    week.totals.gross_cents >= sales.totals.gross_cents && sales.totals.gross_cents > 0);

  eq('date arithmetic crosses a month boundary', db.addDays('2026-03-01', -1), '2026-02-28');
  eq('leap day handled', db.addDays('2024-03-01', -1), '2024-02-29');
  eq('day count is inclusive', db.dayCount('2026-01-01', '2026-01-07'), 7);
  eq('single day counts as one', db.dayCount('2026-01-05', '2026-01-05'), 1);
  eq('listDates is inclusive at both ends', db.listDates('2026-01-01', '2026-01-03').join(','),
     '2026-01-01,2026-01-02,2026-01-03');

  const empty = db.salesReport('2019-01-01', '2019-01-03');
  eq('an empty range reports zero gross', empty.totals.gross_cents, 0);
  eq('an empty range still yields a full axis', empty.series.length, 3);
  eq('no busiest night when nothing sold', empty.busiest, null);

  /* ---------------------------------------------------------------- */
  section('Printable report');
  const html = exporter.buildReportHtml(sales, 'Drop Zone Tea Party');
  check('report is a complete HTML document',
    html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  check('venue name in the heading', html.includes('Drop Zone Tea Party'));
  check('chart rendered as inline SVG', html.includes('<svg') && html.includes('class="bar"'));
  check('nightly table included', html.includes('Takings per night'));
  check('the card hash never reaches the report', !/card_hash/i.test(html));
  const nastyName = 'Bad <script>alert(1)</script> & "Co"';
  db.setProductPrice(products.find((p) => p.name === 'Tuborg Green').id, 123, 'test');
  db.saveProduct({ category: 'na', name: nastyName, price_cents: 100, active: 1, serving_oz: 8, abv: 0 });
  const nastyHtml = exporter.buildReportHtml(db.salesReport(salesToday, salesToday), nastyName);
  check('HTML in venue names is escaped, not injected',
    !nastyHtml.includes('<script>alert(1)</script>') && nastyHtml.includes('&lt;script&gt;'),
    'script tag survived escaping');

  const summary = db.shiftSummary(shift.id);
  check('shift summary totals', summary.totals.orders >= 3);
  const shiftVoids = db.handle().prepare(
    'SELECT COUNT(*) n FROM orders WHERE shift_id = ? AND voided = 1').get(shift.id).n;
  check('there were voids to count', shiftVoids >= 1);
  eq('shift summary counts every one of them', summary.voids.n, shiftVoids);

  const closed = db.closeShift('SSgt Rivera', 'quiet night');
  check('shift closes', !!closed && !!closed.shift.closed_at);
  check('a new sale opens a fresh shift', db.createOrder({
    patronId: rid, items: [{ productId: beerId, qty: 1 }],
  }).orderId > 0 && db.currentShift().id !== shift.id);

  /* ---------------------------------------------------------------- */
  section('Export');
  const today = db.businessDate();
  const names = exporter.reportNames();
  check('report set available', names.length >= 8, names.join(','));

  const lineRows = exporter.runReport('line_items', today, today);
  check('line items exported', lineRows.length >= 3);
  check('dollar columns added next to cents', 'line_usd' in lineRows[0], Object.keys(lineRows[0]).join(','));

  const patronRows = exporter.runReport('patron_drinks_by_day', today, today);
  check('per-patron drink summary produced', patronRows.length >= 1);
  check('the DoD ID travels with the export',
    Object.keys(patronRows[0]).includes('patron_dod_id'),
    Object.keys(patronRows[0]).join(','));
  check('the card hash never leaves the database',
    !Object.keys(patronRows[0]).some((k) => /card_hash/i.test(k)));

  const bundleDir = path.join(tmp, 'bundle');
  const bundle = exporter.exportBundle({ from: today, to: today, dirPath: bundleDir });
  eq('every report written plus the database', bundle.written.length, names.length + 1);
  check('README written', fs.existsSync(path.join(bundleDir, 'README.txt')));
  check('database copied into the bundle', fs.statSync(path.join(bundleDir, 'bar.db')).size > 0);

  const csv = fs.readFileSync(path.join(bundleDir, 'line_items.csv'), 'utf8');
  check('CSV starts with a BOM so Excel reads it correctly', csv.charCodeAt(0) === 0xfeff);
  check('CSV has a header row', csv.split('\r\n')[0].includes('product_name'));

  const backupPath = path.join(tmp, 'backup.db');
  const backup = exporter.backupDb(backupPath);
  check('standalone backup written', backup.bytes > 0);
  const again = exporter.backupDb(backupPath);
  check('backup overwrites cleanly on a second run', again.bytes > 0);

  const Database = require('better-sqlite3');
  const copy = new Database(backupPath, { readonly: true });
  const copiedOrders = copy.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const liveOrders = db.handle().prepare('SELECT COUNT(*) n FROM orders').get().n;
  eq('the backup is a complete, openable database', copiedOrders, liveOrders);
  copy.close();

  /* ---------------------------------------------------------------- */
  section('Automatic backups');
  const backupDir = path.join(tmp, 'usb-stick');
  fs.mkdirSync(backupDir, { recursive: true });

  eq('nothing is backed up before a folder is chosen',
    exporter.runBackup({ reason: 'test', force: true }).skipped, 'no-folder');
  check('and the status says so', !exporter.backupStatus().configured);

  db.setSetting('backup_dir', backupDir);
  const firstBackup = exporter.runBackup({ reason: 'test', force: true });
  check('a copy is written once a folder is set', !!firstBackup.filePath, JSON.stringify(firstBackup));
  check('the file exists on disk', fs.existsSync(firstBackup.filePath));
  check('and is a real database', (() => {
    const Database = require('better-sqlite3');
    const copy = new Database(firstBackup.filePath, { readonly: true });
    const n = copy.prepare('SELECT COUNT(*) n FROM orders').get().n;
    copy.close();
    return n === db.handle().prepare('SELECT COUNT(*) n FROM orders').get().n;
  })());
  check('the backup is audited',
    db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='backup'").get().n >= 1);

  const backupState = exporter.backupStatus();
  check('status reports the folder as reachable', backupState.configured && backupState.reachable);
  eq('and counts the copy', backupState.count, 1);
  check('and records when it ran', !!backupState.lastAt);
  check('nothing further is due today', !exporter.backupIsDue());
  eq('so the daily run stands down',
    exporter.runBackupIfDue('daily').skipped, 'already-today');

  // Rotation: a night's worth of copies must not fill a stick.
  db.setSetting('backup_keep', '3');
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(backupDir, `bar-backup-2026-01-0${i + 1}_120000.db`), 'x');
  }
  check('extra copies exist before pruning', exporter.listBackups().length >= 6);
  exporter.runBackup({ reason: 'test rotation', force: true });
  eq('only the newest are kept', exporter.listBackups().length, 3);
  check('unrelated files in the folder are left alone', (() => {
    fs.writeFileSync(path.join(backupDir, 'do-not-touch.txt'), 'keep me');
    exporter.runBackup({ reason: 'test', force: true });
    return fs.existsSync(path.join(backupDir, 'do-not-touch.txt'));
  })());
  db.setSetting('backup_keep', '30');

  // An unplugged drive must never interrupt service.
  db.setSetting('backup_dir', path.join(tmp, 'no-such-drive'));
  const gone = exporter.runBackup({ reason: 'test', force: true });
  eq('an unreachable folder is skipped, not thrown', gone.skipped, 'unreachable');
  check('and the failure is recorded',
    db.handle().prepare("SELECT COUNT(*) n FROM audit_log WHERE event='backup_failed'").get().n >= 1);
  check('the app can still take orders', db.createOrder({
    patronId: rid, items: [{ productId: beerId, qty: 1 }],
  }).orderId > 0);

  db.setSetting('backup_dir', backupDir);
  db.setSetting('backup_enabled', '0');
  eq('switching it off stops automatic copies',
    exporter.runBackup({ reason: 'test' }).skipped, 'disabled');
  check('but a manual copy still works',
    !!exporter.runBackup({ reason: 'manual', force: true }).filePath);
  db.setSetting('backup_enabled', '1');

  // A copy taken yesterday means today's is due again.
  db.setSetting('last_backup_at', new Date(Date.now() - 36 * 3600 * 1000).toISOString());
  check('a stale backup is due', exporter.backupIsDue());
  check('and the daily run takes one', !!exporter.runBackupIfDue('daily').filePath);

  /* ---------------------------------------------------------------- */
  section('Privacy controls');
  db.setSetting('store_names', '0');
  const anon = db.resolveCard(cac.parseScan('N5QQ1WW2EE3NONAME PERSON     ZZ9XX8CC7VV6BB5NN4MM3'));
  eq('names are not stored when the setting is off', anon.patron.display_name, null);
  check('drink tracking still works without a name',
    db.patronStatus(anon.patron.id).limits.total === 4);
  db.setSetting('store_names', '1');

  db.setSetting('pii_retention_days', '30');
  db.handle().prepare("UPDATE patrons SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
    .run(other.patron.id);
  const purge = db.purgeOldPii();
  check('stale identities purged', purge.purged >= 1, JSON.stringify(purge));
  const purged = db.handle().prepare('SELECT * FROM patrons WHERE id = ?').get(other.patron.id);
  eq('name cleared by the purge', purged.display_name, null);
  check('the patron row and their history survive', !!purged.card_hash);
  db.setSetting('pii_retention_days', '0');
  eq('retention of 0 purges nothing', db.purgeOldPii().purged, 0);

  db.setPin('864209');
  check('new PIN verifies', db.verifyPin('864209'));
  check('old PIN no longer works', !db.verifyPin('1234'));
  eq('default-PIN warning clears', db.getSetting('manager_pin_is_default'), '0');

  /* ---------------------------------------------------------------- */
  section('Durability');
  eq('write-ahead logging on', db.handle().pragma('journal_mode', { simple: true }), 'wal');
  eq('foreign keys enforced', db.handle().pragma('foreign_keys', { simple: true }), 1);
  eq('synchronous set to FULL', db.handle().pragma('synchronous', { simple: true }), 2);

  const productsBeforeRestart = db.listProducts({ includeInactive: true }).length;
  const ordersBeforeRestart = db.handle().prepare('SELECT COUNT(*) n FROM orders').get().n;
  db.close();

  const reopened = db.open(tmp);
  eq('data survives a restart',
    db.handle().prepare('SELECT COUNT(*) n FROM orders').get().n, ordersBeforeRestart);
  check('same database file', reopened === dbPath);
  eq('products not re-seeded on restart',
    db.listProducts({ includeInactive: true }).length, productsBeforeRestart);
  eq('prices survive a restart',
    db.listProducts().filter((p) => p.category === 'wine').every((p) => p.price_cents === 700), true);
  db.close();

  /* ---------------------------------------------------------------- */
  console.log(`\n${'='.repeat(56)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(56));
  return failures.length === 0;
}

let ok = false;
try {
  ok = main();
} catch (err) {
  console.error('\nTest harness crashed:\n', err);
  ok = false;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(ok ? 0 : 1);
