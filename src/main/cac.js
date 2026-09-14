'use strict';

/**
 * CAC / ID scan interpretation.
 *
 * DESIGN NOTE — read this before changing anything here.
 *
 * Drink tracking does not require decoding the barcode. Identity comes from an
 * HMAC of the *raw* scanner payload (see db.hmacId): the same card always
 * produces the same hash, so tonight's count follows the patron across
 * rescans, and nothing reversible to a DoD ID is written to disk.
 *
 * Decoding the barcode is therefore a convenience layer only — it pre-fills a
 * name and date of birth so the bartender does not have to type them on a
 * patron's first visit. Two tiers:
 *
 *   Tier 1 (always works): raw payload -> stable card hash. No parsing.
 *   Tier 2 (best effort):  pull name / DOB / DoD ID out of the payload.
 *
 * The DoD PDF417 layout is fixed-width but versioned, and the field offsets
 * differ between card generations. Rather than hardcode offsets that may be
 * wrong for the cards actually in your wallet, Tier 2 works two ways:
 *
 *   a) Heuristics — guess the name/ID by pattern. Good enough to pre-fill a
 *      suggestion that the bartender confirms once.
 *   b) A saved layout map — calibrate exact offsets against a real card in
 *      Settings -> Card Layout, stored in layout.json. Once calibrated,
 *      parsing is exact and the name/DOB fill in with no typing at all.
 *
 * If both fail, the app still works perfectly: the bartender types the name
 * once on first scan and it is remembered forever after.
 */

const fs = require('node:fs');
const path = require('node:path');

// DoD fixed-width numeric fields use this 32-symbol alphabet.
const B32 = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

let layoutPath = null;
let layout = null;

function init(userDataDir) {
  layoutPath = path.join(userDataDir, 'data', 'layout.json');
  loadLayout();
  return layoutPath;
}

function loadLayout() {
  try {
    layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  } catch {
    layout = null;
  }
  return layout;
}

function getLayout() { return layout; }

function saveLayout(next) {
  layout = next && Object.keys(next).length ? next : null;
  if (layout) {
    fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
    fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2), 'utf8');
  } else if (fs.existsSync(layoutPath)) {
    fs.unlinkSync(layoutPath);
  }
  return layout;
}

/* ------------------------------------------------------------------ *
 * Decoders
 * ------------------------------------------------------------------ */

function base32ToInt(s) {
  let n = 0;
  for (const ch of String(s).toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    n = n * 32 + v;
  }
  return n;
}

/** Julian Day Number -> ISO date. The DoD spec encodes dates as JDN. */
function jdnToIso(jdn) {
  if (!Number.isFinite(jdn) || jdn < 1721000 || jdn > 2600000) return null; // ~year 1 to ~2900
  let a = jdn + 32044;
  let b = Math.floor((4 * a + 3) / 146097);
  let c = a - Math.floor((146097 * b) / 4);
  let d = Math.floor((4 * c + 3) / 1461);
  let e = c - Math.floor((1461 * d) / 4);
  let m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}`;
}

function isoFromYyyymmdd(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

function plausibleDob(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  return year >= nowYear - 100 && year <= nowYear - 10 ? iso : null;
}

/** Decode one slice of the payload according to a layout field spec. */
function decodeField(raw, spec) {
  if (!spec || spec.start == null || !spec.len) return null;
  const slice = raw.slice(spec.start, spec.start + spec.len);
  if (!slice) return null;

  switch (spec.encoding) {
    case 'ascii':
      return slice.replace(/[^A-Za-z0-9 .'\-]/g, '').trim() || null;
    case 'int':
      return /^\d+$/.test(slice.trim()) ? slice.trim() : null;
    case 'base32-int': {
      const n = base32ToInt(slice);
      return n == null ? null : String(n);
    }
    case 'base32-jdn':
      return plausibleDob(jdnToIso(base32ToInt(slice)));
    case 'yyyymmdd':
      return plausibleDob(isoFromYyyymmdd(slice.trim()));
    default:
      return slice.trim() || null;
  }
}

/**
 * Return every decoding of a slice, so the layout editor can show the operator
 * which encoding produces something sensible.
 */
function previewSlice(raw, start, len) {
  const slice = raw.slice(start, start + len);
  return {
    slice,
    ascii: decodeField(raw, { start, len, encoding: 'ascii' }),
    int: decodeField(raw, { start, len, encoding: 'int' }),
    base32Int: decodeField(raw, { start, len, encoding: 'base32-int' }),
    base32Jdn: decodeField(raw, { start, len, encoding: 'base32-jdn' }),
    yyyymmdd: decodeField(raw, { start, len, encoding: 'yyyymmdd' }),
  };
}

/* ------------------------------------------------------------------ *
 * Heuristics (used when no layout has been calibrated)
 * ------------------------------------------------------------------ */

/**
 * CAC PDF417 name fields are plain ASCII uppercase, space-padded, and sit in a
 * contiguous block. Base32 numeric fields only ever use A-V, so a run
 * containing W, X, Y or Z is almost certainly text. We take the longest
 * letter/space run and treat it as LAST FIRST MIDDLE.
 */
function guessName(raw) {
  const runs = raw.match(/[A-Z][A-Z .'\-]{4,}/g) || [];
  if (!runs.length) return null;

  // Fixed-width fields are space-padded, so a run of two or more spaces is a
  // field boundary — without this the name bleeds into whatever follows it.
  const candidates = [];
  for (const run of runs) {
    for (const piece of run.split(/\s{2,}/)) {
      const t = piece.trim();
      if (t.length >= 4) candidates.push(t);
    }
  }
  if (!candidates.length) return null;

  const scored = candidates.map((t) => {
    let score = t.length;
    if (/[WXYZ]/.test(t)) score += 25;          // impossible in base32
    if (/\s/.test(t)) score += 15;              // multi-part name
    if (/^[A-Z]+ [A-Z]/.test(t)) score += 10;
    return { text: t, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score < 20) return null;

  // Payload order is LAST FIRST MIDDLE; show it the way a bartender reads it.
  const parts = best.text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[0];
    const rest = parts.slice(1).join(' ');
    return { raw: best.text, formatted: `${rest} ${last}`, confidence: best.score >= 40 ? 'medium' : 'low' };
  }
  return { raw: best.text, formatted: best.text, confidence: 'low' };
}

/** A bare 10-digit run is an EDIPI (front Code 39 barcode, or manual entry). */
function guessEdipi(raw) {
  const exact = raw.match(/(?<!\d)(\d{10})(?!\d)/);
  if (exact) return exact[1];
  return null;
}

function guessDob(raw) {
  // Look for an embedded YYYYMMDD with a plausible birth year.
  const nowYear = new Date().getUTCFullYear();
  for (const m of raw.matchAll(/(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const iso = plausibleDob(`${m[1]}-${m[2]}-${m[3]}`);
    if (iso && +m[1] <= nowYear - 10) return iso;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

function normalize(input) {
  return String(input == null ? '' : input)
    .replace(/\u0000/g, '')        // stray NULs from some scanner firmware
    .replace(/^\s+/, '')           // leading whitespace shifts every offset
    .replace(/[\r\n\t ]+$/, ''); // the terminator the scanner appends
}

function classify(raw) {
  if (/^\d{9,10}$/.test(raw.trim())) return 'edipi';
  // Check the self-describing format before falling back on length alone.
  if (raw.startsWith('@') || /ANSI\s?\d{6}/.test(raw)) return 'aamva'; // a driver's licence
  if (raw.length >= 40 && raw.length <= 250) return 'cac-pdf417';
  return 'unknown';
}

/**
 * Parse a scanner payload.
 * Always returns a usable object — `raw` is what identity is keyed on.
 */
function parseScan(input) {
  const raw = normalize(input);
  const kind = classify(raw);

  const out = {
    raw,
    kind,
    length: raw.length,
    edipi: null,
    last4: null,
    name: null,
    nameConfidence: null,
    dob: null,
    branch: null,
    rank: null,
    version: raw.length > 1 ? raw[0] : null,
    parsedBy: 'none',
  };

  if (!raw) return out;

  if (kind === 'edipi') {
    out.edipi = raw.padStart(10, '0');
    out.last4 = out.edipi.slice(-4);
    out.parsedBy = 'edipi';
    return out;
  }

  if (kind === 'aamva') {
    // AAMVA driver's licenses are self-describing; handy for guests/dependents.
    const dac = raw.match(/DAC([^\n\r]{1,40})/);
    const dcs = raw.match(/DCS([^\n\r]{1,40})/);
    const dbb = raw.match(/DBB(\d{8})/);
    if (dcs || dac) {
      out.name = [dac && dac[1].trim(), dcs && dcs[1].trim()].filter(Boolean).join(' ');
      out.nameConfidence = 'high';
    }
    if (dbb) out.dob = plausibleDob(isoFromYyyymmdd(dbb[1]));
    out.parsedBy = 'aamva';
    return out;
  }

  // A calibrated layout wins over heuristics.
  if (layout && layout.fields) {
    const f = layout.fields;
    const edipi = f.edipi ? decodeField(raw, f.edipi) : null;
    const name = f.name ? decodeField(raw, f.name) : null;
    const dob = f.dob ? decodeField(raw, f.dob) : null;
    if (edipi) {
      out.edipi = String(edipi).padStart(10, '0').slice(-10);
      out.last4 = out.edipi.slice(-4);
    }
    if (name) {
      const parts = String(name).split(/\s+/).filter(Boolean);
      out.name = parts.length >= 2 ? `${parts.slice(1).join(' ')} ${parts[0]}` : name;
      out.nameConfidence = 'high';
    }
    if (dob) out.dob = dob;
    if (edipi || name || dob) {
      out.parsedBy = 'layout';
      return out;
    }
  }

  // Fall back to pattern guessing.
  const g = guessName(raw);
  if (g) { out.name = g.formatted; out.nameConfidence = g.confidence; }
  const e = guessEdipi(raw);
  if (e) { out.edipi = e; out.last4 = e.slice(-4); }
  out.dob = guessDob(raw);
  out.parsedBy = (g || e || out.dob) ? 'heuristic' : 'none';
  return out;
}

/**
 * Work out where a known DoD ID is hiding inside a scanned payload.
 *
 * The barcode does not carry the ID as readable text — it is packed into
 * fixed-width fields, which is why a raw scan looks like nonsense. Rather than
 * making somebody count character offsets by hand, this takes one card and its
 * owner's ID and searches for any slice that decodes to it.
 *
 * Returns every candidate, best first. A match found at the same offset in two
 * different cards is certain; a single card can occasionally throw up a
 * coincidence, which is why the caller is encouraged to confirm with a second.
 */
function deduceIdLayout(rawInput, knownId) {
  const raw = normalize(rawInput);
  const target = String(knownId || '').replace(/\D/g, '');
  if (!raw || !target) return [];

  const found = [];

  // Plainest case: the digits are simply sitting there.
  for (let i = raw.indexOf(target); i >= 0; i = raw.indexOf(target, i + 1)) {
    found.push({ start: i, len: target.length, encoding: 'int', confidence: 'exact' });
  }

  // Otherwise it is base32-packed. Ten digits fit in 5-8 symbols; scan wider
  // than that to be safe, since field widths vary by card generation.
  const wanted = Number(target);
  if (Number.isSafeInteger(wanted)) {
    for (let len = 4; len <= 10; len++) {
      for (let start = 0; start + len <= raw.length; start++) {
        const slice = raw.slice(start, start + len);
        if (base32ToInt(slice) !== wanted) continue;
        found.push({
          start, len, encoding: 'base32-int',
          // A slice with no leading zero symbol is the natural encoding;
          // padded variants are the same number and rank lower.
          confidence: slice[0] === '0' ? 'padded' : 'exact',
        });
      }
    }
  }

  const rank = { exact: 0, padded: 1 };
  return found.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (a.len - b.len));
}

module.exports = {
  init, loadLayout, getLayout, saveLayout,
  parseScan, normalize, classify, previewSlice,
  base32ToInt, jdnToIso, deduceIdLayout,
};
