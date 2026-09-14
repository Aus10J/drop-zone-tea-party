'use strict';

/**
 * Runs before `npm start`, `npm test` and `npm run test:ui`.
 *
 * Two guards, both cheap, both there because the failure they catch is
 * otherwise badly misleading:
 *
 * 1. SYNTAX. Electron does not exit on a load-time throw — it prints the error
 *    and keeps the app alive, so a stray typo in a test file makes `npm test`
 *    hang forever with no output rather than failing. Parsing every file first
 *    turns that into a one-line error.
 *
 * 2. NATIVE MODULE PLATFORM. `npm run dist:win` rebuilds better-sqlite3 for
 *    Windows in place, so running locally afterwards dies deep inside
 *    require() with a bare ERR_DLOPEN_FAILED.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src', 'test', 'scripts'];

function jsFilesIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  const start = path.join(ROOT, dir);
  if (fs.existsSync(start)) walk(start);
  return out;
}

function checkSyntax() {
  const files = SOURCE_DIRS.flatMap(jsFilesIn);
  const bad = [];

  for (const file of files) {
    try {
      // Parses without running. Wrapped the way CommonJS wraps a module so
      // top-level `return` and friends stay legal.
      new vm.Script(
        `(function (exports, require, module, __filename, __dirname) {\n${fs.readFileSync(file, 'utf8')}\n});`,
        { filename: file }
      );
    } catch (err) {
      bad.push({ file: path.relative(ROOT, file), message: err.message });
    }
  }

  if (bad.length) {
    console.error('\n  Syntax errors — fix these before running:\n');
    for (const b of bad) console.error(`    ${b.file}\n      ${b.message}\n`);
    return false;
  }
  return true;
}

const NATIVE = path.join(
  ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
);

const KINDS = [
  { name: 'Windows (PE)', platform: 'win32', test: (b) => b[0] === 0x4d && b[1] === 0x5a },
  { name: 'macOS (Mach-O)', platform: 'darwin', test: (b) => [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(b.readUInt32BE(0)) },
  { name: 'Linux (ELF)', platform: 'linux', test: (b) => b.readUInt32BE(0) === 0x7f454c46 },
];

function checkNative() {
  if (!fs.existsSync(NATIVE)) {
    console.error('\n  The SQLite native module is missing.\n  Fix:  npm install\n');
    return false;
  }

  const head = Buffer.alloc(4);
  const fd = fs.openSync(NATIVE, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);

  const kind = KINDS.find((k) => k.test(head));
  if (kind && kind.platform === process.platform) return true;

  console.error(`
  ─────────────────────────────────────────────────────────────
  The SQLite native module was built for the wrong platform.

    node_modules has:  ${kind ? kind.name : 'an unrecognised binary'}
    you are running:   ${process.platform}

  This happens after 'npm run dist:win' — the Windows build swaps
  the binary in node_modules for the Windows one.

  Fix:
      npm run fix:native
  ─────────────────────────────────────────────────────────────
`);
  return false;
}

process.exit(checkSyntax() && checkNative() ? 0 : 1);
