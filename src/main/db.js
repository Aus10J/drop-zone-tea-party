'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

let db = null;
let dbPath = null;

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per physical card we have ever seen.
-- card_hash is an HMAC of the raw scanner payload keyed by a per-install salt:
-- it is stable across rescans but is not reversible back to a DoD ID.
CREATE TABLE IF NOT EXISTS patrons (
  id            INTEGER PRIMARY KEY,
  card_hash     TEXT NOT NULL UNIQUE,
  -- The identifier as scanned: the DoD ID when we can read one, and the raw
  -- barcode payload either way. card_hash stays the lookup key because it is
  -- fixed-width and uniquely indexed, but these are what a human reads.
  dod_id        TEXT,
  card_payload  TEXT,
  dod_id_hash   TEXT,
  last4         TEXT,
  first_name    TEXT,
  last_name     TEXT,
  display_name  TEXT,
  dob           TEXT,
  branch        TEXT,
  rank          TEXT,
  is_banned     INTEGER NOT NULL DEFAULT 0,
  ban_reason    TEXT,
  notes         TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patrons_name ON patrons(display_name);
CREATE INDEX IF NOT EXISTS idx_patrons_dod ON patrons(dod_id_hash);
-- NOTE: the index on patrons(dod_id) is created in migrate(), not here. On a
-- database that predates the column, CREATE TABLE IF NOT EXISTS is a no-op and
-- indexing a column that does not exist yet fails the whole open().

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY,
  category        TEXT NOT NULL,
  brand           TEXT,
  name            TEXT NOT NULL,
  abv             REAL,
  serving_oz      REAL,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  standard_drinks REAL NOT NULL DEFAULT 1,
  sku             TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category, sort_order);

CREATE TABLE IF NOT EXISTS inventory (
  product_id      INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  qty_on_hand     REAL NOT NULL DEFAULT 0,
  unit            TEXT NOT NULL DEFAULT 'each',
  par_level       REAL NOT NULL DEFAULT 0,
  last_counted_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta      REAL NOT NULL,
  new_qty    REAL NOT NULL,
  reason     TEXT NOT NULL,
  order_id   INTEGER,
  actor      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adj_product ON inventory_adjustments(product_id, created_at);

CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY,
  business_date TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  opened_by     TEXT,
  closed_by     TEXT,
  drink_limit   REAL NOT NULL,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(business_date);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  shift_id        INTEGER REFERENCES shifts(id),
  patron_id       INTEGER REFERENCES patrons(id),
  business_date   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  subtotal_cents  INTEGER NOT NULL,
  payment_method  TEXT NOT NULL,
  standard_drinks REAL NOT NULL,
  bartender       TEXT,
  voided          INTEGER NOT NULL DEFAULT 0,
  voided_at       TEXT,
  void_reason     TEXT,
  override_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_patron_day ON orders(patron_id, business_date, voided);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(business_date, voided);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id),
  product_name     TEXT NOT NULL,
  category         TEXT NOT NULL,
  qty              INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  standard_drinks  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  actor      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
`;

/* ------------------------------------------------------------------ *
 * Defaults + seed
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  venue_name: 'Drop Zone Tea Party',
  // The night's ceiling, in drinks served. Category caps sit underneath it and
  // whichever binds first wins: with total 4 / liquor 3, someone can have four
  // beers, or three liquors plus a beer, but never a fourth liquor.
  drink_limit: '4',
  limit_beer: '4',
  limit_wine: '4',
  limit_liquor: '3',
  day_rollover_hour: '6',
  limit_mode: 'block',           // block | warn | track
  require_pin_for_override: '1',
  require_pin_for_void: '1',
  require_pin_for_admin: '1',
  min_age: '21',
  store_names: '1',
  pii_retention_days: '0',       // 0 = keep indefinitely
  low_stock_warn: '1',
  block_sale_when_out_of_stock: '0',
  bartender_name: '',
  schema_version: '1',
};

// Seeded from the venue's own weekend menu board.
const SEED_PRODUCTS = [
  // category, brand, name, abv, oz, price, sort
  ['beer', 'Kaiju!', 'Kaiju! Metamorphosis IPA', 7.0, 12, 500, 10],
  ['beer', 'Carlsburg', 'Carlsburg Pilsner', 5.0, 12, 500, 20],
  ['beer', 'Kronenbourg', 'Kronenbourg 1664', 5.5, 12, 500, 30],
  ['beer', 'Leffe', 'Leffe Blonde Belgian Ale', 6.0, 12, 500, 40],
  ['beer', 'Tuborg', 'Tuborg Green', 4.6, 12, 500, 50],

  ['spirit', 'Jose Cuervo', 'Jose Cuervo Silver', 38.0, 1.5, 600, 10],
  ['spirit', "Tito's", "Tito's Vodka", 40.0, 1.5, 600, 20],
  ['spirit', 'Captain Morgan', 'Captain Morgan Dark Rum', 40.0, 1.5, 600, 30],
  ['spirit', 'Tanqueray', 'Tanqueray Gin', 43.1, 1.5, 600, 40],
  ['spirit', "Jack Daniel's", 'Jack Daniels Whiskey', 40.0, 1.5, 600, 50],
  ['spirit', 'Woodford', 'Woodford Reserve', 45.2, 1.5, 600, 60],

  ['wine', 'Dark Horse', 'Dark Horse Merlot', 13.5, 5, 700, 10],
  ['wine', 'Douglass Hill', 'Douglass Hill Chardonnay', 13.5, 5, 700, 20],
  ['wine', 'Mouton Cadet', 'Mouton Cadet Sauvignon Blanc', 12.5, 5, 700, 30],
];

/* ------------------------------------------------------------------ *
 * Drink limits
 *
 * Limits are enforced in DRINKS SERVED, not ABV-weighted standard drinks:
 * one pour is one drink whether it is a 4.6% lager or a 7% IPA. That is what
 * a bartender can explain across the bar, and it is how the policy was
 * written. Standard drinks are still calculated and reported — they just do
 * not gate the sale.
 *
 * Each category belongs to a limit group. Cocktails count against liquor
 * because that is what is in them. Non-alcoholic belongs to no group and is
 * never counted or blocked.
 * ------------------------------------------------------------------ */

const LIMIT_GROUPS = Object.freeze({
  beer: 'beer',
  wine: 'wine',
  spirit: 'liquor',
  cocktail: 'liquor',
});

const GROUP_LABELS = Object.freeze({
  total: 'Night', beer: 'Beer', wine: 'Wine', liquor: 'Liquor',
});

const GROUPS = Object.freeze(['beer', 'wine', 'liquor']);

/** The limit group a menu category counts against, or null if it is exempt. */
function limitGroup(category) {
  return LIMIT_GROUPS[category] || null;
}

function limitSettings() {
  return {
    total: Number(getSetting('drink_limit') || 4),
    beer: Number(getSetting('limit_beer') || 4),
    wine: Number(getSetting('limit_wine') || 4),
    liquor: Number(getSetting('limit_liquor') || 3),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const zeroGroups = () => ({ beer: 0, wine: 0, liquor: 0 });

/** US standard drink = 0.6 fl oz of pure ethanol. */
function standardDrinks(servingOz, abv) {
  const oz = Number(servingOz) || 0;
  const a = Number(abv) || 0;
  if (oz <= 0 || a <= 0) return 0;
  return Math.round(((oz * (a / 100)) / 0.6) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Open / migrate
 * ------------------------------------------------------------------ */

function open(userDataDir) {
  const dir = path.join(userDataDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'bar.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL'); // a bar POS can lose power; prefer durability
  db.exec(SCHEMA);
  migrate();

  const insertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  const seedSettings = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
    if (!getSetting('id_salt')) {
      insertSetting.run('id_salt', crypto.randomBytes(32).toString('hex'));
    }
    if (!getSetting('manager_pin')) {
      // Default PIN 1234; the UI nags until it is changed.
      insertSetting.run('manager_pin', hashPin('1234'));
      insertSetting.run('manager_pin_is_default', '1');
    }
  });
  seedSettings();

  if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) seedProducts();

  return dbPath;
}

/**
 * Bring an existing database up to the current shape. CREATE TABLE IF NOT
 * EXISTS does nothing to a table that already exists, so new columns have to
 * be added explicitly or a bar that has been running for a month breaks on
 * upgrade.
 */
function migrate() {
  const addColumn = (table, column, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.includes(column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  };

  const added = [];
  if (addColumn('patrons', 'dod_id', 'TEXT')) added.push('patrons.dod_id');
  if (addColumn('patrons', 'card_payload', 'TEXT')) added.push('patrons.card_payload');
  const splitNames = addColumn('patrons', 'first_name', 'TEXT');
  if (splitNames) added.push('patrons.first_name');
  if (addColumn('patrons', 'last_name', 'TEXT')) added.push('patrons.last_name');

  // Names used to be one free-text field. Split what is already on file so the
  // existing roster is searchable by surname like everything added from now on.
  if (splitNames) {
    const rows = db.prepare(
      'SELECT id, display_name FROM patrons WHERE display_name IS NOT NULL').all();
    const set = db.prepare('UPDATE patrons SET first_name = ?, last_name = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of rows) {
        const { first, last } = splitName(r.display_name);
        set.run(first, last, r.id);
      }
    });
    tx();
    if (rows.length) audit('names_split', `${rows.length} name(s) split into first/last`, 'system');
  }

  // Safe to run every open: the columns are guaranteed to exist by this point.
  db.exec('CREATE INDEX IF NOT EXISTS idx_patrons_dodid ON patrons(dod_id)');

  if (added.length) audit('schema_migrated', added.join(', '), 'system');

  // last4 exists so a bartender can search the last four of an ID. Derive it
  // wherever the full ID is on file but the column was never filled.
  const backfilled = db.prepare(`
    UPDATE patrons SET last4 = substr(dod_id, -4)
     WHERE dod_id IS NOT NULL AND (last4 IS NULL OR last4 = '')`).run();
  if (backfilled.changes) {
    audit('patrons_backfilled',
      `${backfilled.changes} last-4 value(s) derived from the stored DoD ID`, 'system');
  }

  // Non-alcoholic drinks were dropped from the menu. Retire any an earlier
  // version seeded or someone created, rather than deleting them — past
  // orders still reference the rows. Idempotent, so it is safe every launch.
  const retired = db.prepare(
    "UPDATE products SET active = 0 WHERE category = 'na' AND active = 1").run();
  if (retired.changes) {
    audit('products_retired',
      `${retired.changes} non-alcoholic item(s) taken off the menu`, 'system');
  }
}

function seedProducts() {
  const insP = db.prepare(`INSERT INTO products
    (category, brand, name, abv, serving_oz, price_cents, standard_drinks, active, sort_order)
    VALUES (?,?,?,?,?,?,?,1,?)`);
  const insI = db.prepare(`INSERT INTO inventory (product_id, qty_on_hand, unit, par_level)
    VALUES (?, 0, 'each', 0)`);
  const tx = db.transaction(() => {
    for (const [cat, brand, name, abv, oz, price, sort] of SEED_PRODUCTS) {
      const r = insP.run(cat, brand, name, abv, oz, price, standardDrinks(oz, abv), sort);
      insI.run(r.lastInsertRowid);
    }
    audit('seed_products', `${SEED_PRODUCTS.length} products seeded from menu board`, 'system');
  });
  tx();
}

function close() {
  if (db) { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ } db.close(); db = null; }
}

function getDbPath() { return dbPath; }
function handle() { return db; }

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nowIso() { return new Date().toISOString(); }

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  delete out.manager_pin;   // never leave the main process
  delete out.id_salt;
  return out;
}

function audit(event, detail, actor) {
  db.prepare('INSERT INTO audit_log (created_at, event, detail, actor) VALUES (?,?,?,?)')
    .run(nowIso(), event, detail == null ? null : String(detail), actor || null);
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPin(pin) {
  const stored = getSetting('manager_pin');
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const key = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

function setPin(pin) {
  setSetting('manager_pin', hashPin(pin));
  setSetting('manager_pin_is_default', '0');
  audit('pin_changed', null, 'manager');
}

/**
 * Split a single typed name into first and last. The final word is treated as
 * the surname, so "John Q Smith" gives Smith, and a lone word is a surname —
 * which is how people are usually entered at a bar.
 */
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: null, last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/** First + last back into the one string used for display and reporting. */
function composeName(first, last) {
  const joined = [String(first || '').trim(), String(last || '').trim()]
    .filter(Boolean).join(' ');
  return joined || null;
}

/**
 * How a patron is shown when nobody has typed a name: the DoD ID if the scan
 * gave one, otherwise a short tail of the card payload so the bartender still
 * has something to say out loud. Nothing here is ever keyed in by hand.
 */
function labelFor(p) {
  if (!p) return 'Walk-in';
  if (p.display_name) return p.display_name;
  if (p.dod_id) return `DoD ${p.dod_id}`;
  if (p.last4) return `ID #${p.last4}`;
  if (p.card_payload) return `Card …${String(p.card_payload).slice(-5)}`;
  return `Patron ${p.id}`;
}

/** HMAC a card payload with the per-install salt. Not reversible to a DoD ID. */
function hmacId(value) {
  const salt = getSetting('id_salt') || '';
  return crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(String(value)).digest('hex');
}

/**
 * The "business date" for drink limits. A drink poured at 0100 belongs to the
 * night before, so anything earlier than day_rollover_hour rolls back a day.
 */
function businessDate(when) {
  const rollover = Number(getSetting('day_rollover_hour') || 6);
  const d = when ? new Date(when) : new Date();
  if (d.getHours() < rollover) d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ageOn(dobIso, when) {
  if (!dobIso) return null;
  // Same UTC-midnight trap as fmtDate: a bare date would land on the previous
  // local day and make someone a day young on their birthday.
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(dobIso)
    ? new Date(`${dobIso}T12:00:00`)
    : new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  const ref = when ? new Date(when) : new Date();
  let age = ref.getFullYear() - dob.getFullYear();
  const m = ref.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) age--;
  return age;
}

/* ------------------------------------------------------------------ *
 * Shifts
 * ------------------------------------------------------------------ */

function currentShift() {
  return db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get() || null;
}

/**
 * Close an open shift that belongs to a previous business day.
 *
 * The POS is often left running overnight, or all week. Without this, orders
 * rung after the rollover would carry the new business date but hang off the
 * old shift, so the shift totals and the nightly totals would disagree.
 * Returns the id of the shift it closed, or null.
 */
function rollShiftIfStale() {
  const s = currentShift();
  if (!s) return null;
  const today = businessDate();
  if (s.business_date === today) return null;

  db.prepare('UPDATE shifts SET closed_at = ?, closed_by = ?, note = ? WHERE id = ?')
    .run(nowIso(), s.opened_by || null,
         'auto-closed at business-day rollover', s.id);
  audit('shift_rollover', `shift ${s.id} (${s.business_date}) auto-closed; now ${today}`, 'system');
  return s.id;
}

function openShift(openedBy) {
  rollShiftIfStale();
  const existing = currentShift();
  if (existing) return existing;
  const limit = Number(getSetting('drink_limit') || 4);
  const r = db.prepare(
    'INSERT INTO shifts (business_date, opened_at, opened_by, drink_limit) VALUES (?,?,?,?)'
  ).run(businessDate(), nowIso(), openedBy || null, limit);
  audit('shift_open', `shift ${r.lastInsertRowid}`, openedBy);
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(r.lastInsertRowid);
}

function closeShift(closedBy, note) {
  const s = currentShift();
  if (!s) return null;
  db.prepare('UPDATE shifts SET closed_at = ?, closed_by = ?, note = ? WHERE id = ?')
    .run(nowIso(), closedBy || null, note || null, s.id);
  audit('shift_close', `shift ${s.id}`, closedBy);
  return shiftSummary(s.id);
}

function shiftSummary(shiftId) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!s) return null;
  const totals = db.prepare(`
    SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) gross_cents,
           COALESCE(SUM(standard_drinks),0) drinks
      FROM orders WHERE shift_id = ? AND voided = 0`).get(shiftId);
  totals.servings = db.prepare(`
    SELECT COALESCE(SUM(oi.qty),0) n
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.shift_id = ? AND o.voided = 0 AND oi.standard_drinks > 0`).get(shiftId).n;
  const byPayment = db.prepare(`
    SELECT payment_method, COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) cents
      FROM orders WHERE shift_id = ? AND voided = 0
     GROUP BY payment_method ORDER BY cents DESC`).all(shiftId);
  const byCategory = db.prepare(`
    SELECT oi.category, SUM(oi.qty) units,
           SUM(oi.qty * oi.unit_price_cents) cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.shift_id = ? AND o.voided = 0
     GROUP BY oi.category ORDER BY cents DESC`).all(shiftId);
  const topProducts = db.prepare(`
    SELECT oi.product_name, SUM(oi.qty) units, SUM(oi.qty * oi.unit_price_cents) cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.shift_id = ? AND o.voided = 0
     GROUP BY oi.product_name ORDER BY units DESC LIMIT 15`).all(shiftId);
  const patrons = db.prepare(`
    SELECT COUNT(DISTINCT patron_id) n FROM orders
     WHERE shift_id = ? AND voided = 0 AND patron_id IS NOT NULL`).get(shiftId);
  const overrides = db.prepare(`
    SELECT COUNT(*) n FROM orders
     WHERE shift_id = ? AND voided = 0 AND override_reason IS NOT NULL`).get(shiftId);
  const voids = db.prepare(
    'SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) cents FROM orders WHERE shift_id = ? AND voided = 1'
  ).get(shiftId);

  return { shift: s, totals, byPayment, byCategory, topProducts,
           patronCount: patrons.n, overrideCount: overrides.n, voids };
}

/* ------------------------------------------------------------------ *
 * Patrons
 * ------------------------------------------------------------------ */

/**
 * What a patron has had tonight, counted per limit group.
 *
 * Only alcoholic lines count — `standard_drinks > 0` is the test, so a Coke or
 * a coffee contributes nothing no matter how many they buy. Servings come from
 * the line quantity, so two beers on one ticket count two.
 */
function countsToday(patronId, date) {
  const d = date || businessDate();

  const rows = db.prepare(`
    SELECT oi.category, SUM(oi.qty) servings, SUM(oi.standard_drinks) std
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.patron_id = ? AND o.business_date = ? AND o.voided = 0
       AND oi.standard_drinks > 0
     GROUP BY oi.category`).all(patronId, d);

  const byGroup = zeroGroups();
  let servings = 0;
  let std = 0;
  for (const r of rows) {
    servings += r.servings;
    std += r.std;
    const g = limitGroup(r.category);
    if (g) byGroup[g] += r.servings;
  }

  const head = db.prepare(`
    SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) cents
      FROM orders WHERE patron_id = ? AND business_date = ? AND voided = 0`).get(patronId, d);

  return {
    date: d,
    servings,
    byGroup,
    standardDrinks: round2(std),
    orders: head.orders,
    cents: head.cents,
  };
}

/** Kept for reporting callers that want the ABV-weighted figure. */
function drinksToday(patronId, date) {
  const c = countsToday(patronId, date);
  return {
    drinks: c.standardDrinks, servings: c.servings, byGroup: c.byGroup,
    orders: c.orders, cents: c.cents, date: c.date,
  };
}

/**
 * Resolve a scanner payload to a patron record, creating one on first sight.
 * `parsed` comes from cac.js and may be almost entirely empty — that is fine,
 * identity rests on the card hash alone.
 */
function resolveCard(parsed) {
  const cardHash = hmacId(parsed.raw);
  const dodHash = parsed.edipi ? hmacId(`edipi:${parsed.edipi}`) : null;
  const storeNames = getSetting('store_names') === '1';
  const ts = nowIso();

  let patron = db.prepare('SELECT * FROM patrons WHERE card_hash = ?').get(cardHash);
  let isNew = false;

  // A reissued card has a new payload but the same DoD ID — re-link it so the
  // patron's history and tonight's count follow them.
  if (!patron && dodHash) {
    const prior = db.prepare(
      'SELECT * FROM patrons WHERE dod_id_hash = ? ORDER BY id LIMIT 1'
    ).get(dodHash);
    if (prior) {
      db.prepare('UPDATE patrons SET card_hash = ?, last_seen_at = ? WHERE id = ?')
        .run(cardHash, ts, prior.id);
      audit('card_relinked', `patron ${prior.id} scanned a reissued card`, 'system');
      patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(prior.id);
    }
  }

  if (!patron) {
    isNew = true;
    const r = db.prepare(`INSERT INTO patrons
      (card_hash, dod_id, card_payload, dod_id_hash, last4, display_name, dob,
       branch, rank, first_seen_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      cardHash,
      parsed.edipi || null,
      parsed.raw || null,
      dodHash,
      parsed.last4 || null,
      // Whatever the barcode gave up, stored automatically. Nothing is typed
      // at the bar — a blank name is fine and the patron still tracks.
      storeNames ? (parsed.name || null) : null,
      parsed.dob || null,
      parsed.branch || null,
      parsed.rank || null,
      ts, ts
    );
    patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(r.lastInsertRowid);
    audit('patron_created', `patron ${patron.id}`, 'system');
  } else {
    // Backfill anything the parse learned that we did not already have.
    db.prepare(`UPDATE patrons SET
        last_seen_at = ?,
        dod_id       = COALESCE(dod_id, ?),
        card_payload = COALESCE(card_payload, ?),
        dod_id_hash  = COALESCE(dod_id_hash, ?),
        last4        = COALESCE(last4, ?),
        display_name = COALESCE(display_name, ?),
        dob          = COALESCE(dob, ?),
        branch       = COALESCE(branch, ?),
        rank         = COALESCE(rank, ?)
      WHERE id = ?`).run(
      ts, parsed.edipi || null, parsed.raw || null,
      dodHash, parsed.last4 || null,
      storeNames ? (parsed.name || null) : null,
      parsed.dob || null, parsed.branch || null, parsed.rank || null,
      patron.id
    );
    patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(patron.id);
  }

  return { patron, isNew };
}

/**
 * Add a patron by hand — a name, a DoD ID, or both. No ID is required.
 *
 * Identity is keyed off the DoD ID when one is given, so that later scanning
 * the ID (or a card whose barcode yields it) lands on this same person rather
 * than a duplicate. With only a name there is nothing stable to key on, so a
 * random key is used and they are found by searching the name.
 */
function createPatron({ name, firstName, lastName, dodId } = {}) {
  const digits = String(dodId || '').replace(/\D/g, '');

  // Accept either the split fields or a single typed name.
  let first = String(firstName || '').trim() || null;
  let last = String(lastName || '').trim() || null;
  if (!first && !last && name) ({ first, last } = splitName(name));
  const display = composeName(first, last);

  if (!digits && !display) throw new Error('Enter a name or a DoD ID.');

  if (digits) {
    const existing = db.prepare('SELECT * FROM patrons WHERE dod_id = ?').get(digits);
    if (existing) return { patron: existing, isNew: false };
  }

  const cardHash = digits ? hmacId(digits) : hmacId(`manual:${crypto.randomUUID()}`);
  const clash = db.prepare('SELECT * FROM patrons WHERE card_hash = ?').get(cardHash);
  if (clash) return { patron: clash, isNew: false };

  const ts = nowIso();
  const keepNames = getSetting('store_names') === '1';
  const r = db.prepare(`INSERT INTO patrons
      (card_hash, dod_id, card_payload, dod_id_hash, last4,
       display_name, first_name, last_name, first_seen_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    cardHash,
    digits || null,
    digits || null,
    digits ? hmacId(`edipi:${digits}`) : null,
    digits ? digits.slice(-4) : null,
    keepNames ? display : null,
    keepNames ? first : null,
    keepNames ? last : null,
    ts, ts
  );

  const patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(r.lastInsertRowid);
  audit('patron_created_manually', labelFor(patron), 'bartender');
  return { patron, isNew: true };
}

function patronStatus(patronId) {
  const patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(patronId);
  if (!patron) return null;

  const limits = limitSettings();
  const minAge = Number(getSetting('min_age') || 21);
  const today = countsToday(patronId);
  const age = ageOn(patron.dob);

  const lifetime = db.prepare(`
    SELECT COUNT(*) visits, COALESCE(SUM(standard_drinks),0) drinks
      FROM (SELECT business_date, SUM(standard_drinks) standard_drinks
              FROM orders WHERE patron_id = ? AND voided = 0
             GROUP BY business_date)`).get(patronId);

  // Headroom left on each cap. A group is capped by its own limit *and* by
  // what is left on the night total, so the effective figure is the smaller.
  const headroomTotal = Math.max(0, limits.total - today.servings);
  const remaining = { total: headroomTotal };
  const effective = {};
  const blockedGroups = [];
  for (const g of GROUPS) {
    remaining[g] = Math.max(0, limits[g] - today.byGroup[g]);
    effective[g] = Math.min(remaining[g], headroomTotal);
    if (effective[g] <= 0) blockedGroups.push(g);
  }

  return {
    patron,
    label: labelFor(patron),
    today,
    limits,
    remaining,
    effective,
    blockedGroups,
    atLimit: today.servings >= limits.total,
    limitMode: getSetting('limit_mode') || 'block',
    age,
    underage: age != null && age < minAge,
    minAge,
    banned: !!patron.is_banned,
    visits: lifetime.visits,
    lifetimeDrinks: round2(lifetime.drinks),
  };
}

function updatePatron(id, fields) {
  const allowed = ['display_name', 'dob', 'branch', 'rank', 'notes', 'last4'];
  const sets = [], vals = [];
  const handled = new Set();
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);

  // Attaching a DoD ID to a card whose barcode never yielded one is what makes
  // that patron findable by ID. It also stores the ID hash, so a later scan of
  // a reissued card re-links to them instead of creating a second record.
  if (has('dod_id')) {
    const digits = String(fields.dod_id || '').replace(/\D/g, '');
    if (digits) {
      const clash = db.prepare(
        'SELECT id FROM patrons WHERE dod_id = ? AND id != ?').get(digits, id);
      if (clash) {
        throw new Error(`DoD ID ${digits} is already on ${labelFor(
          db.prepare('SELECT * FROM patrons WHERE id = ?').get(clash.id))}.`);
      }
      sets.push('dod_id = ?', 'last4 = ?', 'dod_id_hash = ?');
      vals.push(digits, digits.slice(-4), hmacId(`edipi:${digits}`));
    } else {
      sets.push('dod_id = NULL', 'dod_id_hash = NULL');
    }
    handled.add('dod_id');
    handled.add('last4');
  }

  // First/last and the display string are one fact stored three ways — keep
  // them consistent whichever the caller supplies.
  if (has('first_name') || has('last_name')) {
    const current = db.prepare('SELECT * FROM patrons WHERE id = ?').get(id) || {};
    const first = (has('first_name') ? fields.first_name : current.first_name) || null;
    const last = (has('last_name') ? fields.last_name : current.last_name) || null;
    sets.push('first_name = ?', 'last_name = ?', 'display_name = ?');
    vals.push(String(first || '').trim() || null,
      String(last || '').trim() || null,
      composeName(first, last));
    handled.add('first_name');
    handled.add('last_name');
    handled.add('display_name');
  } else if (has('display_name')) {
    const { first, last } = splitName(fields.display_name);
    sets.push('display_name = ?', 'first_name = ?', 'last_name = ?');
    vals.push(composeName(first, last), first, last);
    handled.add('display_name');
  }

  for (const k of allowed) {
    if (has(k) && !handled.has(k)) {
      sets.push(`${k} = ?`);
      vals.push(fields[k] === '' ? null : fields[k]);
    }
  }
  if (!sets.length) return patronStatus(id);
  vals.push(id);
  db.prepare(`UPDATE patrons SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  audit('patron_updated', `patron ${id}: ${sets.join(', ')}`, 'bartender');
  return patronStatus(id);
}

function setBan(id, banned, reason) {
  db.prepare('UPDATE patrons SET is_banned = ?, ban_reason = ? WHERE id = ?')
    .run(banned ? 1 : 0, banned ? (reason || null) : null, id);
  audit(banned ? 'patron_banned' : 'patron_unbanned', `patron ${id}: ${reason || ''}`, 'manager');
  return patronStatus(id);
}

/** How much history a patron carries, so a delete can be confirmed honestly. */
function patronFootprint(id) {
  const r = db.prepare(`
    SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) cents,
           COUNT(DISTINCT business_date) nights
      FROM orders WHERE patron_id = ?`).get(id);
  return { orders: r.orders, cents: r.cents, nights: r.nights };
}

/**
 * Remove a patron record.
 *
 * Their orders are kept and detached rather than deleted — the drinks were
 * poured and the money was taken, so removing them would put the sales
 * reports at odds with the till. The person disappears; the takings do not.
 */
function deletePatron(id) {
  const patron = db.prepare('SELECT * FROM patrons WHERE id = ?').get(id);
  if (!patron) throw new Error('Patron not found.');
  const footprint = patronFootprint(id);

  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET patron_id = NULL WHERE patron_id = ?').run(id);
    db.prepare('DELETE FROM patrons WHERE id = ?').run(id);
  });
  tx();

  audit('patron_deleted',
    `${labelFor(patron)} removed; ${footprint.orders} order(s) detached and kept`, 'manager');
  return { id, ...footprint };
}

/**
 * Roster search.
 *
 * NAMED parameters, deliberately. With positional `?` the bindings follow the
 * order the placeholders appear in the SQL *text*, and the drinks_today
 * subquery sits in the SELECT clause — ahead of the WHERE. Adding a search
 * term therefore shifted every binding by one, so the business-date comparison
 * silently received the search string and every row reported zero drinks.
 * Named parameters cannot drift like that.
 */
function listPatrons({ search, limit = 200 } = {}) {
  const term = (search || '').trim();
  const rows = db.prepare(`
    SELECT p.*,
           (SELECT COALESCE(SUM(oi.qty),0)
              FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.patron_id = p.id AND o.voided = 0
               AND o.business_date = @day AND oi.standard_drinks > 0) AS drinks_today
      FROM patrons p
     WHERE @like IS NULL
        OR p.display_name LIKE @like
        OR p.first_name   LIKE @like
        OR p.last_name    LIKE @like
        OR p.dod_id       LIKE @like
        OR p.last4        LIKE @like
        OR p.card_payload LIKE @like
        OR p.notes        LIKE @like
     -- Anyone already drinking tonight floats to the top: mid-service that is
     -- almost always who is being looked for.
     ORDER BY drinks_today DESC, p.last_seen_at DESC
     LIMIT @limit`).all({
    day: businessDate(),
    like: term ? `%${term}%` : null,
    limit,
  });
  return rows.map((r) => ({ ...r, label: labelFor(r) }));
}

/**
 * Find existing patrons by a partial identifier — no side effects.
 *
 * This is what the bar's manual entry box uses. Typing part of a DoD ID must
 * FIND somebody, never create them: resolveCard() hashes whatever it is given,
 * so feeding it "765432" would mint a junk patron rather than matching the
 * person standing at the bar.
 *
 * Ranked so the most literal match wins: exact ID, then ID prefix, then an
 * exact last-four, then a name prefix, then anything containing the term.
 */
function findPatrons(term, limit = 12) {
  const t = String(term || '').trim();
  if (!t) return [];

  const rows = db.prepare(`
    SELECT p.*,
           (SELECT COALESCE(SUM(oi.qty),0)
              FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.patron_id = p.id AND o.voided = 0
               AND o.business_date = @day AND oi.standard_drinks > 0) AS drinks_today,
           CASE
             WHEN p.dod_id = @exact                THEN 0
             WHEN p.dod_id LIKE @prefix            THEN 1
             WHEN p.last4  = @exact                THEN 2
             WHEN p.dod_id LIKE @like              THEN 3
             WHEN p.last_name LIKE @prefix         THEN 4
             WHEN p.display_name LIKE @prefix      THEN 5
             ELSE 6
           END AS match_rank
      FROM patrons p
     WHERE p.dod_id       LIKE @like
        OR p.last4        LIKE @like
        OR p.display_name LIKE @like
        OR p.first_name   LIKE @like
        OR p.last_name    LIKE @like
        OR p.card_payload LIKE @like
        OR p.notes        LIKE @like
     ORDER BY match_rank, drinks_today DESC, p.last_seen_at DESC
     LIMIT @limit`).all({
    exact: t, prefix: `${t}%`, like: `%${t}%`, day: businessDate(), limit,
  });

  return rows.map((r) => ({ ...r, label: labelFor(r) }));
}

function patronHistory(id, limit = 100) {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE patron_id = ? ORDER BY created_at DESC LIMIT ?`).all(id, limit);
  const itemsFor = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  for (const o of orders) o.items = itemsFor.all(o.id);
  return orders;
}

/** Clear identifying fields on patrons not seen within the retention window. */
function purgeOldPii() {
  const days = Number(getSetting('pii_retention_days') || 0);
  if (!days || days <= 0) return { purged: 0, days: 0 };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const r = db.prepare(`UPDATE patrons
       SET display_name = NULL, dob = NULL, branch = NULL, rank = NULL
     WHERE last_seen_at < ?
       AND (display_name IS NOT NULL OR dob IS NOT NULL
            OR branch IS NOT NULL OR rank IS NOT NULL)`).run(cutoff);
  if (r.changes) audit('pii_purged', `${r.changes} patrons older than ${days}d`, 'system');
  return { purged: r.changes, days };
}

/* ------------------------------------------------------------------ *
 * Products + inventory
 * ------------------------------------------------------------------ */

function listProducts({ includeInactive = false } = {}) {
  return db.prepare(`
    SELECT p.*, COALESCE(i.qty_on_hand, 0) qty_on_hand,
           COALESCE(i.unit,'each') unit, COALESCE(i.par_level,0) par_level, i.last_counted_at
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
     ${includeInactive ? '' : 'WHERE p.active = 1'}
     ORDER BY CASE p.category WHEN 'beer' THEN 1 WHEN 'spirit' THEN 2 WHEN 'wine' THEN 3
                              WHEN 'cocktail' THEN 4 ELSE 5 END,
              p.sort_order, p.name`).all();
}

function saveProduct(p) {
  const sd = (p.standard_drinks === '' || p.standard_drinks == null)
    ? standardDrinks(p.serving_oz, p.abv)
    : Number(p.standard_drinks);
  const args = [
    p.category, p.brand || null, p.name,
    p.abv === '' || p.abv == null ? null : Number(p.abv),
    p.serving_oz === '' || p.serving_oz == null ? null : Number(p.serving_oz),
    Math.round(Number(p.price_cents) || 0), sd,
    p.sku || null, p.active ? 1 : 0, Number(p.sort_order) || 0,
  ];

  if (p.id) {
    db.prepare(`UPDATE products SET category=?, brand=?, name=?, abv=?, serving_oz=?,
                price_cents=?, standard_drinks=?, sku=?, active=?, sort_order=? WHERE id=?`)
      .run(...args, p.id);
    audit('product_updated', `${p.id} ${p.name}`, 'bartender');
    return p.id;
  }

  const r = db.prepare(`INSERT INTO products
      (category, brand, name, abv, serving_oz, price_cents, standard_drinks, sku, active, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...args);
  db.prepare(`INSERT INTO inventory (product_id, qty_on_hand, unit, par_level)
              VALUES (?,?,?,?)`)
    .run(r.lastInsertRowid, Number(p.qty_on_hand) || 0, p.unit || 'each', Number(p.par_level) || 0);
  audit('product_created', `${r.lastInsertRowid} ${p.name}`, 'bartender');
  return r.lastInsertRowid;
}

function archiveProduct(id) {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
  audit('product_archived', String(id), 'bartender');
}

/**
 * Change one item's price. Split out from saveProduct so the inventory grid can
 * edit a price in place without round-tripping the whole record — and so every
 * price change lands in the audit log with its old and new value.
 */
function setProductPrice(id, priceCents, actor) {
  const cents = Math.max(0, Math.round(Number(priceCents) || 0));
  const cur = db.prepare('SELECT name, price_cents FROM products WHERE id = ?').get(id);
  if (!cur) throw new Error('Item not found.');
  if (cur.price_cents === cents) return { id, price_cents: cents, changed: false };

  db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(cents, id);
  audit('price_changed',
    `${cur.name}: ${(cur.price_cents / 100).toFixed(2)} -> ${(cents / 100).toFixed(2)}`, actor);
  return { id, price_cents: cents, changed: true, from: cur.price_cents };
}

/**
 * Re-price a whole category at once — the common case when the club changes
 * what a beer costs. `mode` is 'set' (flat price), 'add' (cents up or down) or
 * 'percent'. Returns what actually changed so the UI can report it.
 */
function bulkSetPrice({ category, mode = 'set', amount, actor }) {
  const rows = category === 'all'
    ? db.prepare('SELECT id, name, price_cents FROM products WHERE active = 1').all()
    : db.prepare('SELECT id, name, price_cents FROM products WHERE active = 1 AND category = ?').all(category);
  if (!rows.length) return { changed: 0, items: [] };

  const value = Number(amount) || 0;
  const nextPrice = (cur) => {
    if (mode === 'add') return Math.max(0, cur + Math.round(value));
    if (mode === 'percent') return Math.max(0, Math.round(cur * (1 + value / 100)));
    return Math.max(0, Math.round(value));
  };

  const upd = db.prepare('UPDATE products SET price_cents = ? WHERE id = ?');
  const items = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const next = nextPrice(r.price_cents);
      if (next === r.price_cents) continue;
      upd.run(next, r.id);
      items.push({ id: r.id, name: r.name, from: r.price_cents, to: next });
    }
    if (items.length) {
      audit('bulk_price_changed',
        `${category} (${mode} ${value}): ${items.length} items re-priced`, actor);
    }
  });
  tx();
  return { changed: items.length, items };
}

/**
 * Set or nudge stock. Pass `newQty` for a recount, or `delta` for a delivery,
 * spill, etc. Every change lands in inventory_adjustments.
 */
function adjustInventory({ productId, newQty, delta, reason, note, actor, orderId }) {
  const row = db.prepare('SELECT * FROM inventory WHERE product_id = ?').get(productId);
  if (!row) {
    db.prepare(`INSERT INTO inventory (product_id, qty_on_hand, unit, par_level) VALUES (?,0,'each',0)`)
      .run(productId);
  }
  const cur = row ? row.qty_on_hand : 0;
  const target = newQty != null ? Number(newQty) : cur + Number(delta || 0);
  const applied = Math.round((target - cur) * 1000) / 1000;
  const isRecount = newQty != null && (reason === 'recount' || !reason);

  db.prepare(`UPDATE inventory SET qty_on_hand = ?, last_counted_at = CASE WHEN ? THEN ? ELSE last_counted_at END
              WHERE product_id = ?`)
    .run(target, isRecount ? 1 : 0, nowIso(), productId);

  db.prepare(`INSERT INTO inventory_adjustments
      (product_id, delta, new_qty, reason, order_id, actor, note, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(productId, applied, target, reason || 'recount', orderId || null,
         actor || null, note || null, nowIso());

  return { productId, qty_on_hand: target, delta: applied };
}

function setInventoryMeta(productId, { unit, par_level }) {
  db.prepare('UPDATE inventory SET unit = COALESCE(?, unit), par_level = COALESCE(?, par_level) WHERE product_id = ?')
    .run(unit || null, par_level == null ? null : Number(par_level), productId);
}

function lowStock() {
  return db.prepare(`
    SELECT p.id, p.name, p.category, i.qty_on_hand, i.par_level, i.unit
      FROM products p JOIN inventory i ON i.product_id = p.id
     WHERE p.active = 1 AND i.par_level > 0 AND i.qty_on_hand <= i.par_level
     ORDER BY (i.qty_on_hand - i.par_level), p.name`).all();
}

function inventoryAdjustments({ limit = 200 } = {}) {
  return db.prepare(`
    SELECT a.*, p.name product_name, p.category
      FROM inventory_adjustments a JOIN products p ON p.id = a.product_id
     ORDER BY a.created_at DESC LIMIT ?`).all(limit);
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

/**
 * Price and drink-count a ticket, and report whether it would cross the limit.
 * Pure read — call this on every ticket change to drive the UI.
 */
function priceTicket({ patronId, items }) {
  const getP = db.prepare('SELECT p.*, COALESCE(i.qty_on_hand,0) qty_on_hand FROM products p LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id = ?');
  const lines = [];
  let cents = 0, drinks = 0;

  for (const it of items || []) {
    const p = getP.get(it.productId);
    if (!p) continue;
    const qty = Math.max(1, Math.round(Number(it.qty) || 1));
    const lineCents = p.price_cents * qty;
    const lineDrinks = Math.round(p.standard_drinks * qty * 100) / 100;
    cents += lineCents;
    drinks += lineDrinks;
    lines.push({
      productId: p.id, name: p.name, category: p.category, qty,
      unitPriceCents: p.price_cents, lineCents,
      standardDrinks: lineDrinks, qtyOnHand: p.qty_on_hand,
      overStock: qty > p.qty_on_hand,
    });
  }
  drinks = Math.round(drinks * 100) / 100;

  const mode = getSetting('limit_mode') || 'block';
  const limits = limitSettings();
  const status = patronId ? patronStatus(patronId) : null;

  // Age and drink-limit rules apply to alcohol only. Someone who has hit their
  // limit — or who is under 21 — can still be sold a Coke, a coffee, or a
  // bottle of water, which is exactly what you want them buying.
  const hasAlcohol = lines.some((l) => l.standardDrinks > 0);

  // What this ticket adds, per limit group.
  const ticketByGroup = zeroGroups();
  let ticketServings = 0;
  for (const l of lines) {
    if (l.standardDrinks <= 0) continue;
    ticketServings += l.qty;
    const g = limitGroup(l.category);
    if (g) ticketByGroup[g] += l.qty;
  }

  const already = status
    ? { total: status.today.servings, ...status.today.byGroup }
    : { total: 0, ...zeroGroups() };
  const projected = { total: already.total + ticketServings };
  for (const g of GROUPS) projected[g] = already[g] + ticketByGroup[g];

  // Every cap this ticket would break. The night total is checked alongside
  // the category caps, so "4 beers" passes while "4 liquors" does not.
  const breaches = [];
  if (patronId && projected.total > limits.total) {
    breaches.push({ group: 'total', label: GROUP_LABELS.total, limit: limits.total, projected: projected.total });
  }
  for (const g of GROUPS) {
    if (patronId && ticketByGroup[g] > 0 && projected[g] > limits[g]) {
      breaches.push({ group: g, label: GROUP_LABELS[g], limit: limits[g], projected: projected[g] });
    }
  }

  const limitMessage = breaches.length
    ? breaches.map((b) => b.group === 'total'
        ? `Night limit is ${b.limit} drinks — this ticket would make ${b.projected}.`
        : `${b.label} limit is ${b.limit} — this ticket would make ${b.projected}.`).join(' ')
    : null;

  return {
    lines,
    subtotalCents: cents,
    standardDrinks: drinks,
    servings: ticketServings,
    byGroup: ticketByGroup,
    hasAlcohol,
    already,
    projected,
    limits,
    breaches,
    limitMessage,
    limitMode: mode,
    overLimit: breaches.length > 0 && mode !== 'track',
    needsOverride: breaches.length > 0 && mode === 'block',
    underage: !!status && status.underage && hasAlcohol,
    banned: !!status && status.banned,
    anyOverStock: lines.some((l) => l.overStock),
  };
}

function createOrder({ patronId, items, paymentMethod, bartender, overrideReason, pin }) {
  const quote = priceTicket({ patronId, items });
  if (!quote.lines.length) throw new Error('Ticket is empty.');

  // Every sale is attached to a scanned card — there is no walk-in path, or a
  // patron could drink past their cap simply by not presenting one.
  if (!patronId) throw new Error('Scan a card first — every sale must be tied to a patron.');

  if (quote.banned && !overrideReason) {
    throw new Error('Patron is flagged as barred. A manager override with a reason is required.');
  }
  if (quote.underage && !overrideReason) {
    throw new Error(`Patron is under ${getSetting('min_age')}. Sale blocked.`);
  }
  if (quote.needsOverride) {
    if (!overrideReason) {
      throw new Error(`${quote.limitMessage} Manager override required.`);
    }
    if (getSetting('require_pin_for_override') === '1' && !verifyPin(pin)) {
      throw new Error('Manager PIN incorrect.');
    }
  }
  if (getSetting('block_sale_when_out_of_stock') === '1' && quote.anyOverStock) {
    const short = quote.lines.filter((l) => l.overStock).map((l) => l.name).join(', ');
    throw new Error(`Not enough stock: ${short}`);
  }

  const shift = openShift(bartender);
  const day = businessDate();
  const ts = nowIso();

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO orders
        (shift_id, patron_id, business_date, created_at, subtotal_cents,
         payment_method, standard_drinks, bartender, override_reason)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      // Card is the only tender here; payment itself is handled on a separate
      // terminal. The column stays so history remains valid and adding another
      // method later is a one-line change.
      .run(shift.id, patronId || null, day, ts, quote.subtotalCents,
           paymentMethod || 'card', quote.standardDrinks, bartender || null,
           overrideReason || null);
    const orderId = r.lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_name, category, qty, unit_price_cents, standard_drinks)
      VALUES (?,?,?,?,?,?,?)`);
    for (const l of quote.lines) {
      insItem.run(orderId, l.productId, l.name, l.category, l.qty, l.unitPriceCents, l.standardDrinks);
      adjustInventory({
        productId: l.productId, delta: -l.qty, reason: 'sale',
        orderId, actor: bartender,
      });
    }
    if (overrideReason) {
      const caps = quote.breaches.map((b) => `${b.label} ${b.projected}/${b.limit}`).join(', ');
      audit('limit_override',
        `order ${orderId} patron ${patronId}${caps ? ` [${caps}]` : ''}: ${overrideReason}`, bartender);
    }
    return orderId;
  });

  const orderId = tx();
  return {
    orderId,
    subtotalCents: quote.subtotalCents,
    standardDrinks: quote.standardDrinks,
    patron: patronId ? patronStatus(patronId) : null,
  };
}

function voidOrder({ orderId, reason, pin, actor }) {
  if (getSetting('require_pin_for_void') === '1' && !verifyPin(pin)) {
    throw new Error('Manager PIN incorrect.');
  }
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new Error('Order not found.');
  if (o.voided) throw new Error('Order is already voided.');

  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET voided = 1, voided_at = ?, void_reason = ? WHERE id = ?')
      .run(nowIso(), reason || null, orderId);
    for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
      if (it.product_id) {
        adjustInventory({
          productId: it.product_id, delta: it.qty, reason: 'void',
          orderId, actor, note: reason,
        });
      }
    }
    audit('order_voided', `order ${orderId}: ${reason || ''}`, actor);
  });
  tx();
  return { orderId, patron: o.patron_id ? patronStatus(o.patron_id) : null };
}

/**
 * Take a single drink back off an order after the fact.
 *
 * Voiding cancels a whole ticket; this is for the case where one drink of
 * several was rung up in error. The stock goes back, the patron's count drops,
 * and the order's totals are recomputed from what is left — so the takings
 * still reconcile. If it was the last item the order is voided outright rather
 * than left as an empty shell.
 */
function removeOrderItem({ orderId, itemId, qty = 1, reason, pin, actor }) {
  if (getSetting('require_pin_for_void') === '1' && !verifyPin(pin)) {
    throw new Error('Manager PIN incorrect.');
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found.');
  if (order.voided) throw new Error('That order is already voided.');

  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
    .get(itemId, orderId);
  if (!item) throw new Error('That drink is not on this order.');

  const take = Math.max(1, Math.min(Math.round(Number(qty) || 1), item.qty));
  const perUnitDrinks = item.qty > 0 ? item.standard_drinks / item.qty : 0;
  const ts = nowIso();

  const tx = db.transaction(() => {
    const left = item.qty - take;
    if (left > 0) {
      db.prepare('UPDATE order_items SET qty = ?, standard_drinks = ? WHERE id = ?')
        .run(left, round2(perUnitDrinks * left), item.id);
    } else {
      db.prepare('DELETE FROM order_items WHERE id = ?').run(item.id);
    }

    if (item.product_id) {
      adjustInventory({
        productId: item.product_id, delta: take, reason: 'void',
        orderId, actor, note: reason || 'drink removed after the fact',
      });
    }

    // Rebuild the order's totals from whatever survives.
    const rest = db.prepare(`
      SELECT COALESCE(SUM(qty * unit_price_cents),0) cents,
             COALESCE(SUM(standard_drinks),0) drinks,
             COUNT(*) n
        FROM order_items WHERE order_id = ?`).get(orderId);

    if (rest.n === 0) {
      db.prepare(`UPDATE orders
           SET subtotal_cents = 0, standard_drinks = 0,
               voided = 1, voided_at = ?, void_reason = ?
         WHERE id = ?`).run(ts, reason || 'all drinks removed', orderId);
    } else {
      db.prepare('UPDATE orders SET subtotal_cents = ?, standard_drinks = ? WHERE id = ?')
        .run(rest.cents, round2(rest.drinks), orderId);
    }

    audit('order_item_removed',
      `${take}× ${item.product_name} off order ${orderId}` +
      `${rest.n === 0 ? ' (order voided — nothing left)' : ''}: ${reason || 'no reason given'}`,
      actor);
  });
  tx();

  return {
    orderId,
    removed: take,
    productName: item.product_name,
    orderVoided: !db.prepare('SELECT COUNT(*) n FROM order_items WHERE order_id = ?').get(orderId).n,
    patron: order.patron_id ? patronStatus(order.patron_id) : null,
  };
}

function recentOrders({ limit = 40, shiftId } = {}) {
  const rows = shiftId
    ? db.prepare('SELECT * FROM orders WHERE shift_id = ? ORDER BY id DESC LIMIT ?').all(shiftId, limit)
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
  const itemsFor = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const patronFor = db.prepare(
    'SELECT id, display_name, dod_id, card_payload, last4 FROM patrons WHERE id = ?');
  for (const o of rows) {
    o.items = itemsFor.all(o.id);
    o.patron_label = o.patron_id ? labelFor(patronFor.get(o.patron_id)) : 'Walk-in';
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

function dayReport(date) {
  const day = date || businessDate();
  const totals = db.prepare(`
    SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) gross_cents,
           COALESCE(SUM(standard_drinks),0) drinks,
           COUNT(DISTINCT patron_id) patrons
      FROM orders WHERE business_date = ? AND voided = 0`).get(day);
  const byCategory = db.prepare(`
    SELECT oi.category, SUM(oi.qty) units, SUM(oi.qty * oi.unit_price_cents) cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date = ? AND o.voided = 0
     GROUP BY oi.category ORDER BY cents DESC`).all(day);
  const topProducts = db.prepare(`
    SELECT oi.product_name, oi.category, SUM(oi.qty) units,
           SUM(oi.qty * oi.unit_price_cents) cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date = ? AND o.voided = 0
     GROUP BY oi.product_name ORDER BY units DESC LIMIT 20`).all(day);
  const heavy = db.prepare(`
    SELECT o.patron_id, COALESCE(p.display_name, p.dod_id, '#' || p.last4, 'Card …' || substr(p.card_payload,-5), 'Patron ' || p.id) label,
           SUM(o.standard_drinks) drinks, SUM(o.subtotal_cents) cents, COUNT(*) orders
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date = ? AND o.voided = 0 AND o.patron_id IS NOT NULL
     GROUP BY o.patron_id ORDER BY drinks DESC LIMIT 25`).all(day);
  const overrides = db.prepare(`
    SELECT o.id, o.created_at, o.override_reason, o.bartender,
           COALESCE(p.display_name, p.dod_id, '#' || p.last4, 'Card …' || substr(p.card_payload,-5), 'Patron ' || p.id) label
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date = ? AND o.override_reason IS NOT NULL
     ORDER BY o.created_at DESC`).all(day);

  return { date: day, totals, byCategory, topProducts, heavyPatrons: heavy, overrides };
}

/* ---- date helpers over 'YYYY-MM-DD' business dates ---- */

function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function dayCount(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function listDates(from, to) {
  const out = [];
  for (let d = from, guard = 0; guard < 4000; guard++) {
    out.push(d);
    if (d === to || d > to) break;
    d = addDays(d, 1);
  }
  return out;
}

function windowTotals(from, to) {
  const r = db.prepare(`
    SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) gross_cents,
           COALESCE(SUM(standard_drinks),0) drinks,
           COUNT(DISTINCT patron_id) patrons
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0`).get(from, to);
  // Drinks actually served — the unit the limits are enforced in.
  const s = db.prepare(`
    SELECT COALESCE(SUM(oi.qty),0) servings
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0
       AND oi.standard_drinks > 0`).get(from, to);
  return {
    orders: r.orders,
    gross_cents: r.gross_cents,
    drinks: round2(r.drinks),
    servings: s.servings,
    patrons: r.patrons,
  };
}

/**
 * The whole sales picture for a date range: headline totals, the same totals for
 * the equal-length window immediately before it (so every figure carries a
 * trend), a per-night series for the chart, and the usual breakdowns.
 */
function salesReport(from, to) {
  const span = dayCount(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -span);

  const totals = windowTotals(from, to);
  const previous = windowTotals(prevFrom, prevTo);

  const rows = db.prepare(`
    SELECT business_date, COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) gross_cents,
           COALESCE(SUM(standard_drinks),0) drinks,
           COUNT(DISTINCT patron_id) patrons
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0
     GROUP BY business_date`).all(from, to);
  const byDate = new Map(rows.map((r) => [r.business_date, r]));

  const servingRows = db.prepare(`
    SELECT o.business_date, COALESCE(SUM(oi.qty),0) servings
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0 AND oi.standard_drinks > 0
     GROUP BY o.business_date`).all(from, to);
  const servingsByDate = new Map(servingRows.map((r) => [r.business_date, r.servings]));

  // Every date in the range, including nights with no sales — a time axis with
  // missing days silently rescales and misleads.
  const series = listDates(from, to).map((date) => {
    const r = byDate.get(date);
    return {
      date,
      orders: r ? r.orders : 0,
      gross_cents: r ? r.gross_cents : 0,
      drinks: r ? round2(r.drinks) : 0,
      servings: servingsByDate.get(date) || 0,
      patrons: r ? r.patrons : 0,
    };
  });

  const byCategory = db.prepare(`
    SELECT oi.category, SUM(oi.qty) units, SUM(oi.qty * oi.unit_price_cents) cents,
           ROUND(SUM(oi.standard_drinks), 2) drinks
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0
     GROUP BY oi.category ORDER BY cents DESC`).all(from, to);

  const byPayment = db.prepare(`
    SELECT payment_method, COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) cents
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0
     GROUP BY payment_method ORDER BY cents DESC`).all(from, to);

  const topProducts = db.prepare(`
    SELECT oi.product_name, oi.category, SUM(oi.qty) units,
           SUM(oi.qty * oi.unit_price_cents) cents
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0
     GROUP BY oi.product_name ORDER BY units DESC LIMIT 20`).all(from, to);

  const heavyPatrons = db.prepare(`
    SELECT COALESCE(p.display_name, p.dod_id, '#' || p.last4, 'Card …' || substr(p.card_payload,-5), 'Patron ' || p.id) label,
           ROUND(SUM(o.standard_drinks), 2) drinks, SUM(o.subtotal_cents) cents,
           COUNT(*) orders, COUNT(DISTINCT o.business_date) nights
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date BETWEEN ? AND ? AND o.voided = 0 AND o.patron_id IS NOT NULL
     GROUP BY o.patron_id ORDER BY drinks DESC LIMIT 25`).all(from, to);

  const overrides = db.prepare(`
    SELECT o.id, o.business_date, o.created_at, o.override_reason, o.bartender,
           COALESCE(p.display_name, p.dod_id, '#' || p.last4, 'Card …' || substr(p.card_payload,-5), 'Patron ' || p.id) label
      FROM orders o LEFT JOIN patrons p ON p.id = o.patron_id
     WHERE o.business_date BETWEEN ? AND ? AND o.override_reason IS NOT NULL
     ORDER BY o.created_at DESC LIMIT 100`).all(from, to);

  const voids = db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents),0) cents
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 1`).get(from, to);

  // Hour-of-night buckets. created_at is stored UTC, so convert in JS rather
  // than with strftime, which would bucket by UTC hour and skew the peak.
  const stamps = db.prepare(`
    SELECT created_at, subtotal_cents, standard_drinks
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0`).all(from, to);
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, cents: 0, drinks: 0 }));
  for (const s of stamps) {
    const h = new Date(s.created_at).getHours();
    if (!Number.isFinite(h)) continue;
    hourly[h].orders += 1;
    hourly[h].cents += s.subtotal_cents;
    hourly[h].drinks += s.standard_drinks;
  }
  for (const h of hourly) h.drinks = Math.round(h.drinks * 100) / 100;

  const active = series.filter((d) => d.orders > 0);
  const busiest = active.slice().sort((a, b) => b.gross_cents - a.gross_cents)[0] || null;

  return {
    from, to, span,
    previousWindow: { from: prevFrom, to: prevTo },
    totals, previous,
    nightsOpen: active.length,
    avgPerNight: {
      gross_cents: active.length ? Math.round(totals.gross_cents / active.length) : 0,
      drinks: active.length ? Math.round((totals.drinks / active.length) * 100) / 100 : 0,
      patrons: active.length ? Math.round((totals.patrons / active.length) * 10) / 10 : 0,
    },
    avgPerPatron: {
      cents: totals.patrons ? Math.round(totals.gross_cents / totals.patrons) : 0,
      drinks: totals.patrons ? Math.round((totals.drinks / totals.patrons) * 100) / 100 : 0,
    },
    busiest,
    series, byCategory, byPayment, topProducts, heavyPatrons, overrides, voids, hourly,
  };
}

function rangeReport(from, to) {
  const rows = db.prepare(`
    SELECT business_date, COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) gross_cents,
           COALESCE(SUM(standard_drinks),0) drinks, COUNT(DISTINCT patron_id) patrons
      FROM orders WHERE business_date BETWEEN ? AND ? AND voided = 0
     GROUP BY business_date ORDER BY business_date`).all(from, to);
  return { from, to, days: rows };
}

module.exports = {
  open, close, handle, getDbPath,
  nowIso, businessDate, standardDrinks, ageOn, audit,
  getSetting, setSetting, allSettings, verifyPin, setPin,
  currentShift, openShift, closeShift, shiftSummary, rollShiftIfStale,
  resolveCard, patronStatus, updatePatron, setBan, listPatrons, patronHistory,
  deletePatron, patronFootprint, findPatrons, createPatron, splitName, composeName,
  drinksToday, countsToday, limitSettings, limitGroup, purgeOldPii, labelFor,
  GROUPS, GROUP_LABELS,
  listProducts, saveProduct, archiveProduct, setProductPrice, bulkSetPrice,
  adjustInventory, setInventoryMeta, lowStock, inventoryAdjustments,
  priceTicket, createOrder, voidOrder, removeOrderItem, recentOrders,
  dayReport, rangeReport, salesReport, addDays, dayCount, listDates,
};
