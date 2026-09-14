'use strict';

/**
 * Generates the app icon — no image library, no binary assets checked in.
 *
 *   node scripts/make-icon.js
 *
 * Writes build/icon.ico (multi-size, for Windows) and build/icon.png (1024px,
 * used by electron-builder for macOS/Linux). Re-run it after changing the
 * colours below and rebuild.
 *
 * A cocktail glass in silver on an Air Force blue field. Solid shapes, not
 * outlines, because an outline disappears at the 16px size Windows uses in the
 * taskbar and Alt-Tab.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;                      // supersampling factor, for smooth edges

// Matches the palette in src/renderer/styles.css
const BG_TOP    = [0x1a, 0x56, 0xc4];   // --af-blue-lift
const BG_BOTTOM = [0x00, 0x1b, 0x52];   // --af-blue-deep
const EDGE      = [0xc3, 0xc9, 0xd0];   // --silver
const GLASS     = [0xe9, 0xed, 0xf2];   // --text (near-white silver)

/* ------------------------------------------------------------------ *
 * Geometry, in 0..1 space so it scales to any size
 * ------------------------------------------------------------------ */

const BOWL = { left: 0.235, right: 0.765, top: 0.295, tipY: 0.575 };
const STEM = { halfWidth: 0.030, top: 0.565, bottom: 0.745 };
const BASE = { left: 0.330, right: 0.670, top: 0.745, bottom: 0.800 };
const CORNER_RADIUS = 0.185;
const EDGE_WIDTH = 0.016;

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Barycentric point-in-triangle. */
function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (d === 0) return false;
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const c = 1 - a - b;
  return a >= 0 && b >= 0 && c >= 0;
}

function insideGlass(x, y) {
  if (insideTriangle(x, y, BOWL.left, BOWL.top, BOWL.right, BOWL.top, 0.5, BOWL.tipY)) return true;
  if (y >= STEM.top && y <= STEM.bottom && Math.abs(x - 0.5) <= STEM.halfWidth) return true;
  if (y >= BASE.top && y <= BASE.bottom && x >= BASE.left && x <= BASE.right) return true;
  return false;
}

const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Render one icon at `size`, supersampled and box-filtered down. */
function render(size) {
  const big = size * SS;
  const acc = new Float64Array(size * size * 4);

  for (let py = 0; py < big; py++) {
    const y = (py + 0.5) / big;
    for (let px = 0; px < big; px++) {
      const x = (px + 0.5) / big;

      let r = 0, g = 0, b = 0, a = 0;

      if (insideRoundedSquare(x, y, CORNER_RADIUS)) {
        const t = y;
        r = lerp(BG_TOP[0], BG_BOTTOM[0], t);
        g = lerp(BG_TOP[1], BG_BOTTOM[1], t);
        b = lerp(BG_TOP[2], BG_BOTTOM[2], t);
        a = 255;

        // Thin silver rim: inside the badge but outside the inset copy of it.
        if (!insideInset(x, y, EDGE_WIDTH)) {
          r = lerp(r, EDGE[0], 0.75);
          g = lerp(g, EDGE[1], 0.75);
          b = lerp(b, EDGE[2], 0.75);
        }

        if (insideGlass(x, y)) { r = GLASS[0]; g = GLASS[1]; b = GLASS[2]; }
      }

      // Accumulate into the downsampled grid.
      const dx = Math.floor(px / SS);
      const dy = Math.floor(py / SS);
      const i = (dy * size + dx) * 4;
      acc[i] += r * (a / 255);
      acc[i + 1] += g * (a / 255);
      acc[i + 2] += b * (a / 255);
      acc[i + 3] += a;
    }
  }

  const samples = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const coverage = acc[i * 4 + 3];             // sum of alpha across samples
    const alpha = coverage / samples;
    // Colour was accumulated premultiplied by alpha; divide it back out so
    // partially covered edge pixels keep their hue instead of darkening.
    const unpremul = coverage > 0 ? 255 / coverage : 0;
    out[i * 4]     = Math.round(Math.min(255, acc[i * 4] * unpremul));
    out[i * 4 + 1] = Math.round(Math.min(255, acc[i * 4 + 1] * unpremul));
    out[i * 4 + 2] = Math.round(Math.min(255, acc[i * 4 + 2] * unpremul));
    out[i * 4 + 3] = Math.round(alpha);
  }
  return out;
}

function insideInset(x, y, inset) {
  const s = 1 - inset * 2;
  if (s <= 0) return false;
  const nx = (x - inset) / s;
  const ny = (y - inset) / s;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;
  return insideRoundedSquare(nx, ny, CORNER_RADIUS);
}

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * ICO container (PNG-compressed entries, supported since Vista)
 * ------------------------------------------------------------------ */

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;   // 0 means 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;                        // palette size
    dir[o + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, o + 4);           // colour planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));
  const ico = buildIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  const big = 1024;
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(render(big), big));

  console.log(`build/icon.ico  ${ICO_SIZES.join(', ')}px  (${(ico.length / 1024).toFixed(1)} KB)`);
  console.log(`build/icon.png  ${big}px`);
}

main();
