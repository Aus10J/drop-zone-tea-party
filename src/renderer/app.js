'use strict';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
const centsFromDollars = (s) => Math.round((parseFloat(s) || 0) * 100);
const num = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  // A bare YYYY-MM-DD is parsed as UTC midnight, which renders as the *previous*
  // day in any timezone west of Greenwich. Business dates are local calendar
  // days, so pin them to local noon before formatting.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso)
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function todayLocalDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(message, kind = 'ok', ms = 2600) {
  const t = el('div', { class: `toast ${kind}`, text: message });
  $('#toastRoot').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Unwrap the {ok,data|error} envelope from the main process. */
async function req(fn, payload) {
  const res = await fn(payload);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Unexpected failure');
  return res.data;
}

/** Same, but surface the error as a toast and return null. */
async function tryReq(fn, payload) {
  try {
    return await req(fn, payload);
  } catch (err) {
    toast(err.message, 'err', 4200);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

let modalOpen = false;
let modalEscHandler = null;

function closeModal() {
  $('#modalRoot').classList.add('hidden');
  $('#modalBody').replaceChildren();
  $('#modalActions').replaceChildren();
  modalOpen = false;
  if (modalEscHandler) { document.removeEventListener('keydown', modalEscHandler, true); modalEscHandler = null; }
}

/**
 * actions: [{ label, cls, onClick(close), keepOpen }]
 * Returns nothing; use the callbacks.
 */
function openModal({ title, body, actions = [], onOpen, dismissable = true }) {
  $('#modalTitle').textContent = title;
  const bodyRoot = $('#modalBody');
  bodyRoot.replaceChildren();
  for (const b of [].concat(body || [])) {
    if (b == null) continue;
    bodyRoot.appendChild(typeof b === 'string' ? el('p', { text: b }) : b);
  }

  const actRoot = $('#modalActions');
  actRoot.replaceChildren();
  for (const a of actions) {
    actRoot.appendChild(el('button', {
      class: `btn ${a.cls || 'ghost'}`,
      text: a.label,
      onclick: () => a.onClick ? a.onClick(closeModal) : closeModal(),
    }));
  }

  $('#modalRoot').classList.remove('hidden');
  modalOpen = true;

  modalEscHandler = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); closeModal(); }
  };
  document.addEventListener('keydown', modalEscHandler, true);

  if (onOpen) onOpen();
}

/** Manager PIN (and optional reason) prompt. Resolves null on cancel. */
function askManager({ title, message, needReason = false, reasonLabel = 'Reason', needPin = true, confirmLabel = 'Confirm', confirmCls = 'primary' }) {
  return new Promise((resolve) => {
    const pinInput = el('input', {
      class: 'input big-pin mono', type: 'password', inputmode: 'numeric',
      placeholder: '••••', autocomplete: 'off',
    });
    const reasonInput = el('input', {
      class: 'input', type: 'text', placeholder: 'e.g. designated driver, food served, manager on scene',
    });

    const form = el('div', { class: 'form' }, [
      needReason ? el('label', { class: 'lbl' }, [reasonLabel, reasonInput]) : null,
      needPin ? el('label', { class: 'lbl' }, ['Manager PIN', pinInput]) : null,
    ]);

    const submit = (close) => {
      if (needReason && !reasonInput.value.trim()) { toast('A reason is required.', 'warn'); reasonInput.focus(); return; }
      if (needPin && !pinInput.value) { toast('Enter the manager PIN.', 'warn'); pinInput.focus(); return; }
      close();
      resolve({ pin: pinInput.value, reason: reasonInput.value.trim() });
    };

    openModal({
      title,
      body: [message, form],
      actions: [
        { label: 'Cancel', cls: 'ghost', onClick: (close) => { close(); resolve(null); } },
        { label: confirmLabel, cls: confirmCls, onClick: submit },
      ],
      onOpen: () => {
        const first = needReason ? reasonInput : pinInput;
        if (first) first.focus();
        for (const inp of [reasonInput, pinInput]) {
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(closeModal); });
        }
      },
    });
  });
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

// Labels cover 'na' so retired rows still read properly in the archived view;
// CATEGORY_ORDER is the selectable set, and no longer offers it.
const CATEGORY_LABELS = {
  beer: 'Beer', spirit: 'Spirits', wine: 'Wine',
  cocktail: 'Cocktails', na: 'Non-alcoholic (retired)', other: 'Other',
};
const CATEGORY_ORDER = ['beer', 'spirit', 'wine', 'cocktail', 'other'];

// Mirrors LIMIT_GROUPS in the main process — cocktails count against liquor.
const GROUP_LABELS = { total: 'Night', beer: 'Beer', wine: 'Wine', liquor: 'Liquor' };

const state = {
  settings: {},
  dbPath: '',
  version: '',
  businessDate: '',
  shift: null,
  products: [],
  lowStock: [],
  layoutCalibrated: false,

  view: 'bar',
  adminUnlocked: false,
  patron: null,       // patronStatus payload
  scanInfo: null,
  ticket: [],         // [{ productId, qty }]
  quote: null,
  category: 'beer',
  payment: 'card',        // card is the only tender; payment runs on a separate terminal
  recent: [],
  report: null,
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  let data;
  try {
    data = await req(window.api.bootstrap);
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font:15px system-ui;color:#e9edf2">
      <h2>Could not start</h2><p>${err.message}</p></div>`;
    return;
  }

  state.settings = data.settings;
  state.dbPath = data.dbPath;
  state.version = data.version;
  state.businessDate = data.businessDate;
  state.shift = data.shift;
  state.products = data.products;
  state.lowStock = data.lowStock;
  state.layoutCalibrated = data.layoutCalibrated;

  const cats = availableCategories();
  state.category = cats.includes('beer') ? 'beer' : (cats[0] || 'beer');

  wireChrome();
  wireBar();
  wireInventory();
  wirePatrons();
  wireReports();
  wireAdmin();
  installScanCapture();

  renderChrome();
  renderCategories();
  renderProducts();
  renderPatronPanel();
  await refreshRecent();
  focusLookup();

  if (data.pinIsDefault) {
    $('#pinDefaultWarn').classList.remove('hidden');
    toast('Manager PIN is still the default 1234 — change it in Settings.', 'warn', 6000);
  }

  window.api.onNav((view) => setView(view === 'export' ? 'reports' : view));
  window.api.onBusinessDate(onBusinessDayRollover);
}

/**
 * The clock crossed the rollover hour while the app was open. Counts in the
 * database have already reset — this pulls the window back in line with them
 * so nobody is looking at yesterday's numbers.
 */
async function onBusinessDayRollover({ businessDate, previous }) {
  state.businessDate = businessDate;

  const data = await tryReq(window.api.bootstrap);
  if (data) {
    state.settings = data.settings;
    state.shift = data.shift;
    state.products = data.products;
    state.lowStock = data.lowStock;
  }

  if (state.patron) {
    state.patron = await tryReq(window.api.patron.status, { id: state.patron.patron.id })
      || state.patron;
  }

  renderChrome();
  renderCategories();
  renderProducts();
  renderPatronPanel();
  await repriceTicket();
  await refreshRecent();

  if (state.view === 'reports') applyQuickRange('today');

  toast(`New business day (${fmtDate(businessDate)}) — every patron's drink count has reset.`,
    'ok', 7000);
  if (previous) {
    toast(`The ${fmtDate(previous)} shift was closed out automatically.`, 'warn', 7000);
  }
}

/* ------------------------------------------------------------------ *
 * Chrome: nav, topbar, shift
 * ------------------------------------------------------------------ */

function wireChrome() {
  for (const b of $$('.navbtn')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  $('#shiftBtn').addEventListener('click', onShiftButton);
  $('#lowStockPill').addEventListener('click', () => {
    setView('inventory');
    $('#invSearch').value = '';
    renderInventory();
  });
}

function setView(view) {
  if (!view || !$(`#view-${view}`)) return;
  state.view = view;
  for (const v of $$('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  for (const b of $$('.navbtn')) b.classList.toggle('active', b.dataset.view === view);

  if (view === 'inventory') { renderInventory(); renderAdjustments(); }
  if (view === 'patrons') renderPatronTable();
  if (view === 'reports') { loadReport(); loadReportNames(); }
  if (view === 'admin') renderAdmin();
}

function renderChrome() {
  $('#venueName').textContent = state.settings.venue_name || 'Drop Zone Tea Party';
  const limit = num(state.settings.drink_limit, 3);
  const bartender = state.settings.bartender_name;
  $('#topMeta').textContent =
    `${fmtDate(state.businessDate)}  ·  limit ${limit}/night${bartender ? `  ·  ${bartender}` : ''}`;

  const pill = $('#shiftPill');
  if (state.shift) {
    pill.className = 'pill live';
    pill.textContent = `Shift open ${fmtTime(state.shift.opened_at)}`;
    $('#shiftBtn').textContent = 'Close Shift';
  } else {
    pill.className = 'pill';
    pill.textContent = 'No shift open';
    $('#shiftBtn').textContent = 'Open Shift';
  }

  const low = $('#lowStockPill');
  if (state.lowStock && state.lowStock.length) {
    low.classList.remove('hidden');
    low.textContent = `${state.lowStock.length} low on stock`;
  } else {
    low.classList.add('hidden');
  }
}

async function onShiftButton() {
  if (!state.shift) {
    const input = el('input', { class: 'input', type: 'text', value: state.settings.bartender_name || '' });
    openModal({
      title: 'Open Shift',
      body: [
        `Business date ${fmtDate(state.businessDate)}. Drink limit ${num(state.settings.drink_limit, 3)} per patron.`,
        el('div', { class: 'form' }, [el('label', { class: 'lbl' }, ['Bartender on duty', input])]),
      ],
      actions: [
        { label: 'Cancel', cls: 'ghost' },
        {
          label: 'Open Shift', cls: 'primary',
          onClick: async (close) => {
            const name = input.value.trim();
            const shift = await tryReq(window.api.shift.open, { openedBy: name });
            if (!shift) return;
            state.shift = shift;
            if (name && name !== state.settings.bartender_name) {
              state.settings = await tryReq(window.api.settings.save, { patch: { bartender_name: name } }) || state.settings;
            }
            close();
            renderChrome();
            toast('Shift open. Good luck out there.', 'ok');
          },
        },
      ],
      onOpen: () => input.focus(),
    });
    return;
  }

  const got = await askManager({
    title: 'Close Shift',
    message: 'Closing the shift stops the current till and prints the night summary. Sales after this open a new shift.',
    needReason: false,
    needPin: state.settings.require_pin_for_void === '1',
    confirmLabel: 'Close Shift',
  });
  if (!got) return;

  const summary = await tryReq(window.api.shift.close, { closedBy: state.settings.bartender_name, pin: got.pin });
  if (!summary) return;
  state.shift = null;
  renderChrome();
  showShiftSummary(summary);

  // Say plainly whether the night made it off the machine.
  const b = summary.backup;
  if (b && b.filePath) toast(`Night backed up to ${b.filePath}`, 'ok', 5000);
  else if (b && b.skipped && b.skipped !== 'already-today') {
    toast(`Not backed up — ${backupSkipReason(b.skipped, b.error)}`, 'warn', 7000);
  }
}

function showShiftSummary(s) {
  const date = s.shift.business_date;
  const rows = [
    ['Orders', s.totals.orders],
    ['Gross sales', money(s.totals.gross_cents)],
    ['Drinks served', s.totals.servings],
    ['Standard drinks', round2(s.totals.drinks)],
    ['Patrons served', s.patronCount],
    ['Limit overrides', s.overrideCount],
    ['Voids', `${s.voids.n} (${money(s.voids.cents)})`],
  ];
  openModal({
    title: `Shift Summary — ${fmtDate(s.shift.business_date)}`,
    body: [
      el('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])),
      s.byCategory.length ? el('h4', { text: 'By category' }) : null,
      s.byCategory.length ? el('dl', { class: 'kv' }, s.byCategory.flatMap((c) => [
        el('dt', { text: CATEGORY_LABELS[c.category] || c.category }),
        el('dd', { text: `${c.units} units · ${money(c.cents)}` }),
      ])) : null,
      el('p', { class: 'hint', text:
        'Take the night\'s records with you before you close up — the database export '
        + 'is the complete copy, the PDF is the one to hand over.' }),
    ],
    actions: [
      // Both export straight from here, scoped to the night just closed, and
      // leave the summary open so you can take the other one too.
      {
        label: 'Export CSV + Database', cls: 'ghost',
        onClick: async () => {
          const res = await tryReq(window.api.exporter.bundle, { from: date, to: date });
          if (res && !res.canceled) toast(`Exported to ${res.dirPath}`, 'ok', 5000);
        },
      },
      {
        label: 'PDF Report', cls: 'ghost',
        onClick: async () => {
          const res = await tryReq(window.api.report.pdf, { from: date, to: date, open: true });
          if (res && !res.canceled) toast('Report generated.', 'ok');
        },
      },
      { label: 'Done', cls: 'primary' },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Scanner capture
 * ------------------------------------------------------------------ */

/**
 * A barcode scanner is a keyboard that types very fast and presses Enter.
 * We buffer keystrokes globally; a fast run of 6+ characters terminated by
 * Enter, while no text field has focus, is treated as a card scan.
 */
function installScanCapture() {
  let buf = '';
  let last = 0;

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
      || t.tagName === 'SELECT' || t.isContentEditable);

    const now = performance.now();
    if (now - last > 400) buf = '';
    last = now;

    if (e.key === 'Enter') {
      const captured = buf;
      buf = '';
      if (!typing && !modalOpen && captured.length >= 6) {
        e.preventDefault();
        handleScan(captured);
      }
      return;
    }
    if (e.key.length === 1) {
      // CAC payloads are space-padded. Without this, the spaces arriving
      // mid-scan scroll whatever panel happens to be under the cursor.
      if (e.key === ' ' && !typing && buf.length) e.preventDefault();
      buf += e.key;
    }
  }, true);

  // Global shortcuts that do not collide with scanning.
  document.addEventListener('keydown', (e) => {
    if (modalOpen) return;
    const t = e.target;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;

    if (e.key === 'Escape' && state.view === 'bar') {
      if (state.ticket.length) clearTicket();
      else clearPatron();
    }
    if (e.key === 'F2' && state.view === 'bar' && !$('#completeSale').disabled) {
      e.preventDefault();
      completeSale();
    }
  });
}

async function handleScan(raw) {
  const data = await tryReq(window.api.scan.resolve, { raw });
  if (!data) return;

  // A card can be scanned from anywhere. Bring the bar up, or the patron
  // loads onto a screen nobody is looking at.
  if (state.view !== 'bar') setView('bar');

  state.patron = data.status;
  state.scanInfo = { isNew: data.isNew, ...data.parsed };
  renderPatronPanel();
  await repriceTicket();

  if (data.status.banned) {
    toast('This patron is flagged as barred — see the red banner.', 'err', 5000);
  } else if (data.status.atLimit) {
    toast(`At the ${data.status.limits.total}-drink limit already.`, 'warn', 4200);
  } else if (data.isNew) {
    // No prompt, nothing to key in. The card is on file and counting from the
    // moment it is scanned; a name can be added later from Edit details.
    toast(`New card on file — ${data.status.label}`, 'ok', 2600);
  }
}

/* ------------------------------------------------------------------ *
 * Bar view — patron panel
 * ------------------------------------------------------------------ */

function wireBar() {
  $('#manualScanBtn').addEventListener('click', submitManualScan);
  $('#manualScan').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitManualScan(); }
  });
  $('#clearPatron').addEventListener('click', clearPatron);
  $('#editPatronBtn').addEventListener('click', () => {
    if (!state.patron) return;
    editPatronDetails(state.patron.patron, (status) => {
      state.patron = status;
      renderPatronPanel();
    });
  });
  $('#banPatronBtn').addEventListener('click', toggleBan);
  $('#historyBtn').addEventListener('click', () => showPatronHistory());

  $('#clearTicket').addEventListener('click', clearTicket);
  $('#completeSale').addEventListener('click', completeSale);
  $('#undoLast').addEventListener('click', undoLastSale);
}

/**
 * Manual entry is a LOOKUP, not a scan.
 *
 * Typing part of a DoD ID has to find the person standing at the bar. Passing
 * it to the scan path would hash the fragment and mint a brand-new patron, so
 * we search first and only fall through to creating a record when the entry is
 * a complete ID (or a scanner payload) that nobody matches.
 */
async function submitManualScan() {
  const input = $('#manualScan');
  const raw = input.value.trim();
  if (!raw) return;

  const matches = await tryReq(window.api.patron.find, { term: raw, limit: 12 });
  if (matches === null) return;

  if (matches.length === 1) {
    input.value = '';
    await loadPatron(matches[0].id);
    return;
  }

  if (matches.length > 1) {
    choosePatron(raw, matches);
    return;
  }

  // A long payload is a card that was scanned into the box — create straight
  // away, as a physical card is unambiguous.
  if (raw.length >= 15) {
    input.value = '';
    await handleScan(raw);
    return;
  }

  // Nothing on file. Offer to add them rather than creating silently, so a
  // typo is caught before it becomes a duplicate record.
  promptAddPatron(raw);
}

/**
 * No match for what was typed. Anything goes here — a surname, a DoD ID, or
 * both — and nothing is required beyond one of the two.
 */
function promptAddPatron(term) {
  const looksNumeric = /^\d+$/.test(term);
  // Anything long is a scanned card rather than something typed. Keep it and
  // key the new patron to it, so scanning again finds this record.
  const scanned = term.length >= 15 ? term : null;

  const firstInput = el('input', { class: 'input', type: 'text', placeholder: 'optional' });
  const lastInput = el('input', {
    class: 'input', type: 'text', placeholder: 'e.g. Ferreira',
    value: (looksNumeric || scanned) ? '' : term,
  });
  const idInput = el('input', {
    class: 'input mono', type: 'text', inputmode: 'numeric', maxlength: '10',
    placeholder: 'optional', value: looksNumeric ? term : '',
  });

  const submit = async (close) => {
    const res = await tryReq(window.api.patron.create, {
      firstName: firstInput.value.trim(),
      lastName: lastInput.value.trim(),
      dodId: idInput.value.trim(),
      cardRaw: scanned,
    });
    if (!res) return;
    close();
    $('#manualScan').value = '';
    state.patron = res.status;
    state.scanInfo = { isNew: res.isNew };
    renderPatronPanel();
    await repriceTicket();
    toast(res.isNew ? `Added ${res.status.label}.` : `Found ${res.status.label}.`, 'ok');
  };

  openModal({
    title: scanned ? 'New card — add this patron' : `No match for “${term}”`,
    body: [
      el('p', { text: scanned
        ? 'This card is not on file. Add the patron and the card is saved with them.'
        : 'Add them now, or cancel and try a different spelling.' }),
      scanned ? el('div', { class: 'scanned-card' }, [
        el('div', { class: 'scanned-label', text: 'Scanned card — saved with this patron' }),
        el('div', { class: 'scanned-value mono', text: scanned }),
      ]) : null,
      el('div', { class: 'form' }, [
        el('div', { class: 'name-row' }, [
          el('label', { class: 'lbl' }, ['First name', firstInput]),
          el('label', { class: 'lbl' }, ['Last name', lastInput]),
        ]),
        el('label', { class: 'lbl' }, ['Customer ID', idInput]),
      ]),
      el('p', { class: 'hint', text: scanned
        ? 'A name is optional — the card alone identifies them from now on.'
        : 'A last name on its own is enough. Adding the customer ID means a scan '
          + 'of their card will find this same record later instead of making a second one.' }),
    ],
    actions: [
      { label: 'Cancel', cls: 'ghost', onClick: (close) => { close(); $('#manualScan').select(); } },
      { label: 'Add Patron', cls: 'primary', onClick: submit },
    ],
    onOpen: () => {
      (looksNumeric ? lastInput : firstInput).focus();
      for (const inp of [firstInput, lastInput, idInput]) {
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(closeModal); });
      }
    },
  });
}

/** Load an existing patron at the bar, as though their card had been scanned. */
async function loadPatron(id) {
  const status = await tryReq(window.api.patron.status, { id });
  if (!status) return;
  state.patron = status;
  state.scanInfo = { isNew: false };
  renderPatronPanel();
  await repriceTicket();
}

/** More than one person matched what was typed — let the bartender pick. */
function choosePatron(term, matches) {
  const rows = matches.map((m) => el('button', {
    class: 'btn wide ghost match-row',
    onclick: async () => {
      closeModal();
      $('#manualScan').value = '';
      await loadPatron(m.id);
    },
  }, [
    el('span', { class: 'match-main' }, [
      el('span', { class: 'match-name', text: m.label }),
      el('span', { class: 'match-sub', text:
        [m.dod_id ? `ID ${m.dod_id}` : null,
         m.drinks_today ? `${m.drinks_today} tonight` : null,
         `last in ${fmtDate(m.last_seen_at)}`].filter(Boolean).join(' · ') }),
    ]),
  ]));

  openModal({
    title: `${matches.length} patrons match “${term}”`,
    body: [
      el('p', { text: 'Pick the right one.' }),
      el('div', { class: 'match-list' }, rows),
    ],
    actions: [{ label: 'Cancel', cls: 'ghost' }],
  });
}

function clearPatron() {
  state.patron = null;
  state.scanInfo = null;
  renderPatronPanel();
  repriceTicket();
  focusLookup();
}

/** Park the cursor in the lookup box so typing a name or ID just works. */
function focusLookup() {
  const box = $('#manualScan');
  if (!box || state.view !== 'bar') return;
  box.value = '';
  setTimeout(() => box.focus(), 30);
}

function renderPatronPanel() {
  const idle = $('#scanIdle');
  const card = $('#patronCard');

  if (!state.patron) {
    card.classList.add('hidden');
    idle.classList.remove('hidden');
    return;
  }

  idle.classList.add('hidden');
  card.classList.remove('hidden');

  const s = state.patron;
  const p = s.patron;

  $('#pName').textContent = s.label;
  // Show the stored identifier underneath whenever it is not already the name.
  $('#pLast4').textContent = p.display_name && p.dod_id ? `ID ${p.dod_id}`
    : (!p.display_name && p.dod_id) ? ''            // already the headline
    : p.last4 ? `#${p.last4}` : '';
  $('#pVisits').textContent = s.visits > 1 ? `${s.visits} visits` : 'first visit';

  // Flags
  const flags = $('#pFlags');
  flags.replaceChildren();
  if (s.banned) {
    flags.appendChild(el('div', { class: 'flag banned', text: `BARRED — ${p.ban_reason || 'no reason recorded'}` }));
  }
  if (s.underage) {
    flags.appendChild(el('div', { class: 'flag under', text: `UNDER ${s.minAge} — do not serve alcohol` }));
  }
  if (state.scanInfo && state.scanInfo.isNew) {
    flags.appendChild(el('div', { class: 'flag new', text: 'First time scanned here' }));
  }
  if (s.atLimit) {
    flags.appendChild(el('div', { class: 'flag limit', text: `At the ${s.limits.total}-drink limit for the night` }));
  } else if (s.blockedGroups.length) {
    const names = s.blockedGroups.map((g) => GROUP_LABELS[g]).join(' and ');
    flags.appendChild(el('div', { class: 'flag limit', text: `${names} cut off — other categories still available` }));
  } else if (s.remaining.total <= 1 && s.today.servings > 0) {
    flags.appendChild(el('div', { class: 'flag near', text: `${s.remaining.total} left before the night limit` }));
  }

  // Meter
  $('#pCount').textContent = `${s.today.servings} / ${s.limits.total}`;
  renderPips(s);
  renderGroupMeters(s);

  $('#pAge').textContent = s.age == null ? 'not on file' : `${s.age}`;
  $('#pSpend').textContent = money(s.today.cents);
  $('#pLifetime').textContent = `${s.visits} · ${round2(s.lifetimeDrinks)} drinks all-time`;
  $('#pFirstSeen').textContent = fmtDate(p.first_seen_at);
  $('#banPatronBtn').textContent = s.banned ? 'Remove Bar' : 'Flag / Bar';
}

function renderPips(s) {
  const wrap = $('#pPips');
  wrap.replaceChildren();
  const limit = Math.max(1, s.limits.total);
  const had = s.today.servings;
  const pending = state.quote ? state.quote.servings : 0;
  const total = Math.max(limit, had + pending);

  for (let i = 0; i < total; i++) {
    let cls = 'pip';
    if (i < had) cls += i >= limit ? ' over' : ' on';
    else if (i < had + pending) cls += i >= limit ? ' over' : ' pending';
    wrap.appendChild(el('div', { class: cls }));
  }

  const note = $('#pProjected');
  const q = state.quote;
  if (q && q.limitMessage) note.textContent = q.limitMessage;
  else if (q && q.servings > 0) {
    note.textContent = `This ticket takes them to ${q.projected.total} of ${s.limits.total}.`;
  } else note.textContent = '';
}

/** Per-category caps, so the bartender can see which one is about to bind. */
function renderGroupMeters(s) {
  const wrap = $('#pGroups');
  wrap.replaceChildren();
  const pending = state.quote ? state.quote.byGroup : null;

  for (const g of ['beer', 'wine', 'liquor']) {
    const had = s.today.byGroup[g];
    const cap = s.limits[g];
    const add = pending ? pending[g] : 0;
    const projected = had + add;

    let cls = 'gmeter';
    if (projected >= cap || s.effective[g] <= 0) cls += ' full';
    else if (cap - projected <= 1) cls += ' near';
    // A cap above the night total can never bind on its own — say so quietly.
    if (cap >= s.limits.total && had === 0 && add === 0) cls += ' capped';

    wrap.appendChild(el('div', { class: cls }, [
      el('div', { class: 'gm-label', text: GROUP_LABELS[g] }),
      el('div', { class: 'gm-count', text: `${projected} / ${cap}` }),
    ]));
  }
}

/**
 * Shared by the bar panel and the Patrons table.
 * `onSaved` receives the refreshed patronStatus.
 */
function editPatronDetails(patron, onSaved) {
  const p = patron;
  if (!p) return;
  const firstName = el('input', { class: 'input', type: 'text', value: p.first_name || '', placeholder: 'optional' });
  const lastName = el('input', { class: 'input', type: 'text', value: p.last_name || '' });
  const dob = el('input', { class: 'input', type: 'date', value: p.dob || '' });
  const dodId = el('input', {
    class: 'input mono', type: 'text', inputmode: 'numeric', maxlength: '10',
    value: p.dod_id || '', placeholder: '10-digit customer ID',
  });
  const cardInput = el('input', {
    class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: p.card_payload ? 'scan again to replace the saved card' : 'scan the card here',
  });
  const notes = el('input', { class: 'input', type: 'text', value: p.notes || '', placeholder: 'e.g. DD tonight, allergic to…' });

  openModal({
    title: `Patron Details — ${p.display_name || p.dod_id || `#${p.id}`}`,
    body: [
      el('p', { class: 'hint', text: p.dod_id
        ? 'Everything here is optional and can be corrected at any time.'
        : 'No customer ID came off this card. Add it and they become searchable by it.' }),
      el('div', { class: 'form' }, [
        el('div', { class: 'name-row' }, [
          el('label', { class: 'lbl' }, ['First name', firstName]),
          el('label', { class: 'lbl' }, ['Last name', lastName]),
        ]),
        el('label', { class: 'lbl' }, ['Customer ID', dodId]),
        el('label', { class: 'lbl' }, ['Date of birth', dob]),
        el('label', { class: 'lbl' }, ['Notes', notes]),
        el('label', { class: 'lbl' }, [
          p.card_payload ? 'Card on file — scan to replace' : 'No card on file — scan to attach',
          cardInput,
        ]),
      ]),
      el('p', { class: 'hint', text: p.card_payload
        ? 'Their card is saved, so scanning it finds this record.'
        : 'Scanning a card here saves it against this patron, so future scans '
          + 'find them instead of creating a second record.' }),
    ],
    actions: [
      { label: 'Cancel', cls: 'ghost' },
      {
        label: 'Save', cls: 'primary',
        onClick: async (close) => {
          const status = await tryReq(window.api.patron.update, {
            id: p.id,
            fields: {
              first_name: firstName.value.trim(), last_name: lastName.value.trim(),
              dob: dob.value || '', dod_id: dodId.value.trim(),
              notes: notes.value.trim(),
            },
          });
          if (!status) return;   // e.g. that ID already belongs to someone else

          // Attach the card last: it can fail on its own (already on someone
          // else) and should not silently discard the other edits.
          const scannedCard = cardInput.value.trim();
          let finalStatus = status;
          if (scannedCard) {
            const linked = await tryReq(window.api.patron.linkCard, { id: p.id, raw: scannedCard });
            if (!linked) return;
            finalStatus = linked;
            toast('Card saved to this patron.', 'ok');
          }
          close();
          if (onSaved) onSaved(finalStatus);
        },
      },
    ],
    onOpen: () => (p.last_name ? firstName : lastName).focus(),
  });
}

/**
 * Remove a patron. Their orders are kept and detached, so the night's takings
 * stay correct — the confirm says so plainly before anything happens.
 */
async function deletePatron(patron, onDone) {
  const footprint = await tryReq(window.api.patron.footprint, { id: patron.id });
  if (!footprint) return;

  const label = patron.label || patron.display_name || patron.dod_id || `Patron ${patron.id}`;
  const history = footprint.orders
    ? `They have ${footprint.orders} order${footprint.orders === 1 ? '' : 's'} across ` +
      `${footprint.nights} night${footprint.nights === 1 ? '' : 's'} totalling ${money(footprint.cents)}. ` +
      'Those sales are kept and stay in the reports — only the person is removed, ' +
      'so the takings still add up. Their drink history detaches from them permanently.'
    : 'They have no orders on record, so nothing else is affected.';

  const got = await askManager({
    title: `Delete ${label}?`,
    message: `${history} This cannot be undone.`,
    needPin: state.settings.require_pin_for_admin === '1',
    confirmLabel: 'Delete Patron',
    confirmCls: 'danger',
  });
  if (!got) return;

  const res = await tryReq(window.api.patron.delete, { id: patron.id, pin: got.pin });
  if (!res) return;

  // If they were on screen at the bar, clear them.
  if (state.patron && state.patron.patron.id === patron.id) clearPatron();

  toast(res.orders
    ? `${label} deleted. ${res.orders} order${res.orders === 1 ? '' : 's'} kept and detached.`
    : `${label} deleted.`, 'ok', 4000);
  if (onDone) onDone();
}

async function toggleBan() {
  if (!state.patron) return;
  const s = state.patron;
  const p = s.patron;

  if (s.banned) {
    const got = await askManager({
      title: 'Remove Bar',
      message: `Clear the barred flag on ${s.label}?`,
      needPin: state.settings.require_pin_for_override === '1',
      confirmLabel: 'Remove Bar',
    });
    if (!got) return;
    const status = await tryReq(window.api.patron.ban, { id: p.id, banned: false, pin: got.pin });
    if (status) { state.patron = status; renderPatronPanel(); toast('Bar removed.', 'ok'); }
    return;
  }

  const got = await askManager({
    title: 'Flag / Bar Patron',
    message: 'They will still scan, but every future sale will show a red banner and require an override.',
    needReason: true,
    reasonLabel: 'Reason (recorded permanently)',
    needPin: state.settings.require_pin_for_override === '1',
    confirmLabel: 'Bar Patron',
    confirmCls: 'danger',
  });
  if (!got) return;
  const status = await tryReq(window.api.patron.ban, { id: p.id, banned: true, reason: got.reason, pin: got.pin });
  if (status) { state.patron = status; renderPatronPanel(); toast('Patron flagged.', 'warn'); }
}

/**
 * A patron's drink history, with each drink removable after the fact.
 * Works from the bar panel and from the Patrons roster.
 */
async function showPatronHistory(patronId) {
  const id = patronId || (state.patron && state.patron.patron.id);
  if (!id) return;

  const status = await tryReq(window.api.patron.status, { id });
  const orders = await tryReq(window.api.patron.history, { id, limit: 80 });
  if (!status || !orders) return;

  const body = [];

  body.push(el('p', {
    text: `${status.today.servings} of ${status.limits.total} tonight`
      + ` · ${status.visits} visit${status.visits === 1 ? '' : 's'} on record.`,
  }));

  if (!orders.length) {
    body.push(el('p', { text: 'No orders on record yet.' }));
  } else {
    body.push(el('p', { class: 'hint', text:
      'Removing a drink puts the stock back and takes it off their count for '
      + 'that night. The rest of the order is untouched.' }));

    const list = el('div', { class: 'history-list' });
    for (const o of orders) {
      const head = el('div', { class: 'hist-head' }, [
        el('span', { class: 'hist-when', text: `${fmtDate(o.business_date)} · ${fmtTime(o.created_at)}` }),
        el('span', { class: 'hist-total', text: money(o.subtotal_cents) }),
      ]);

      const rows = o.items.map((i) => el('div', { class: 'hist-item' }, [
        el('span', { class: 'hist-qty', text: `${i.qty}×` }),
        el('span', { class: 'hist-name', text: i.product_name }),
        o.voided ? null : el('button', {
          class: 'btn small danger-ghost',
          text: i.qty > 1 ? 'Remove one' : 'Remove',
          onclick: () => removeDrink(id, o, i),
        }),
      ]));

      list.appendChild(el('div', { class: `hist-order ${o.voided ? 'voided' : ''}` }, [
        head,
        ...rows,
        o.voided
          ? el('div', { class: 'hist-void', text: `Voided — ${o.void_reason || 'no reason recorded'}` })
          : el('div', { class: 'hist-actions' }, [
            el('button', {
              class: 'btn small ghost', text: 'Void whole order',
              onclick: () => voidOrderFromHistory(id, o),
            }),
          ]),
      ]));
    }
    body.push(list);
  }

  openModal({
    title: `History — ${status.label}`,
    body,
    actions: [{ label: 'Close', cls: 'primary' }],
  });
}

async function removeDrink(patronId, order, item) {
  const got = await askManager({
    title: `Remove ${item.qty > 1 ? 'one ' : ''}${item.product_name}?`,
    message: `From the order rung at ${fmtTime(order.created_at)} on `
      + `${fmtDate(order.business_date)}. The stock goes back and it comes off `
      + 'their count for that night.',
    needReason: true,
    reasonLabel: 'Reason',
    needPin: state.settings.require_pin_for_void === '1',
    confirmLabel: 'Remove Drink',
    confirmCls: 'danger',
  });
  if (!got) { showPatronHistory(patronId); return; }

  const res = await tryReq(window.api.order.removeItem, {
    orderId: order.id, itemId: item.id, qty: 1,
    reason: got.reason, pin: got.pin,
    actor: state.settings.bartender_name || null,
  });
  if (!res) { showPatronHistory(patronId); return; }

  await afterHistoryChange(patronId, res);
  toast(res.orderVoided
    ? `${res.productName} removed — nothing left on that order, so it was voided.`
    : `${res.productName} removed.`, 'ok', 3600);
  showPatronHistory(patronId);
}

async function voidOrderFromHistory(patronId, order) {
  const got = await askManager({
    title: `Void the order from ${fmtTime(order.created_at)}?`,
    message: `${money(order.subtotal_cents)} · `
      + `${order.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ')}. `
      + 'Everything on it goes back on the shelf and off their count.',
    needReason: true,
    reasonLabel: 'Reason',
    needPin: state.settings.require_pin_for_void === '1',
    confirmLabel: 'Void Order',
    confirmCls: 'danger',
  });
  if (!got) { showPatronHistory(patronId); return; }

  const res = await tryReq(window.api.order.void, {
    orderId: order.id, reason: got.reason, pin: got.pin,
    actor: state.settings.bartender_name || null,
  });
  if (!res) { showPatronHistory(patronId); return; }

  await afterHistoryChange(patronId, res);
  toast('Order voided.', 'ok');
  showPatronHistory(patronId);
}

/** Pull the rest of the screen back in line after a history edit. */
async function afterHistoryChange(patronId, res) {
  if (res.products) state.products = res.products;
  if (res.lowStock) state.lowStock = res.lowStock;
  if (state.patron && state.patron.patron.id === patronId) {
    state.patron = await tryReq(window.api.patron.status, { id: patronId }) || state.patron;
    renderPatronPanel();
    await repriceTicket();
  }
  renderChrome();
  renderProducts();
  await refreshRecent();
  if (state.view === 'patrons') await renderPatronTable();
}

/* ------------------------------------------------------------------ *
 * Bar view — menu + ticket
 * ------------------------------------------------------------------ */

function availableCategories() {
  const present = new Set(state.products.map((p) => p.category));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  // Anything present but unlisted (a retired category on a legacy install)
  // still gets a tab rather than silently hiding its stock.
  for (const c of present) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

function renderCategories() {
  const wrap = $('#catTabs');
  wrap.replaceChildren();
  for (const c of availableCategories()) {
    wrap.appendChild(el('button', {
      class: `cattab ${c === state.category ? 'active' : ''}`,
      text: CATEGORY_LABELS[c] || c,
      onclick: () => { state.category = c; renderCategories(); renderProducts(); },
    }));
  }
}

function renderProducts() {
  const grid = $('#productGrid');
  grid.replaceChildren();
  const items = state.products.filter((p) => p.category === state.category);

  if (!items.length) {
    grid.appendChild(el('p', { class: 'empty', text: 'Nothing in this category yet. Add items under Inventory.' }));
    return;
  }

  for (const p of items) {
    const onTicket = state.ticket.find((t) => t.productId === p.id);
    const out = p.qty_on_hand <= 0;
    const low = !out && p.par_level > 0 && p.qty_on_hand <= p.par_level;

    grid.appendChild(el('button', {
      class: `prod ${out ? 'out' : ''}`,
      onclick: () => addToTicket(p.id),
      title: `${p.name}${p.brand ? ` · ${p.brand}` : ''}`,
    }, [
      el('div', { class: 'prod-name', text: p.name }),
      el('div', {
        class: 'prod-meta',
        text: [p.abv ? `${p.abv}% ABV` : null,
               p.serving_oz ? `${p.serving_oz} oz` : null,
               p.standard_drinks ? `${round2(p.standard_drinks)} std` : null]
          .filter(Boolean).join(' · '),
      }),
      el('div', { class: 'prod-foot' }, [
        el('span', { class: 'prod-price', text: money(p.price_cents) }),
        el('span', {
          class: `stock ${out ? 'out' : low ? 'low' : ''}`,
          text: out ? 'out of stock' : `${round2(p.qty_on_hand)} left`,
        }),
      ]),
      onTicket ? el('span', { class: 'prod-count', text: String(onTicket.qty) }) : null,
    ]));
  }
}

function addToTicket(productId) {
  const line = state.ticket.find((t) => t.productId === productId);
  if (line) line.qty += 1;
  else state.ticket.push({ productId, qty: 1 });
  repriceTicket();
}

function setQty(productId, qty) {
  const i = state.ticket.findIndex((t) => t.productId === productId);
  if (i < 0) return;
  if (qty <= 0) state.ticket.splice(i, 1);
  else state.ticket[i].qty = qty;
  repriceTicket();
}

function clearTicket() {
  state.ticket = [];
  repriceTicket();
}

async function repriceTicket() {
  if (!state.ticket.length) {
    state.quote = null;
    renderTicket();
    renderProducts();
    if (state.patron) { renderPips(state.patron); renderGroupMeters(state.patron); }
    return;
  }
  const quote = await tryReq(window.api.ticket.price, {
    patronId: state.patron ? state.patron.patron.id : null,
    items: state.ticket.map((t) => ({ productId: t.productId, qty: t.qty })),
  });
  state.quote = quote;
  renderTicket();
  renderProducts();
  // Both meters read from the quote, so they have to move with the ticket.
  if (state.patron) { renderPips(state.patron); renderGroupMeters(state.patron); }
}

function renderTicket() {
  const wrap = $('#ticketLines');
  wrap.replaceChildren();
  const q = state.quote;

  if (!q || !q.lines.length) {
    wrap.appendChild(el('p', { class: 'empty', text: 'Tap a drink to start a ticket.' }));
    $('#tDrinks').textContent = '0';
    $('#tTotal').textContent = money(0);
    $('#ticketWarn').classList.add('hidden');
    const btn = $('#completeSale');
    btn.disabled = true;
    btn.textContent = 'Complete Sale';
    btn.className = 'btn primary big';
    return;
  }

  for (const l of q.lines) {
    wrap.appendChild(el('div', { class: `tline ${l.overStock ? 'overstock' : ''}` }, [
      el('div', { class: 'tline-main' }, [
        el('div', { class: 'tline-name', text: l.name }),
        el('div', {
          class: 'tline-sub',
          text: `${money(l.unitPriceCents)} ea · ${round2(l.standardDrinks)} std${l.overStock ? ` · only ${round2(l.qtyOnHand)} in stock` : ''}`,
        }),
      ]),
      el('div', { class: 'qty-ctl' }, [
        el('button', { class: 'qty-btn', text: '−', onclick: () => setQty(l.productId, l.qty - 1) }),
        el('span', { class: 'qty-val', text: String(l.qty) }),
        el('button', { class: 'qty-btn', text: '+', onclick: () => setQty(l.productId, l.qty + 1) }),
      ]),
      el('div', { class: 'tline-amt', text: money(l.lineCents) }),
    ]));
  }

  $('#tDrinks').textContent = q.servings === q.standardDrinks
    ? String(q.servings)
    : `${q.servings} (${round2(q.standardDrinks)} std)`;
  $('#tTotal').textContent = money(q.subtotalCents);

  // Warnings and the state of the big button.
  const warn = $('#ticketWarn');
  const btn = $('#completeSale');
  btn.disabled = false;
  btn.className = 'btn primary big';
  btn.textContent = `Complete Sale · ${money(q.subtotalCents)}`;
  warn.classList.add('hidden');
  warn.className = 'ticket-warn hidden';

  // No card, no sale. Every drink has to land on somebody's count.
  if (!state.patron) {
    btn.disabled = true;
    btn.textContent = 'Scan a card to sell';
    warn.classList.remove('hidden');
    warn.className = 'ticket-warn soft';
    warn.textContent = 'Scan the patron’s CAC before completing the sale.';
    return;
  }

  const messages = [];
  if (q.banned) messages.push('Patron is barred.');
  if (q.underage) messages.push(`Patron is under ${state.settings.min_age}.`);
  if (q.overLimit && q.limitMessage) messages.push(q.limitMessage);
  if (q.anyOverStock) {
    messages.push('Ticket exceeds stock on hand.');
  }

  if (messages.length) {
    warn.classList.remove('hidden');
    const hard = q.needsOverride || q.underage || q.banned;
    warn.className = `ticket-warn ${hard ? 'block' : 'soft'}`;
    warn.textContent = messages.join(' ');
  }

  if (q.underage && !q.banned) {
    btn.textContent = 'Blocked — underage';
    btn.className = 'btn danger big';
  } else if (q.banned) {
    btn.textContent = 'Override Required — barred';
    btn.className = 'btn override big';
  } else if (q.needsOverride) {
    const b = q.breaches[0];
    btn.textContent = b && b.group !== 'total'
      ? `${b.label} Limit — Manager Override`
      : 'Over Limit — Manager Override';
    btn.className = 'btn override big';
  }
}

async function completeSale() {
  const q = state.quote;
  if (!q || !q.lines.length) return;

  const patronId = state.patron ? state.patron.patron.id : null;
  let overrideReason = null;
  let pin = null;

  const needsOverride = q.needsOverride || q.banned || q.underage;
  if (needsOverride) {
    let title = 'Manager Override';
    let message = `${q.limitMessage || 'This sale is over the limit.'} ` +
      `They have had ${q.already.total} tonight and this ticket adds ${q.servings}.`;
    if (q.banned) {
      title = 'Serve a Barred Patron?';
      message = 'This patron is flagged as barred. Overriding is recorded against your name.';
    } else if (q.underage) {
      title = 'Underage Patron';
      message = `Date of birth on file puts this patron under ${state.settings.min_age}. ` +
                'Only override if the date of birth on file is wrong — fix it under Edit details instead.';
    }

    const got = await askManager({
      title, message,
      needReason: true,
      reasonLabel: 'Reason for the override',
      needPin: state.settings.require_pin_for_override === '1',
      confirmLabel: 'Override and Sell',
      confirmCls: 'override',
    });
    if (!got) return;
    overrideReason = got.reason;
    pin = got.pin;
  }

  const res = await tryReq(window.api.order.create, {
    patronId,
    items: state.ticket.map((t) => ({ productId: t.productId, qty: t.qty })),
    paymentMethod: state.payment,
    bartender: state.settings.bartender_name || null,
    overrideReason,
    pin,
  });
  if (!res) return;

  const soldTo = state.patron ? state.patron.label : '';
  state.products = res.products;
  state.lowStock = res.lowStock;
  state.ticket = [];
  state.quote = null;

  // Clear down to the scan prompt so the next customer can step straight up.
  // Their updated count is on the record; it does not need to stay on screen.
  state.patron = null;
  state.scanInfo = null;

  renderChrome();
  renderProducts();
  renderTicket();
  renderPatronPanel();
  await refreshRecent();
  focusLookup();

  toast(`${money(res.subtotalCents)} rung up${soldTo ? ` — ${soldTo}` : ''}. Ready for the next card.`,
    'ok', 3200);
  if (state.lowStock.length) {
    const names = state.lowStock.slice(0, 3).map((l) => l.name).join(', ');
    toast(`Low stock: ${names}${state.lowStock.length > 3 ? '…' : ''}`, 'warn', 4000);
  }
}

/** The most recent sale that has not already been voided. */
function lastLiveOrder() {
  return (state.recent || []).find((o) => !o.voided) || null;
}

/**
 * One-tap reversal of the sale just rung up — the "wrong button" case, which
 * is common and time-critical. Same PIN rule as any other void, with the
 * reason pre-filled so it is a single confirmation rather than a form.
 */
async function undoLastSale() {
  const order = lastLiveOrder();
  if (!order) { toast('Nothing to undo.', 'warn'); return; }

  const got = await askManager({
    title: 'Undo the last sale?',
    message: `${fmtTime(order.created_at)} · ${order.patron_label} · `
      + `${order.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ')} · `
      + `${money(order.subtotal_cents)}. Everything on it goes back on the shelf `
      + 'and off their count.',
    needReason: true,
    reasonLabel: 'Reason',
    needPin: state.settings.require_pin_for_void === '1',
    confirmLabel: 'Undo Sale',
    confirmCls: 'danger',
  });
  if (!got) return;

  const res = await tryReq(window.api.order.void, {
    orderId: order.id, reason: got.reason || 'undo — rung in error', pin: got.pin,
    actor: state.settings.bartender_name || null,
  });
  if (!res) return;

  state.products = res.products;
  if (res.patron && state.patron && res.patron.patron.id === state.patron.patron.id) {
    state.patron = res.patron;
    renderPatronPanel();
  }
  renderProducts();
  await refreshRecent();
  state.lowStock = await tryReq(window.api.inventory.lowStock) || state.lowStock;
  renderChrome();
  await repriceTicket();
  toast(`Undone — ${money(order.subtotal_cents)} reversed.`, 'ok', 3200);
}

async function refreshRecent() {
  const rows = await tryReq(window.api.order.recent, { limit: 25 });
  if (!rows) return;
  state.recent = rows;

  const undo = $('#undoLast');
  const last = lastLiveOrder();
  undo.disabled = !last;
  undo.title = last
    ? `${fmtTime(last.created_at)} · ${last.patron_label} · ${money(last.subtotal_cents)}`
    : 'No sale to undo';

  const wrap = $('#recentList');
  wrap.replaceChildren();
  if (!rows.length) {
    wrap.appendChild(el('p', { class: 'empty', text: 'No sales yet tonight.' }));
    return;
  }

  for (const o of rows) {
    wrap.appendChild(el('div', { class: `rline ${o.voided ? 'voided' : ''}` }, [
      el('div', { class: 'rl-main' }, [
        el('div', { class: 'rl-who', text: `${fmtTime(o.created_at)} · ${o.patron_label}` }),
        el('div', { class: 'rl-what', text: o.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ') }),
      ]),
      el('span', { text: money(o.subtotal_cents) }),
      o.voided ? null : el('button', {
        class: 'rl-void', text: 'Void',
        onclick: () => voidOrder(o),
      }),
    ]));
  }
}

async function voidOrder(o) {
  const got = await askManager({
    title: `Void order #${o.id}`,
    message: `${money(o.subtotal_cents)} · ${o.patron_label}. Stock goes back on the shelf and the drinks come off their count.`,
    needReason: true,
    reasonLabel: 'Reason',
    needPin: state.settings.require_pin_for_void === '1',
    confirmLabel: 'Void Order',
    confirmCls: 'danger',
  });
  if (!got) return;

  const res = await tryReq(window.api.order.void, {
    orderId: o.id, reason: got.reason, pin: got.pin,
    actor: state.settings.bartender_name || null,
  });
  if (!res) return;

  state.products = res.products;
  if (res.patron && state.patron && res.patron.patron.id === state.patron.patron.id) {
    state.patron = res.patron;
  }
  renderProducts();
  renderPatronPanel();
  await refreshRecent();
  state.lowStock = await tryReq(window.api.inventory.lowStock) || state.lowStock;
  renderChrome();
  toast('Order voided.', 'ok');
}

/* ------------------------------------------------------------------ *
 * Inventory view
 * ------------------------------------------------------------------ */

let invRows = [];

function wireInventory() {
  $('#invShowInactive').addEventListener('change', renderInventory);
  $('#invSearch').addEventListener('input', renderInventory);
  $('#newProductBtn').addEventListener('click', () => editProduct(null));
  $('#bulkPriceBtn').addEventListener('click', openBulkPrice);
}

async function renderInventory() {
  const includeInactive = $('#invShowInactive').checked;
  const rows = await tryReq(window.api.product.list, { includeInactive });
  if (!rows) return;
  invRows = rows;

  const filter = $('#invSearch').value.trim().toLowerCase();
  const shown = filter
    ? rows.filter((r) => `${r.name} ${r.brand || ''} ${r.category} ${r.sku || ''}`.toLowerCase().includes(filter))
    : rows;

  const tbody = $('#invTable tbody');
  tbody.replaceChildren();

  for (const r of shown) {
    const qtyInput = el('input', {
      class: 'input tiny num', type: 'number', step: '0.001', value: String(r.qty_on_hand),
    });
    const commitCount = async () => {
      const next = num(qtyInput.value, r.qty_on_hand);
      if (next === r.qty_on_hand) return;
      const res = await tryReq(window.api.inventory.adjust, {
        productId: r.id, newQty: next, reason: 'recount',
        actor: state.settings.bartender_name || null,
      });
      if (!res) { qtyInput.value = String(r.qty_on_hand); return; }
      state.lowStock = res.lowStock;
      renderChrome();
      await refreshProductsCache();
      toast(`${r.name} recounted to ${round2(res.qty_on_hand)}.`, 'ok', 1800);
      renderInventory();
    };
    qtyInput.addEventListener('blur', commitCount);
    qtyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); qtyInput.blur(); } });

    const deltaInput = el('input', { class: 'input tiny num', type: 'text', placeholder: '+/−' });
    const reasonSel = el('select', { class: 'input tiny' }, [
      el('option', { value: 'delivery', text: 'Delivery' }),
      el('option', { value: 'spill', text: 'Spill' }),
      el('option', { value: 'comp', text: 'Comp' }),
      el('option', { value: 'transfer', text: 'Transfer' }),
      el('option', { value: 'correction', text: 'Correction' }),
    ]);
    const applyDelta = async () => {
      const d = parseFloat(deltaInput.value);
      if (!d || Number.isNaN(d)) return;
      const res = await tryReq(window.api.inventory.adjust, {
        productId: r.id, delta: d, reason: reasonSel.value,
        actor: state.settings.bartender_name || null,
      });
      deltaInput.value = '';
      if (!res) return;
      state.lowStock = res.lowStock;
      renderChrome();
      await refreshProductsCache();
      toast(`${r.name} ${d > 0 ? '+' : ''}${d} (${reasonSel.value}) → ${round2(res.qty_on_hand)}.`, 'ok', 2000);
      renderInventory();
      renderAdjustments();
    };
    deltaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyDelta(); } });

    // Price is editable in place — the fastest path when the club changes what
    // something costs. Deliberately does not re-render the table on save, so
    // the manager can tab straight down a column re-pricing as they go.
    const priceInput = el('input', {
      class: 'input tiny num', type: 'number', step: '0.25', min: '0',
      value: (r.price_cents / 100).toFixed(2),
      title: 'Click to edit, Enter to save',
    });
    const commitPrice = async () => {
      const cents = centsFromDollars(priceInput.value);
      if (cents === r.price_cents) { priceInput.value = (r.price_cents / 100).toFixed(2); return; }
      const res = await tryReq(window.api.product.setPrice, {
        id: r.id, priceCents: cents, actor: state.settings.bartender_name || null,
      });
      if (!res) { priceInput.value = (r.price_cents / 100).toFixed(2); return; }
      const was = r.price_cents;
      r.price_cents = cents;
      priceInput.value = (cents / 100).toFixed(2);
      state.products = res.products.filter((p) => p.active);
      renderCategories();
      renderProducts();
      renderPriceSummary();
      await repriceTicket();
      toast(`${r.name}  ${money(was)} → ${money(cents)}`, 'ok', 2000);
    };
    priceInput.addEventListener('blur', commitPrice);
    priceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); priceInput.blur(); } });

    const parInput = el('input', { class: 'input tiny num', type: 'number', step: '1', value: String(r.par_level) });
    const unitInput = el('input', { class: 'input tiny', type: 'text', value: r.unit || 'each' });
    const commitMeta = async () => {
      await tryReq(window.api.inventory.meta, {
        productId: r.id, unit: unitInput.value.trim() || 'each', par_level: num(parInput.value, 0),
      });
      state.lowStock = await tryReq(window.api.inventory.lowStock) || state.lowStock;
      renderChrome();
    };
    parInput.addEventListener('blur', commitMeta);
    unitInput.addEventListener('blur', commitMeta);

    tbody.appendChild(el('tr', { class: r.active ? '' : 'inactive' }, [
      el('td', {}, [
        el('div', { text: r.name }),
        r.brand ? el('div', { class: 'prod-meta', text: r.brand }) : null,
      ]),
      el('td', { text: CATEGORY_LABELS[r.category] || r.category }),
      el('td', { class: 'num', text: r.abv ? `${r.abv}%` : '—' }),
      el('td', { class: 'num', text: r.serving_oz ? `${r.serving_oz} oz` : '—' }),
      el('td', { class: 'num', text: String(round2(r.standard_drinks)) }),
      el('td', { class: 'num' }, [
        el('span', { class: 'price-cell' }, [el('span', { class: 'money-mark', text: '$' }), priceInput]),
      ]),
      el('td', { class: 'num' }, [qtyInput]),
      el('td', {}, [unitInput]),
      el('td', { class: 'num' }, [parInput]),
      el('td', { class: 'num' }, [el('div', { class: 'qty-ctl' }, [deltaInput, reasonSel])]),
      el('td', { text: r.last_counted_at ? fmtDateTime(r.last_counted_at) : '—' }),
      el('td', {}, [
        el('button', { class: 'btn small ghost', text: 'Edit', onclick: () => editProduct(r) }),
      ]),
    ]));
  }

  if (!shown.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: '12' }, [el('p', { class: 'empty', text: 'Nothing matches.' })])]));
  }
}

async function refreshProductsCache() {
  const products = await tryReq(window.api.product.list, {});
  if (products) {
    state.products = products;
    renderCategories();
    renderProducts();
  }
}

async function renderAdjustments() {
  const rows = await tryReq(window.api.inventory.adjustments, { limit: 150 });
  if (!rows) return;
  const tbody = $('#adjTable tbody');
  tbody.replaceChildren();
  for (const a of rows) {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: fmtDateTime(a.created_at) }),
      el('td', { text: a.product_name }),
      el('td', { class: 'num', text: `${a.delta > 0 ? '+' : ''}${round2(a.delta)}` }),
      el('td', { class: 'num', text: String(round2(a.new_qty)) }),
      el('td', { text: a.reason }),
      el('td', { text: a.actor || '—' }),
      el('td', { text: a.note || (a.order_id ? `order #${a.order_id}` : '') }),
    ]));
  }
  if (!rows.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: '7' }, [el('p', { class: 'empty', text: 'No adjustments yet.' })])]));
  }
}

function editProduct(existing) {
  const isNew = !existing;
  const p = existing || {
    category: state.category, brand: '', name: '', abv: '', serving_oz: '',
    price_cents: 0, standard_drinks: '', sku: '', active: 1, sort_order: 0,
    qty_on_hand: 0, unit: 'each', par_level: 0,
  };

  const catSel = el('select', { class: 'input' }, CATEGORY_ORDER.map((c) =>
    el('option', { value: c, text: CATEGORY_LABELS[c], selected: c === p.category })));
  const nameIn = el('input', { class: 'input', type: 'text', value: p.name });
  const brandIn = el('input', { class: 'input', type: 'text', value: p.brand || '' });
  const abvIn = el('input', { class: 'input', type: 'number', step: '0.1', min: '0', value: p.abv ?? '' });
  const ozIn = el('input', { class: 'input', type: 'number', step: '0.1', min: '0', value: p.serving_oz ?? '' });
  const priceIn = el('input', { class: 'input', type: 'number', step: '0.25', min: '0', value: ((p.price_cents || 0) / 100).toFixed(2) });
  const sdIn = el('input', { class: 'input', type: 'number', step: '0.01', min: '0', value: p.standard_drinks ?? '' });
  const skuIn = el('input', { class: 'input', type: 'text', value: p.sku || '' });
  const activeIn = el('input', { type: 'checkbox' });
  activeIn.checked = !!p.active;
  const sortIn = el('input', { class: 'input', type: 'number', step: '10', value: String(p.sort_order || 0) });
  const qtyIn = el('input', { class: 'input', type: 'number', step: '1', min: '0', value: String(p.qty_on_hand || 0) });
  const unitIn = el('input', { class: 'input', type: 'text', value: p.unit || 'each' });
  const parIn = el('input', { class: 'input', type: 'number', step: '1', min: '0', value: String(p.par_level || 0) });

  // Keep the standard-drink figure in step with ABV and pour size unless the
  // operator has deliberately typed their own number.
  const recalc = () => {
    const oz = num(ozIn.value), abv = num(abvIn.value);
    if (oz > 0 && abv > 0) sdIn.value = String(round2((oz * (abv / 100)) / 0.6));
  };
  abvIn.addEventListener('input', recalc);
  ozIn.addEventListener('input', recalc);

  openModal({
    title: isNew ? 'New Item' : `Edit — ${p.name}`,
    body: [el('div', { class: 'form' }, [
      el('label', { class: 'lbl' }, ['Name', nameIn]),
      el('label', { class: 'lbl' }, ['Category', catSel]),
      el('label', { class: 'lbl' }, ['Brand (optional)', brandIn]),
      el('label', { class: 'lbl' }, ['Price (USD)', priceIn]),
      el('label', { class: 'lbl' }, ['ABV %', abvIn]),
      el('label', { class: 'lbl' }, ['Serving size (fl oz)', ozIn]),
      el('label', { class: 'lbl' }, ['Standard drinks per serving (auto from ABV × oz)', sdIn]),
      el('label', { class: 'lbl' }, ['SKU (optional)', skuIn]),
      el('label', { class: 'lbl' }, ['Menu sort order', sortIn]),
      isNew ? el('label', { class: 'lbl' }, ['Opening stock count', qtyIn]) : null,
      el('label', { class: 'lbl' }, ['Stock unit', unitIn]),
      el('label', { class: 'lbl' }, ['Par level (warn at or below)', parIn]),
      el('label', { class: 'chk' }, [activeIn, 'On the menu']),
    ])],
    actions: [
      { label: 'Cancel', cls: 'ghost' },
      existing ? {
        label: 'Archive', cls: 'danger-ghost',
        onClick: async (close) => {
          await tryReq(window.api.product.archive, { id: existing.id });
          close();
          await refreshProductsCache();
          renderInventory();
          toast('Item archived.', 'ok');
        },
      } : null,
      {
        label: 'Save', cls: 'primary',
        onClick: async (close) => {
          if (!nameIn.value.trim()) { toast('Name is required.', 'warn'); nameIn.focus(); return; }
          const product = {
            id: existing ? existing.id : undefined,
            category: catSel.value,
            name: nameIn.value.trim(),
            brand: brandIn.value.trim(),
            abv: abvIn.value,
            serving_oz: ozIn.value,
            price_cents: centsFromDollars(priceIn.value),
            standard_drinks: sdIn.value,
            sku: skuIn.value.trim(),
            active: activeIn.checked,
            sort_order: num(sortIn.value, 0),
            qty_on_hand: num(qtyIn.value, 0),
            unit: unitIn.value.trim() || 'each',
            par_level: num(parIn.value, 0),
          };
          const res = await tryReq(window.api.product.save, { product });
          if (!res) return;
          if (!isNew) {
            await tryReq(window.api.inventory.meta, {
              productId: existing.id, unit: product.unit, par_level: product.par_level,
            });
          }
          close();
          await refreshProductsCache();
          state.lowStock = await tryReq(window.api.inventory.lowStock) || state.lowStock;
          renderChrome();
          renderInventory();
          toast(isNew ? 'Item added.' : 'Item saved.', 'ok');
        },
      },
    ].filter(Boolean),
    onOpen: () => nameIn.focus(),
  });
}

/* ------------------------------------------------------------------ *
 * Patrons view
 * ------------------------------------------------------------------ */

function wirePatrons() {
  let t = null;
  $('#patronSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(renderPatronTable, 180);
  });
}

async function renderPatronTable() {
  const search = $('#patronSearch').value.trim();
  const rows = await tryReq(window.api.patron.list, { search, limit: 400 });
  if (!rows) return;

  const tbody = $('#patronTable tbody');
  tbody.replaceChildren();

  for (const p of rows) {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: p.label }),
      el('td', { class: 'mono', text: p.dod_id || (p.last4 ? `#${p.last4}` : '—') }),
      el('td', { class: 'num', text: String(round2(p.drinks_today)) }),
      el('td', { text: p.is_banned ? `Barred — ${p.ban_reason || 'no reason'}` : 'OK' }),
      el('td', { text: fmtDateTime(p.last_seen_at) }),
      el('td', { text: fmtDate(p.first_seen_at) }),
      el('td', { text: p.notes || '' }),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn small ghost', text: 'Open',
            onclick: async () => {
              const status = await tryReq(window.api.patron.status, { id: p.id });
              if (!status) return;
              state.patron = status;
              state.scanInfo = { isNew: false };
              setView('bar');
              renderPatronPanel();
              repriceTicket();
            },
          }),
          el('button', {
            class: 'btn small ghost', text: 'Drinks',
            onclick: () => showPatronHistory(p.id),
          }),
          el('button', {
            class: 'btn small ghost', text: 'Edit',
            onclick: () => editPatronDetails(p, async () => {
              await renderPatronTable();
              if (state.patron && state.patron.patron.id === p.id) {
                state.patron = await tryReq(window.api.patron.status, { id: p.id }) || state.patron;
                renderPatronPanel();
              }
            }),
          }),
          el('button', {
            class: 'btn small danger-ghost', text: 'Delete',
            onclick: () => deletePatron(p, renderPatronTable),
          }),
        ]),
      ]),
    ]));
  }

  if (!rows.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: '8' }, [el('p', { class: 'empty', text: 'No patrons yet — scan a card to create one.' })])]));
  }
}

/* ------------------------------------------------------------------ *
 * Reports + export
 * ------------------------------------------------------------------ */

/* ---- date helpers over 'YYYY-MM-DD' ---- */

function shiftDate(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function wireReports() {
  $('#expFrom').value = state.businessDate;
  $('#expTo').value = state.businessDate;
  markQuickRange('today');

  for (const b of $$('#quickRanges .rangebtn')) {
    b.addEventListener('click', () => applyQuickRange(b.dataset.range));
  }
  $('#expFrom').addEventListener('change', () => { markQuickRange(null); loadReport(); });
  $('#expTo').addEventListener('change', () => { markQuickRange(null); loadReport(); });

  for (const b of $$('#chartToggle .segbtn')) {
    b.addEventListener('click', () => {
      for (const o of $$('#chartToggle .segbtn')) o.classList.toggle('active', o === b);
      const asTable = b.dataset.mode === 'table';
      $('#chartWrap').classList.toggle('hidden', asTable);
      $('#salesTableWrap').classList.toggle('hidden', !asTable);
    });
  }

  $('#repPdf').addEventListener('click', async () => {
    const res = await tryReq(window.api.report.pdf, {
      from: $('#expFrom').value, to: $('#expTo').value, open: true,
    });
    if (!res || res.canceled) return;
    showExportResult(`PDF written: ${res.filePath} (${(res.bytes / 1024).toFixed(0)} KB)`);
    toast('Report generated.', 'ok');
  });

  // The chart sizes itself to the panel, so it has to be redrawn when that changes.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (state.view !== 'reports' || !state.report) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderSalesChart(state.report.series), 120);
  });

  $('#expBundle').addEventListener('click', doExportBundle);
  $('#expDb').addEventListener('click', async () => {
    const res = await tryReq(window.api.exporter.backupDb);
    if (!res) return;
    if (res.canceled) return;
    showExportResult(`Database backup written: ${res.filePath} (${(res.bytes / 1024).toFixed(0)} KB)`);
  });
  $('#expReveal').addEventListener('click', () => window.api.exporter.revealData());

  $('#expCsvBtn').addEventListener('click', async () => {
    const name = $('#expReport').value;
    const res = await tryReq(window.api.exporter.csv, {
      name, from: $('#expFrom').value, to: $('#expTo').value,
    });
    if (!res || res.canceled) return;
    showExportResult(`${res.rows} rows written to ${res.filePath}`);
  });

  $('#expPreviewBtn').addEventListener('click', async () => {
    const res = await tryReq(window.api.report.table, {
      name: $('#expReport').value, from: $('#expFrom').value, to: $('#expTo').value,
    });
    if (!res) return;
    renderPreview(res.rows);
  });
}

async function loadReportNames() {
  const sel = $('#expReport');
  if (sel.options.length) return;
  const names = await tryReq(window.api.report.names);
  if (!names) return;
  for (const n of names) {
    sel.appendChild(el('option', { value: n, text: n.replace(/_/g, ' ') }));
  }
}

async function doExportBundle() {
  const res = await tryReq(window.api.exporter.bundle, {
    from: $('#expFrom').value, to: $('#expTo').value,
  });
  if (!res || res.canceled) return;
  const lines = res.written.map((w) => `  ${w.file}${w.rows == null ? '' : ` (${w.rows} rows)`}`).join('\n');
  showExportResult(`Exported to ${res.dirPath}\n${lines}`);
  toast('Export complete.', 'ok');
}

function showExportResult(text) {
  const box = $('#expResult');
  box.className = 'notice ok';
  box.textContent = text;
  box.classList.remove('hidden');
}

function renderPreview(rows) {
  const wrap = $('#expPreviewWrap');
  const table = $('#expPreview');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  thead.replaceChildren();
  tbody.replaceChildren();

  if (!rows.length) {
    wrap.classList.remove('hidden');
    tbody.appendChild(el('tr', {}, [el('td', {}, [el('p', { class: 'empty', text: 'No rows in that date range.' })])]));
    return;
  }

  const cols = Object.keys(rows[0]);
  thead.appendChild(el('tr', {}, cols.map((c) => el('th', { text: c.replace(/_/g, ' ') }))));
  for (const r of rows.slice(0, 200)) {
    tbody.appendChild(el('tr', {}, cols.map((c) => el('td', { text: r[c] == null ? '' : String(r[c]) }))));
  }
  if (rows.length > 200) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: String(cols.length), text: `…and ${rows.length - 200} more rows (the CSV has all of them)` })]));
  }
  wrap.classList.remove('hidden');
}

function applyQuickRange(kind) {
  const today = state.businessDate;
  let from = today, to = today;
  if (kind === '7') from = shiftDate(today, -6);
  else if (kind === '30') from = shiftDate(today, -29);
  else if (kind === 'month') from = `${today.slice(0, 7)}-01`;
  $('#expFrom').value = from;
  $('#expTo').value = to;
  markQuickRange(kind);
  loadReport();
}

function markQuickRange(kind) {
  for (const b of $$('#quickRanges .rangebtn')) {
    b.classList.toggle('active', !!kind && b.dataset.range === kind);
  }
}

function deltaLabel(now, before) {
  if (!before) return { text: 'no prior period to compare', cls: 'flat' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: 'level with previous period', cls: 'flat' };
  return {
    text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous period`,
    cls: pct > 0 ? 'up' : 'down',
  };
}

const hourLabel = (h) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

async function loadReport() {
  let from = $('#expFrom').value || state.businessDate;
  let to = $('#expTo').value || state.businessDate;
  if (from > to) { [from, to] = [to, from]; $('#expFrom').value = from; $('#expTo').value = to; }

  const rep = await tryReq(window.api.report.sales, { from, to });
  if (!rep) return;
  state.report = rep;

  $('#repRangeNote').textContent = rep.span === 1
    ? `One night — ${fmtDate(rep.from)}. Compared against ${fmtDate(rep.previousWindow.from)}.`
    : `${rep.span} days, ${rep.nightsOpen} with sales. Compared against the ` +
      `${rep.span} days before (${fmtDate(rep.previousWindow.from)} – ${fmtDate(rep.previousWindow.to)}).`;
  $('#chartTitle').textContent = rep.span === 1 ? 'Takings for the night' : 'Takings per night';

  // KPI row — the headline numbers are stat tiles, not a chart.
  const cards = [
    { label: 'Gross sales', value: money(rep.totals.gross_cents),
      sub: `${rep.totals.orders} orders`, d: deltaLabel(rep.totals.gross_cents, rep.previous.gross_cents) },
    { label: 'Drinks served', value: String(rep.totals.servings),
      sub: `${round2(rep.totals.drinks)} standard drinks`,
      d: deltaLabel(rep.totals.servings, rep.previous.servings) },
    { label: 'Patrons served', value: String(rep.totals.patrons),
      sub: 'scanned in', d: deltaLabel(rep.totals.patrons, rep.previous.patrons) },
    { label: 'Spend per patron', value: money(rep.avgPerPatron.cents),
      sub: `${round2(rep.avgPerPatron.drinks)} standard drinks each` },
    { label: 'Overrides', value: String(rep.overrides.length),
      sub: `${rep.voids.n} void${rep.voids.n === 1 ? '' : 's'} (${money(rep.voids.cents)})` },
  ];
  const row = $('#repCards');
  row.replaceChildren();
  for (const c of cards) {
    row.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: c.label }),
      el('div', { class: 'stat-value', text: c.value }),
      el('div', { class: 'stat-sub', text: c.sub }),
      c.d ? el('div', { class: `stat-delta ${c.d.cls}`, text: c.d.text }) : null,
    ]));
  }

  renderSalesChart(rep.series);

  fillTable('#salesTable', rep.series, (d) => [
    fmtDate(d.date), d.orders, d.patrons, d.servings, money(d.gross_cents),
  ], [false, true, true, true, true]);

  fillTable('#repCat', rep.byCategory, (c) => [
    CATEGORY_LABELS[c.category] || c.category, c.units, money(c.cents),
  ], [false, true, true]);

  fillTable('#repHour', rep.hourly.filter((h) => h.orders > 0).sort((a, b) => b.cents - a.cents),
    (h) => [hourLabel(h.hour), h.orders, round2(h.drinks), money(h.cents)],
    [false, true, true, true]);

  fillTable('#repTop', rep.topProducts, (p) => [p.product_name, p.units, money(p.cents)],
    [false, true, true]);

  fillTable('#repHeavy', rep.heavyPatrons, (h) => [
    h.label, round2(h.drinks), h.orders, money(h.cents),
  ], [false, true, true, true]);

  fillTable('#repOver', rep.overrides, (o) => [
    fmtDate(o.business_date), o.label, o.override_reason, o.bartender || '—',
  ], [false, false, false, false]);
}

/* ---- the sales chart ----
 * Single series, so one hue and no legend — the heading names what is plotted.
 * Only the best night is labelled; the Table toggle above carries every value,
 * and a tooltip covers the rest on hover or keyboard focus. */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
}

function niceCeiling(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= mag * m) return mag * m;
  }
  return mag * 10;
}

function renderSalesChart(series) {
  const host = $('#salesChart');
  host.replaceChildren();
  $('#chartTip').classList.add('hidden');

  if (!series.length) {
    host.appendChild(el('p', { class: 'empty', text: 'No nights in this range.' }));
    return;
  }

  const PAD_L = 56, PAD_R = 14, PAD_T = 18, PAD_B = 30;
  const SLOT_MIN = 22;
  const plotH = 236 - PAD_T - PAD_B;

  // Fill the panel when the nights fit, and only scroll when they genuinely
  // don't. Width is set in real pixels so viewBox units map 1:1 to CSS px.
  const avail = Math.max(420, ($('#chartWrap').clientWidth || 900) - 2);
  const needed = series.length * SLOT_MIN + PAD_L + PAD_R;
  const W = Math.max(avail, needed);
  const plotW = W - PAD_L - PAD_R;

  const maxCents = Math.max(...series.map((d) => d.gross_cents));
  const top = niceCeiling(maxCents || 100);
  const slot = plotW / series.length;
  const barW = Math.max(3, Math.min(24, slot - 2));      // 24px cap, 2px surface gap
  const peak = series.reduce((a, b) => (b.gross_cents > a.gross_cents ? b : a), series[0]);
  // Emphasis needs something to contrast against — a lone bar is not a "best night".
  const emphasise = series.filter((d) => d.gross_cents > 0).length > 1 && peak.gross_cents > 0;

  const root = svg('svg', { viewBox: `0 0 ${W} 236`, width: W, height: 236, role: 'img' });
  root.setAttribute('aria-label',
    `Takings per night, ${series[0].date} to ${series[series.length - 1].date}`);

  // Solid hairline gridlines, one step off the surface.
  for (const frac of [0, 0.5, 1]) {
    const v = top * frac;
    const y = PAD_T + plotH - frac * plotH;
    root.appendChild(svg('line', {
      x1: PAD_L, y1: y, x2: W - PAD_R, y2: y, class: frac === 0 ? 'zero' : 'grid',
    }));
    const t = svg('text', { x: PAD_L - 8, y: y + 3.5, class: 'tick' });
    t.textContent = `$${Math.round(v / 100)}`;
    root.appendChild(t);
  }

  series.forEach((d, i) => {
    const h = top > 0 ? (d.gross_cents / top) * plotH : 0;
    const x = PAD_L + i * slot + (slot - barW) / 2;
    const y = PAD_T + plotH - h;

    // Hit target spans the whole slot and the full plot height, so hovering
    // never requires landing on a thin bar.
    const hit = svg('rect', {
      x: PAD_L + i * slot, y: PAD_T, width: slot, height: plotH,
      class: 'hit', tabindex: '0', role: 'button',
    });
    hit.setAttribute('aria-label',
      `${d.date}: ${money(d.gross_cents)}, ${d.orders} orders, ${round2(d.drinks)} standard drinks`);
    root.appendChild(hit);

    let path = null;
    if (h > 0) {
      // Rounded data-end, square at the baseline.
      const r = Math.min(4, barW / 2, h);
      path = svg('path', {
        class: `bar${emphasise && d.date === peak.date ? ' peak' : ''}`,
        d: `M${x} ${y + h} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} ` +
           `L${x + barW - r} ${y} Q${x + barW} ${y} ${x + barW} ${y + r} ` +
           `L${x + barW} ${y + h} Z`,
      });
      root.appendChild(path);
    }

    const show = () => showChartTip(d, hit, path);
    const hide = () => $('#chartTip').classList.add('hidden');
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
  });

  // Label the extreme only.
  if (emphasise) {
    const i = series.indexOf(peak);
    const h = (peak.gross_cents / top) * plotH;
    const label = svg('text', {
      x: PAD_L + i * slot + slot / 2,
      y: Math.max(PAD_T + 10, PAD_T + plotH - h - 6),
      class: 'peak-label',
    });
    label.textContent = money(peak.gross_cents);
    root.appendChild(label);
  }

  const every = Math.max(1, Math.ceil(series.length / 12));
  series.forEach((d, i) => {
    if (i % every !== 0 && i !== series.length - 1) return;
    const t = svg('text', { x: PAD_L + i * slot + slot / 2, y: 236 - 10, class: 'xtick' });
    t.textContent = series.length === 1 ? d.date : d.date.slice(5);
    root.appendChild(t);
  });

  host.appendChild(root);
}

/**
 * Anchor the tooltip to the mark it describes. Positions come from real
 * bounding rects rather than viewBox maths, so it stays attached whatever the
 * chart's rendered width or scroll offset.
 */
function showChartTip(d, hit, bar) {
  const tip = $('#chartTip');
  tip.replaceChildren(
    el('div', { class: 'tip-date', text: fmtDate(d.date) }),
    el('div', { class: 'tip-row' }, [el('span', { text: 'Gross' }), el('strong', { text: money(d.gross_cents) })]),
    el('div', { class: 'tip-row' }, [el('span', { text: 'Orders' }), el('strong', { text: String(d.orders) })]),
    el('div', { class: 'tip-row' }, [el('span', { text: 'Patrons' }), el('strong', { text: String(d.patrons) })]),
    el('div', { class: 'tip-row' }, [el('span', { text: 'Std drinks' }), el('strong', { text: String(round2(d.drinks)) })]),
  );
  tip.classList.remove('hidden');

  const wrap = $('#chartWrap');
  const wr = wrap.getBoundingClientRect();
  const anchor = (bar || hit).getBoundingClientRect();
  const hitRect = hit.getBoundingClientRect();

  // Content-box coordinates, because the tooltip is a child of the scroller.
  const cx = anchor.left + anchor.width / 2 - wr.left + wrap.scrollLeft;
  const barTop = (bar ? anchor.top : hitRect.bottom) - wr.top + wrap.scrollTop;

  const half = tip.offsetWidth / 2;
  const minX = wrap.scrollLeft + half + 4;
  const maxX = wrap.scrollLeft + wrap.clientWidth - half - 4;
  tip.style.left = `${Math.min(Math.max(cx, minX), Math.max(minX, maxX))}px`;
  tip.style.top = `${Math.max(tip.offsetHeight + 6, barTop - 6)}px`;
}

function fillTable(sel, rows, mapper, numeric) {
  const tbody = $(`${sel} tbody`);
  tbody.replaceChildren();
  if (!rows.length) {
    const cols = $$(`${sel} thead th`).length || 1;
    tbody.appendChild(el('tr', {}, [el('td', { colspan: String(cols) }, [el('p', { class: 'empty', text: 'Nothing to show.' })])]));
    return;
  }
  for (const r of rows) {
    const cells = mapper(r).map((v, i) =>
      el('td', { class: numeric && numeric[i] ? 'num' : '', text: v == null ? '—' : String(v) }));
    tbody.appendChild(el('tr', {}, cells));
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** Push the current form values back to the database. */
async function saveAdminSettings(flashId) {
  const patch = {
    venue_name: $('#setVenue').value.trim() || 'Drop Zone Tea Party',
    bartender_name: $('#setBartender').value.trim(),
    drink_limit: String(num($('#setLimit').value, 4)),
    limit_beer: String(num($('#setLimitBeer').value, 4)),
    limit_wine: String(num($('#setLimitWine').value, 4)),
    limit_liquor: String(num($('#setLimitLiquor').value, 3)),
    limit_mode: $('#setLimitMode').value,
    day_rollover_hour: $('#setRollover').value,
    min_age: String(num($('#setMinAge').value, 21)),
    block_sale_when_out_of_stock: $('#setBlockStock').checked ? '1' : '0',
    require_pin_for_override: $('#setPinOverride').checked ? '1' : '0',
    require_pin_for_void: $('#setPinVoid').checked ? '1' : '0',
    require_pin_for_admin: $('#setPinAdmin').checked ? '1' : '0',
    store_names: $('#setStoreNames').checked ? '1' : '0',
    pii_retention_days: String(num($('#setRetention').value, 0)),
  };
  const next = await tryReq(window.api.settings.save, { patch });
  if (!next) return;
  state.settings = next;

  renderChrome();
  $('#limitNum').textContent = String(round2(num(next.drink_limit, 3)));

  // A limit change has to reach the patron on screen and the open ticket.
  if (state.patron) {
    state.patron = await tryReq(window.api.patron.status, { id: state.patron.patron.id }) || state.patron;
    renderPatronPanel();
  }
  await repriceTicket();

  const flash = $(flashId || '#setSaved');
  if (flash) {
    flash.classList.remove('hidden');
    setTimeout(() => flash.classList.add('hidden'), 1600);
  }
  toast('Saved.', 'ok');
}

function wireAdmin() {
  const roll = $('#setRollover');
  for (let h = 0; h < 24; h++) {
    const label = h === 0 ? 'Midnight' : h < 12 ? `${h}:00 AM` : h === 12 ? 'Noon' : `${h - 12}:00 PM`;
    roll.appendChild(el('option', { value: String(h), text: label }));
  }

  // --- unlock ---
  const tryUnlock = async () => {
    const pin = $('#adminPin').value;
    if (!pin) { toast('Enter the manager PIN.', 'warn'); return; }
    const res = await tryReq(window.api.settings.verifyPin, { pin });
    if (!res) return;
    if (!res.valid) { toast('Incorrect PIN.', 'err'); $('#adminPin').value = ''; $('#adminPin').focus(); return; }
    state.adminUnlocked = true;
    $('#adminPin').value = '';
    renderAdmin();
  };
  $('#adminUnlock').addEventListener('click', tryUnlock);
  $('#adminPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  // --- the drink limit dial and the category caps ---
  const limitInput = $('#setLimit');
  const syncDial = () => {
    $('#limitNum').textContent = String(num(limitInput.value, 0));
    updateLimitExplain();
  };
  limitInput.addEventListener('input', syncDial);
  $('#limitUp').addEventListener('click', () => {
    limitInput.value = String(num(limitInput.value, 0) + 1);
    syncDial();
  });
  $('#limitDown').addEventListener('click', () => {
    limitInput.value = String(Math.max(0, num(limitInput.value, 0) - 1));
    syncDial();
  });
  for (const id of ['#setLimitBeer', '#setLimitWine', '#setLimitLiquor']) {
    $(id).addEventListener('input', updateLimitExplain);
  }
  $('#saveLimits').addEventListener('click', () => saveAdminSettings('#limitSaved'));

  // --- pricing ---
  $('#bulkPriceBtn2').addEventListener('click', openBulkPrice);
  $('#goInventory').addEventListener('click', () => setView('inventory'));

  const save = () => saveAdminSettings('#setSaved');
  $('#saveSettings').addEventListener('click', save);
  $('#saveSettings2').addEventListener('click', save);

  $('#savePin').addEventListener('click', async () => {
    const currentPin = $('#pinCurrent').value;
    const newPin = $('#pinNew').value;
    const res = await tryReq(window.api.settings.setPin, { currentPin, newPin });
    if (!res) return;
    $('#pinCurrent').value = '';
    $('#pinNew').value = '';
    $('#pinDefaultWarn').classList.add('hidden');
    toast('Manager PIN changed.', 'ok');
  });

  $('#purgeNow').addEventListener('click', async () => {
    const got = await askManager({
      title: 'Run retention purge',
      message: 'Clears names and dates of birth for patrons not seen inside the retention window. Drink history and totals are kept.',
      confirmLabel: 'Purge Now',
      confirmCls: 'danger',
    });
    if (!got) return;
    const res = await tryReq(window.api.settings.purgePii, { pin: got.pin });
    if (!res) return;
    toast(res.days ? `${res.purged} patron records cleared.` : 'Retention is set to keep everything (0 days).', 'ok', 3600);
  });

  $('#revealData2').addEventListener('click', () => window.api.exporter.revealData());

  // --- backups ---
  $('#backupChoose').addEventListener('click', async () => {
    const res = await tryReq(window.api.backup.chooseDir);
    if (!res || res.canceled) return;
    await renderBackups();
    toast(res.first && res.first.filePath
      ? 'Folder set and a first copy taken.'
      : 'Folder set.', 'ok');
  });
  $('#backupNow').addEventListener('click', async () => {
    const res = await tryReq(window.api.backup.now);
    if (!res) return;
    await renderBackups();
    if (res.filePath) toast(`Backed up (${(res.bytes / 1048576).toFixed(1)} MB).`, 'ok');
    else toast(backupSkipReason(res.skipped, res.error), 'warn', 5000);
  });
  $('#backupOpen').addEventListener('click', () => window.api.backup.openDir());
  $('#backupEnabled').addEventListener('change', async () => {
    await tryReq(window.api.settings.save, {
      patch: { backup_enabled: $('#backupEnabled').checked ? '1' : '0' },
    });
    state.settings = await tryReq(window.api.settings.all) || state.settings;
    await renderBackups();
  });
  $('#backupKeep').addEventListener('change', async () => {
    await tryReq(window.api.settings.save, {
      patch: { backup_keep: String(Math.max(1, num($('#backupKeep').value, 30))) },
    });
    state.settings = await tryReq(window.api.settings.all) || state.settings;
    await renderBackups();
  });

  wireCalibration();
}

function renderAdmin() {
  const locked = !state.adminUnlocked && state.settings.require_pin_for_admin === '1';
  $('#adminLock').classList.toggle('hidden', !locked);
  $('#adminBody').classList.toggle('hidden', locked);

  if (locked) {
    $('#adminPin').value = '';
    setTimeout(() => $('#adminPin').focus(), 30);
    return;
  }

  const s = state.settings;
  $('#setVenue').value = s.venue_name || '';
  $('#setBartender').value = s.bartender_name || '';
  $('#setLimit').value = s.drink_limit || '4';
  $('#setLimitBeer').value = s.limit_beer || '4';
  $('#setLimitWine').value = s.limit_wine || '4';
  $('#setLimitLiquor').value = s.limit_liquor || '3';
  $('#limitNum').textContent = String(num(s.drink_limit, 4));
  updateLimitExplain();
  $('#setLimitMode').value = s.limit_mode || 'block';
  $('#setRollover').value = s.day_rollover_hour || '6';
  $('#setMinAge').value = s.min_age || '21';
  $('#setBlockStock').checked = s.block_sale_when_out_of_stock === '1';
  $('#setPinOverride').checked = s.require_pin_for_override === '1';
  $('#setPinVoid').checked = s.require_pin_for_void === '1';
  $('#setPinAdmin').checked = s.require_pin_for_admin === '1';
  $('#setStoreNames').checked = s.store_names === '1';
  $('#setRetention').value = s.pii_retention_days || '0';
  $('#dbPathHint').textContent = `Database: ${state.dbPath}`;
  renderPriceSummary();
  renderBackups();
  loadCalibration();
}

function backupSkipReason(skipped, error) {
  if (skipped === 'no-folder') return 'No backup folder chosen yet.';
  if (skipped === 'unreachable') return 'The backup folder is not reachable — is the drive plugged in?';
  if (skipped === 'disabled') return 'Automatic backups are switched off.';
  if (skipped === 'error') return `Backup failed: ${error}`;
  return 'Backup did not run.';
}

async function renderBackups() {
  const s = await tryReq(window.api.backup.status);
  const box = $('#backupStatus');
  if (!s) { box.textContent = 'Could not read backup status.'; return; }

  $('#backupEnabled').checked = s.enabled;
  $('#backupKeep').value = String(s.keep);

  if (!s.configured) {
    box.className = 'notice warn';
    box.textContent = 'No backup folder chosen — nothing is being backed up. '
      + 'Choose a folder on a USB stick or a shared drive to start.';
  } else if (!s.reachable) {
    box.className = 'notice warn';
    box.textContent = `Backup folder is not reachable: ${s.dir}\n`
      + 'If that is a removable drive, plug it in. Backups are being skipped until then.';
  } else if (!s.enabled) {
    box.className = 'notice warn';
    box.textContent = `Automatic backups are switched off. Folder: ${s.dir}`;
  } else {
    box.className = 'notice ok';
    box.textContent = `Backing up to ${s.dir}\n`
      + `${s.count} cop${s.count === 1 ? 'y' : 'ies'} kept`
      + (s.lastAt ? ` · last ${fmtDateTime(s.lastAt)}` : ' · none taken yet')
      + (s.due ? ' · one is due' : '');
  }

  const list = $('#backupList');
  list.replaceChildren();
  for (const b of s.recent || []) {
    list.appendChild(el('div', { class: 'backup-row' }, [
      el('span', { class: 'mono', text: b.name }),
      el('span', { text: `${(b.bytes / 1048576).toFixed(1)} MB` }),
      el('span', { class: 'backup-when', text: fmtDateTime(b.at) }),
    ]));
  }
}

/**
 * Spell the policy back out in plain English. Four numbers interact here and
 * it is easy to set a category cap that can never actually bind.
 */
function updateLimitExplain() {
  const total = num($('#setLimit').value, 4);
  const caps = [
    ['beer', num($('#setLimitBeer').value, 4)],
    ['wine', num($('#setLimitWine').value, 4)],
    ['liquor', num($('#setLimitLiquor').value, 3)],
  ];
  const binding = caps.filter(([, c]) => c < total);
  const loose = caps.filter(([, c]) => c >= total).map(([n]) => n);

  let text = `In practice: ${total} drink${total === 1 ? '' : 's'} a night per patron`;
  if (binding.length) {
    text += `, with no more than ${binding.map(([n, c]) => `${c} ${n}`).join(' or ')}`;
  }
  text += '.';
  if (loose.length) {
    const joined = loose.length === 1
      ? loose[0]
      : `${loose.slice(0, -1).join(', ')} and ${loose[loose.length - 1]}`;
    const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
    text += ` ${sentence} ${loose.length === 1 ? 'is' : 'are'} capped only by the night total.`;
  }
  $('#limitExplain').textContent = text;
}

/** Current price per category, so a manager can see the menu at a glance. */
function renderPriceSummary() {
  const row = $('#priceSummary');
  row.replaceChildren();
  for (const c of availableCategories()) {
    const items = state.products.filter((p) => p.category === c);
    if (!items.length) continue;
    const prices = items.map((p) => p.price_cents);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    row.appendChild(el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label', text: CATEGORY_LABELS[c] || c }),
      el('div', { class: 'stat-value', text: lo === hi ? money(lo) : `${money(lo)}–${money(hi)}` }),
      el('div', { class: 'stat-sub', text: `${items.length} item${items.length === 1 ? '' : 's'}` }),
    ]));
  }
}

/* ---- bulk re-pricing ---- */

function openBulkPrice() {
  const catSel = el('select', { class: 'input' }, [
    el('option', { value: 'all', text: 'Every item on the menu' }),
    ...availableCategories().map((c) => el('option', { value: c, text: CATEGORY_LABELS[c] || c })),
  ]);
  const modeSel = el('select', { class: 'input' }, [
    el('option', { value: 'set', text: 'Set every price to' }),
    el('option', { value: 'add', text: 'Change every price by (dollars, use − to cut)' }),
    el('option', { value: 'percent', text: 'Change every price by (percent)' }),
  ]);
  const amountIn = el('input', { class: 'input', type: 'number', step: '0.25', value: '5.00' });
  const pinIn = el('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'Manager PIN' });
  const preview = el('div', { class: 'notice' });

  // Mirror of the server-side maths, so the manager sees the result first.
  const nextPrice = (cur) => {
    const mode = modeSel.value;
    if (mode === 'add') return Math.max(0, cur + centsFromDollars(amountIn.value));
    if (mode === 'percent') return Math.max(0, Math.round(cur * (1 + num(amountIn.value, 0) / 100)));
    return Math.max(0, centsFromDollars(amountIn.value));
  };

  const affected = () => state.products.filter((p) =>
    catSel.value === 'all' ? true : p.category === catSel.value);

  const updatePreview = () => {
    amountIn.step = modeSel.value === 'percent' ? '1' : '0.25';
    const items = affected();
    const changes = items
      .map((p) => ({ name: p.name, from: p.price_cents, to: nextPrice(p.price_cents) }))
      .filter((c) => c.to !== c.from);

    if (!changes.length) {
      preview.className = 'notice';
      preview.textContent = `No change — those ${items.length} items are already at that price.`;
      return;
    }
    preview.className = 'notice ok';
    const shown = changes.slice(0, 6)
      .map((c) => `  ${c.name}: ${money(c.from)} → ${money(c.to)}`).join('\n');
    preview.textContent = `${changes.length} of ${items.length} items change:\n${shown}` +
      (changes.length > 6 ? `\n  …and ${changes.length - 6} more` : '');
  };

  for (const control of [catSel, modeSel, amountIn]) {
    control.addEventListener('input', updatePreview);
    control.addEventListener('change', updatePreview);
  }

  openModal({
    title: 'Re-price a Category',
    body: [
      el('div', { class: 'form' }, [
        el('label', { class: 'lbl' }, ['Apply to', catSel]),
        el('label', { class: 'lbl' }, ['How', modeSel]),
        el('label', { class: 'lbl' }, ['Amount', amountIn]),
      ]),
      preview,
      state.settings.require_pin_for_admin === '1'
        ? el('div', { class: 'form' }, [el('label', { class: 'lbl' }, ['Manager PIN', pinIn])])
        : null,
    ],
    actions: [
      { label: 'Cancel', cls: 'ghost' },
      {
        label: 'Apply', cls: 'primary',
        onClick: async (close) => {
          const amount = modeSel.value === 'percent'
            ? num(amountIn.value, 0)
            : centsFromDollars(amountIn.value);
          const res = await tryReq(window.api.product.bulkPrice, {
            category: catSel.value, mode: modeSel.value, amount,
            actor: state.settings.bartender_name || null, pin: pinIn.value,
          });
          if (!res) return;
          close();
          await refreshProductsCache();
          renderPriceSummary();
          if (state.view === 'inventory') renderInventory();
          await repriceTicket();
          toast(res.changed ? `${res.changed} prices updated.` : 'Nothing needed changing.', 'ok');
        },
      },
    ],
    onOpen: () => { updatePreview(); amountIn.focus(); amountIn.select(); },
  });
}

/* ---- card layout calibration ---- */

const CAL_FIELDS = ['name', 'edipi', 'dob'];

function calRow(field) { return $(`.cal-table tr[data-field="${field}"]`); }

function wireCalibration() {
  const raw = $('#calRaw');
  raw.addEventListener('input', updateCalibration);

  for (const f of CAL_FIELDS) {
    const row = calRow(f);
    for (const sel of ['.cal-start', '.cal-len', '.cal-enc']) {
      $(sel, row).addEventListener('input', updateCalibration);
      $(sel, row).addEventListener('change', updateCalibration);
    }
  }

  // Auto-detect: find a known DoD ID inside a scanned payload and fill the
  // offsets in, rather than making anyone count characters.
  $('#calDetect').addEventListener('click', async () => {
    const raw = $('#calRaw').value.trim();
    const knownId = $('#calKnownId').value.trim();
    const box = $('#calDetectResult');
    box.classList.remove('hidden');

    if (!raw) { box.className = 'notice warn'; box.textContent = 'Scan a card into the box above first.'; return; }
    if (!/^\d{9,10}$/.test(knownId.replace(/\D/g, ''))) {
      box.className = 'notice warn';
      box.textContent = 'Enter the full customer ID from the front of that same card (9 or 10 digits).';
      return;
    }

    const res = await tryReq(window.api.layout.deduce, { raw, knownId });
    if (!res) return;
    const hits = res.candidates || [];

    if (!hits.length) {
      box.className = 'notice warn';
      box.textContent = 'That ID is not in this scan in any form we recognise. '
        + 'Check the ID matches the card you scanned. If it does, this card '
        + 'generation packs the ID differently — scanning still works and drink '
        + 'tracking is unaffected, you just will not see the ID on screen.';
      return;
    }

    const best = hits[0];
    const row = calRow('edipi');
    $('.cal-start', row).value = String(best.start);
    $('.cal-len', row).value = String(best.len);
    $('.cal-enc', row).value = best.encoding;
    await updateCalibration();

    box.className = 'notice ok';
    box.textContent = `Found it at character ${best.start}, ${best.len} long `
      + `(${best.encoding === 'int' ? 'plain digits' : 'base32'}).`
      + (hits.length > 1
        ? ` ${hits.length - 1} other spot${hits.length === 2 ? '' : 's'} also matched — `
          + 'try a second card to be certain, then Save Layout.'
        : ' Press Save Layout to keep it.');
  });

  $('#calSave').addEventListener('click', async () => {
    const fields = {};
    for (const f of CAL_FIELDS) {
      const row = calRow(f);
      const len = num($('.cal-len', row).value, 0);
      if (len > 0) {
        fields[f] = {
          start: num($('.cal-start', row).value, 0),
          len,
          encoding: $('.cal-enc', row).value,
        };
      }
    }
    if (!Object.keys(fields).length) { toast('Set a length on at least one field first.', 'warn'); return; }
    const res = await tryReq(window.api.layout.save, { layout: { version: 1, fields } });
    if (!res) return;
    state.layoutCalibrated = true;
    $('#calStatus').textContent = 'Layout saved. New scans will fill these fields automatically.';
    toast('Card layout saved.', 'ok');
  });

  $('#calClear').addEventListener('click', async () => {
    await tryReq(window.api.layout.save, { layout: null });
    state.layoutCalibrated = false;
    for (const f of CAL_FIELDS) {
      const row = calRow(f);
      $('.cal-start', row).value = '';
      $('.cal-len', row).value = '';
    }
    updateCalibration();
    $('#calStatus').textContent = 'Layout cleared — back to pattern guessing.';
    toast('Layout cleared.', 'ok');
  });
}

async function loadCalibration() {
  const res = await tryReq(window.api.layout.get);
  const layout = res && res.layout;
  if (!layout || !layout.fields) {
    $('#calStatus').textContent = 'No layout saved. Names are guessed from the scan, or typed once per patron.';
    return;
  }
  for (const f of CAL_FIELDS) {
    const spec = layout.fields[f];
    const row = calRow(f);
    $('.cal-start', row).value = spec ? String(spec.start) : '';
    $('.cal-len', row).value = spec ? String(spec.len) : '';
    if (spec && spec.encoding) $('.cal-enc', row).value = spec.encoding;
  }
  $('#calStatus').textContent = 'Layout saved and active.';
  updateCalibration();
}

async function updateCalibration() {
  const raw = $('#calRaw').value.trim();

  // Highlight the selected slices over the raw payload.
  const strip = $('#calStrip');
  strip.replaceChildren();
  if (raw) {
    const marks = new Array(raw.length).fill(null);
    for (const f of CAL_FIELDS) {
      const row = calRow(f);
      const start = num($('.cal-start', row).value, -1);
      const len = num($('.cal-len', row).value, 0);
      if (start < 0 || len <= 0) continue;
      for (let i = start; i < Math.min(raw.length, start + len); i++) marks[i] = f;
    }
    for (let i = 0; i < raw.length; i++) {
      strip.appendChild(el('span', { class: `ch ${marks[i] || ''}`, text: raw[i] }));
    }
    strip.appendChild(el('div', { class: 'prod-meta', text: `${raw.length} characters` }));
  } else {
    strip.textContent = 'Scan a card with the box above focused to see its payload here.';
  }

  for (const f of CAL_FIELDS) {
    const row = calRow(f);
    const out = $('.cal-out', row);
    const start = num($('.cal-start', row).value, -1);
    const len = num($('.cal-len', row).value, 0);
    if (!raw || start < 0 || len <= 0) { out.textContent = '—'; continue; }

    const res = await tryReq(window.api.layout.preview, { raw, start, len });
    if (!res) { out.textContent = '—'; continue; }
    const enc = $('.cal-enc', row).value;
    const picked = enc === 'ascii' ? res.ascii
      : enc === 'int' ? res.int
      : enc === 'base32-int' ? res.base32Int
      : enc === 'base32-jdn' ? res.base32Jdn
      : enc === 'yyyymmdd' ? res.yyyymmdd
      : res.slice;
    out.textContent = picked || `(no match) raw: ${res.slice}`;
  }
}

/* ------------------------------------------------------------------ */

boot();
