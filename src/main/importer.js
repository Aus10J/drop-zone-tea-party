'use strict';

/**
 * Import a menu / inventory list from an Excel (.xlsx) or CSV file.
 *
 * Expected columns (matched by header name, not position, so column order and
 * extra columns are fine): ITEM, Category, ABV, Serving, STD Drinks, PRICE.
 * Only ITEM and PRICE really matter; STD Drinks is ignored because every drink
 * is forced to count as one, and ABV/Serving are kept for reference only.
 *
 * The work is split so it can be previewed before anything changes:
 *   readMatrix(path)      -> rows of raw cell values
 *   normalizeRows(matrix) -> tidy { name, category, priceCents, ... } items
 *   planImport(items)     -> what would be added / updated / archived
 *   applyImport(items)    -> do it, in one transaction
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const MAX_ROWS = 5000;

/* ------------------------------------------------------------------ *
 * Reading the file
 * ------------------------------------------------------------------ */

/** exceljs cells can be strings, numbers, or objects (rich text, formulas). */
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.hyperlink != null) return String(v.hyperlink);
    return '';
  }
  return String(v);
}

/** A number from a cell that may be a real number or a formatted string. */
function cellNumber(v) {
  if (typeof v === 'number') return v;
  const t = cellText(v).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Minimal RFC-4180-ish CSV parser: quotes, escaped quotes, embedded commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');       // strip a BOM if Excel wrote one
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

/** Read any supported file into an array of rows (arrays of raw cell values). */
async function readMatrix(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv' || ext === '.txt') {
    return parseCsv(fs.readFileSync(filePath, 'utf8')).slice(0, MAX_ROWS + 5);
  }

  if (ext === '.xlsx' || ext === '.xlsm') {
    // Required lazily so a machine that never imports never loads it.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const out = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      // r.values is 1-based with a leading hole; drop index 0.
      const vals = Array.isArray(r.values) ? r.values.slice(1) : [];
      out.push(vals);
      return out.length < MAX_ROWS + 5;
    });
    return out;
  }

  throw new Error(`Unsupported file type "${ext}". Use .xlsx or .csv.`);
}

/* ------------------------------------------------------------------ *
 * Turning rows into tidy items
 * ------------------------------------------------------------------ */

const HEADER_ALIASES = {
  item: 'name', name: 'name', beverage: 'name', product: 'name',
  category: 'category', type: 'category',
  abv: 'abv',
  serving: 'serving', size: 'serving', pour: 'serving',
  price: 'price', cost: 'price',
  // std drinks is read but ignored — every drink counts as one.
  'std drinks': 'std', std: 'std', 'standard drinks': 'std', drinks: 'std',
};

const CATEGORY_MAP = {
  BEER: 'beer', LAGER: 'beer', ALE: 'beer', CIDER: 'beer', DRAFT: 'beer', DRAUGHT: 'beer',
  SPIRIT: 'spirit', SPIRITS: 'spirit', LIQUOR: 'spirit', LIQUEUR: 'spirit', WHISKEY: 'spirit',
  WHISKY: 'spirit', VODKA: 'spirit', GIN: 'spirit', RUM: 'spirit', TEQUILA: 'spirit', COGNAC: 'spirit',
  WINE: 'wine', RED: 'wine', WHITE: 'wine', ROSE: 'wine', CHAMPAGNE: 'wine', PROSECCO: 'wine',
  COCKTAIL: 'cocktail', COCKTAILS: 'cocktail', MIXED: 'cocktail',
};

const VALID_CATEGORIES = new Set(['beer', 'spirit', 'wine', 'cocktail', 'other']);

/** Map a category cell, falling back to the first word of the item name. */
function mapCategory(rawCat, name) {
  const c = String(rawCat || '').trim().toUpperCase();
  if (CATEGORY_MAP[c]) return { category: CATEGORY_MAP[c], guessed: false };
  if (VALID_CATEGORIES.has(c.toLowerCase())) return { category: c.toLowerCase(), guessed: false };

  const firstWord = String(name || '').trim().split(/\s+/)[0].toUpperCase();
  if (CATEGORY_MAP[firstWord]) return { category: CATEGORY_MAP[firstWord], guessed: true };

  return { category: 'other', guessed: true };
}

function priceToCents(cell) {
  const n = cellNumber(cell);
  if (n == null) return null;
  return Math.max(0, Math.round(n * 100));
}

/** Find the header row (the first row that names an ITEM/name column). */
function findHeader(matrix) {
  for (let i = 0; i < Math.min(matrix.length, 10); i++) {
    const cells = matrix[i].map((c) => cellText(c).trim().toLowerCase());
    if (cells.some((c) => c === 'item' || c === 'beverage' || c === 'name')) {
      return { index: i, cells };
    }
  }
  return null;
}

/**
 * Normalize a raw matrix into items plus warnings. Never throws on a bad row;
 * it collects problems so the preview can show them.
 */
function normalizeRows(matrix) {
  const header = findHeader(matrix);
  if (!header) {
    return { items: [], warnings: ['No header row found. The first row must include an ITEM column and a PRICE column.'] };
  }

  const colOf = {};
  header.cells.forEach((h, i) => {
    const field = HEADER_ALIASES[h];
    if (field && colOf[field] === undefined) colOf[field] = i;
  });

  const warnings = [];
  if (colOf.name === undefined) warnings.push('No ITEM column — nothing to import.');
  if (colOf.price === undefined) warnings.push('No PRICE column — prices will default to $0.00.');

  const items = [];
  const seen = new Set();
  for (let i = header.index + 1; i < matrix.length; i++) {
    const rowArr = matrix[i];
    const name = cellText(rowArr[colOf.name]).trim().replace(/\s+/g, ' ');
    if (!name) continue;                        // blank line

    const key = name.toUpperCase();
    if (seen.has(key)) {
      warnings.push(`Duplicate item "${name}" — only the first was used.`);
      continue;
    }
    seen.add(key);

    const { category, guessed } = mapCategory(
      colOf.category !== undefined ? rowArr[colOf.category] : '', name);
    if (guessed) {
      warnings.push(`"${name}" — category not recognised, filed under ${category.toUpperCase()}.`);
    }

    const priceCents = colOf.price !== undefined ? priceToCents(rowArr[colOf.price]) : 0;
    if (colOf.price !== undefined && priceCents === null) {
      warnings.push(`"${name}" — price could not be read, set to $0.00.`);
    }

    items.push({
      name,
      key,
      category,
      abv: colOf.abv !== undefined ? cellNumber(rowArr[colOf.abv]) : null,
      serving: colOf.serving !== undefined ? cellText(rowArr[colOf.serving]).trim() : '',
      servingOz: colOf.serving !== undefined ? cellNumber(rowArr[colOf.serving]) : null,
      priceCents: priceCents == null ? 0 : priceCents,
    });
  }

  if (!items.length && !warnings.length) warnings.push('No rows to import.');
  return { items, warnings };
}

/* ------------------------------------------------------------------ *
 * Planning and applying
 * ------------------------------------------------------------------ */

const normKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

/** Compare the parsed items against the current menu. Read-only. */
function planImport(items, { replace = false } = {}) {
  const existing = db.listProducts({ includeInactive: true });
  const byName = new Map(existing.map((p) => [normKey(p.name), p]));
  const importKeys = new Set(items.map((it) => it.key));

  const add = [];
  const update = [];
  for (const it of items) {
    const match = byName.get(it.key);
    if (!match) { add.push(it); continue; }
    const changes = [];
    if (match.price_cents !== it.priceCents) changes.push(`price ${(match.price_cents / 100).toFixed(2)}→${(it.priceCents / 100).toFixed(2)}`);
    if (match.category !== it.category) changes.push(`category ${match.category}→${it.category}`);
    if (!match.active) changes.push('re-activate');
    update.push({ ...it, id: match.id, changes });
  }

  const archive = replace
    ? existing.filter((p) => p.active && !importKeys.has(normKey(p.name)))
    : [];

  return {
    add, update, archive,
    counts: { add: add.length, update: update.length, archive: archive.length, total: items.length },
  };
}

/** Apply the import in a single transaction. Returns the counts actually done. */
function applyImport(items, { replace = false, actor = null } = {}) {
  const plan = planImport(items, { replace });
  const h = db.handle();

  const tx = h.transaction(() => {
    for (const it of plan.add) {
      db.saveProduct({
        category: it.category, name: it.name, brand: '',
        abv: it.abv == null ? '' : it.abv,
        serving_oz: it.servingOz == null ? '' : it.servingOz,
        price_cents: it.priceCents, sku: '', active: 1, sort_order: 0,
        qty_on_hand: 0, unit: 'each', par_level: 0,
      });
    }
    for (const it of plan.update) {
      const cur = h.prepare('SELECT * FROM products WHERE id = ?').get(it.id);
      db.saveProduct({
        id: it.id, category: it.category, name: it.name, brand: cur.brand || '',
        abv: it.abv == null ? '' : it.abv,
        serving_oz: it.servingOz == null ? '' : it.servingOz,
        price_cents: it.priceCents, sku: cur.sku || '', active: 1,
        sort_order: cur.sort_order || 0,
      });
    }
    for (const p of plan.archive) {
      db.archiveProduct(p.id);
    }
  });
  tx();

  db.audit('inventory_imported',
    `${plan.counts.add} added, ${plan.counts.update} updated, ${plan.counts.archive} archived`
    + (replace ? ' (replace mode)' : ''), actor);

  return plan.counts;
}

module.exports = {
  readMatrix, parseCsv, normalizeRows, planImport, applyImport,
  mapCategory, priceToCents, cellText, cellNumber,
};
