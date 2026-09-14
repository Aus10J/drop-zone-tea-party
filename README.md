# Drop Zone Tea Party

Offline point-of-sale, CAC drink tracking, and inventory for the bar.
Runs entirely on one Windows machine. No network, no cloud, no accounts.

Everything lives in one SQLite file you can copy to a thumb drive.

---

## What it does

| | |
|---|---|
| **Scan** | CAC (or driver's licence, or typed DoD ID) identifies the patron in about a second. Every sale is tied to a card |
| **Track** | Running drink count per patron per night — a night total plus a cap per category |
| **Enforce** | At any cap the sale blocks until a manager PIN + written reason is entered — and the override is logged with which cap was broken |
| **Sell** | Tap a category, tap a drink, done. Card only. The screen resets for the next customer on every sale |
| **Price** | Edit any price inline, or re-price a whole category at once. Every change is logged with its old value |
| **Stock** | Live inventory that decrements on every sale, with editable counts and a full adjustment audit trail |
| **Track sales** | Every sale recorded with items, prices, payment method, bartender and time |
| **Report** | Any date range: takings per night, trend vs the period before, top sellers, busiest hours, heaviest consumption, every override |
| **Export** | One button writes every report as CSV plus a complete `.db` copy — or a formatted PDF |

---

## Hardware you need

**A PDF417-capable 2D barcode scanner in keyboard-wedge (HID) mode.**

Any USB 2D imager works — the cheap ones are fine. It must be able to read
PDF417 (the big rectangular barcode on the back of a CAC), not just 1D UPC
barcodes. In keyboard-wedge mode the scanner just types the barcode contents
and presses Enter, so the app needs no drivers at all.

The app watches for a fast burst of keystrokes ending in Enter. You do not
need to click into a box first — just scan.

**No scanner needed.** The box under the scan prompt is a **lookup** that takes
anything — a surname, part of a DoD ID, a last four, or a full ID. Letters are
fine; nothing has to be numeric.

- **One match** → loads them.
- **Several** → a picker showing name, ID, drinks tonight and last visit.
- **None** → offers to add them, with **First name / Last name / DoD ID**
  fields and whatever you typed already filled in (a word lands in Last name,
  digits in DoD ID). A last name on its own is enough; **the DoD ID is
  optional**. Because it asks rather than creating silently, a typo is caught
  before it becomes a duplicate.

A card scanned into that box is unambiguous, so it is created without asking.

**Adding the DoD ID is worth it when you have it.** Identity keys off the ID,
so a patron added by ID is found again when their card is later scanned. Added
by name only, they are found by searching the name — a subsequent card scan
would otherwise create a second record. You can attach an ID at any time from
**Edit details**, which also fixes patrons whose barcode never yielded one.

---

## Install

Copy **`Drop Zone Tea Party Setup 1.0.0.exe`** to the bar machine and run it.

It installs **per-user, so it does not need admin rights** — useful on a
locked-down government machine.

If installers are blocked entirely, use **`DropZoneTeaParty-portable-1.0.0.exe`**
instead. That is a single self-contained file that installs nothing; it can run
from a folder or a USB stick.

---

## First-run checklist

1. **Admin → change the manager PIN.** It ships as `1234` and the app nags you
   until you change it. This PIN gates the whole Admin section, overrides, and
   voids — so it should be a manager's, not something taped to the register.
2. **Admin → Sales Limits.** Set the night total, the per-category caps, and
   what happens when someone reaches one. Set the hour the night rolls over —
   defaults to 0600, so a drink poured at 0100 counts against the night before.
3. **Inventory → count your stock in and check prices.** The menu from the
   weekend board is already loaded — 5 beers at $5, 6 spirits at $6, 3 wines at
   $7, with correct ABVs. Type your real counts into the *On hand* column.
4. **Bar → Open Shift** at the start of each night, **Close Shift** at the end.
   Closing prints the night summary and offers a one-click export.

---

## The Admin section

Everything a bartender should not casually change lives behind the manager PIN:
limits, pricing, privacy controls, and card calibration. It stays unlocked for
the rest of the session once entered, and re-locks when the app restarts. You
can turn the lock off in **Admin → Venue & Service** if it gets in the way.

### Sales limits

There is a **night total** and a **cap per category underneath it**. Whichever
runs out first is the one that binds. Defaults:

| Cap | Default |
|---|---|
| Night total | **4** |
| Beer | 4 |
| Wine | 4 |
| Liquor | **3** |

So a patron can have four beers, or three liquors and a beer — but never a
fourth liquor, even though four drinks is within their night total. Beer and
wine are set to the total by default, meaning they add no restriction beyond
it; lower either one to make it bite. Admin spells the resulting policy back to
you in plain English as you change the numbers, which catches caps that can
never actually apply.

**Counting is in drinks served, not ABV-weighted units.** One pour is one
drink, whether it is the 4.6% Tuborg or the 7% Kaiju IPA. That is what a
bartender can explain across the bar. Standard drinks are still calculated and
reported — they just do not gate the sale.

Category mapping: beer → beer, wine → wine, spirits **and cocktails** → liquor.

- Under every cap → sells normally.
- Over one → the Complete Sale button turns amber and names the cap that
  bound (**Liquor Limit — Manager Override**, not just "over limit"). It
  demands a PIN and a typed reason, both recorded against the order and in the
  audit log, which also records which cap was broken and by how much.
- Someone cut off on liquor can still buy a beer if they have night total left.
- Voiding an order gives the drinks back on both the night total and the
  category count, and restores the stock.

**The menu is alcohol only.** There are no soft drinks, coffee or water on it,
so a patron who has reached their night total cannot be sold anything at all
until the rollover, and a patron under the minimum age cannot be sold anything
at any time. If you ever want a cut-off patron to be able to buy a Coke, add a
zero-ABV item — the counting keys off alcohol content rather than the category
name, so anything at 0% is automatically exempt from every cap.

The patron panel shows the night total as pips plus a small meter per category,
so the bartender can see which cap is about to bind before they pour. Both move
live as items go on the ticket.

Three behaviours are available: *stop the sale* (default), *warn but allow*, or
*track silently*. Age is checked too when a date of birth is on file, and it
blocks alcohol only.

### When the counts reset

**Every count — the night total and all three category caps — resets at the
rollover hour**, which defaults to **0600**. Nothing has to be pressed and no
end-of-night routine has to be run for it to happen. A patron cut off at 0100
on Saturday morning walks in Saturday evening with a clean slate; a drink
poured at 0100 still counts against Friday night, which is the point of the
rollover hour being 0600 rather than midnight.

Counts are scoped to the business date in the database itself, so the reset is
a property of how the data is stored rather than a scheduled job that could
fail to run. Set the rollover to Midnight if you want the business day to match
the calendar day.

The POS does not need to be restarted, and usually isn't — bars leave it
running. A watcher notices the date turn over and refreshes the window, so the
bartender sees the new date and cleared counts rather than yesterday's numbers.
It also closes out any shift still open from the previous night, so shift
totals never span two business days, and does the same on launch if the app was
closed over the rollover.

Nothing is deleted. Yesterday's drinks stay on the record and in every report —
they just stop counting against tonight.

### Payment

**Card only.** Payment itself is handled on a separate terminal, so the POS
records the sale and the drink count rather than taking money. There is no
tender selector on the ticket. The `payment_method` column still exists in the
database and every row records `card`, so adding cash back later is a small
change rather than a migration.

---

## Changing prices

Two ways, both in reach mid-shift:

**One item** — go to Inventory, click the price, type the new one, press Enter.
It saves instantly and the menu button updates. You can tab straight down the
column re-pricing as you go; the table deliberately does not redraw under you.

**A whole category** — **Re-price a Category** (in Inventory, or in Admin →
Pricing). Pick a category or the whole menu, then either set a flat price,
shift every price by a dollar amount, or move everything by a percentage. It
shows you exactly which items change and what they go from and to *before* you
commit.

Every price change — single or bulk — is written to the audit log with the old
value, the new value, and who did it. Prices can never go negative.

---

## How CAC scanning works — read this part

**Scanning never asks the bartender for anything.** Card goes under the
scanner, the patron record appears, counting starts. There is no prompt, no
name to type, no confirmation step. The first scan of a new card is exactly as
fast as the thousandth scan of a regular.

What gets stored is the identifier as read:

- **The DoD ID**, when the scan yields one — a typed or scanned 10-digit ID, or
  one decoded out of the barcode. The patron then shows as `DoD 1234567890`.
- **The raw barcode payload**, always. Where no ID could be parsed, the patron
  shows as `Card …AB12` from the tail of that payload, which is still a stable,
  unique, sayable handle.

A `card_hash` column is also kept — an HMAC of the payload — because it is
fixed-width and uniquely indexed, so it stays the internal lookup key. It never
leaves the database and appears in no export or report.

If the barcode happens to yield a name or date of birth, those are stored
automatically too; nothing is asked for. A name can be added or corrected later
from **Edit details** on the Bar screen, and the age check switches on by
itself once a date of birth is on file.

### Why a scan looks like nonsense

A CAC's barcode does **not** carry the DoD ID as readable text. It is a
fixed-width packed payload, so scanning one produces a jumble of letters and
digits. That is normal and the app is built for it: identity comes from a hash
of the whole payload, so scanning works perfectly and the same card always
finds the same patron. The DoD ID simply is not visible until the app is told
where in that jumble it sits.

**Admin → Card Layout Calibration → "Find the DoD ID for me"** does that for
you. Scan your own card into the box, type your own DoD ID, press **Find It**,
and it searches the payload for any slice that decodes to that ID — plain
digits or base32 — and fills in the offsets. Press **Save Layout** and every
card of that generation decodes from then on.

Worth doing with a **second card** before trusting it: a single card can throw
up a coincidental match, and the tool tells you when more than one spot
matched. Two cards agreeing on the same offset is conclusive.

Once saved, returning patrons pick up their DoD ID automatically the next time
they scan — existing records are backfilled, not orphaned. Names and dates of
birth can be mapped the same way with the manual offset fields.

The reason it works this way rather than hardcoding byte offsets: the DoD
PDF417 layout is fixed-width but **versioned**, and the offsets differ between
card generations. Guessing them in code would silently produce garbage names on
the cards you actually have. Calibrating against a real card in your hand takes
minutes and is correct by construction.

Driver's licences (AAMVA format) are also parsed, for dependants and guests
without a CAC.

---

## What is stored

Worth being explicit, since this runs on an installation and holds records
about service members.

**Stored:** the DoD ID where the scan yields one, the raw barcode payload, a
salted hash of that payload (the internal lookup key), optionally a name and
date of birth if the card yields them or someone types them, and the
drink/purchase history.

**Never stored:** the manager PIN in plaintext — it is scrypt-hashed — or
anything off the card's chip. Only the barcode is ever read.

This is a deliberate change from an earlier design that kept only a hash. The
identifier is retained so the bartender and the reports have something
human-readable to work with, which is the point of a drink-limit log. It does
mean the database and its exports contain personal identifiers.

Two controls in **Admin → Privacy & Records**:

- **Store patron names — off.** No names are kept at all; patrons show by DoD
  ID or card reference. Limits and counts work exactly the same.
- **Retention.** Automatically clear names and dates of birth for anyone not
  seen in *N* days. Drink history and totals survive. Runs at every launch and
  on demand.

Exports include the DoD ID, since that is the identifier the reports are keyed
on. The `card_hash` is internal and appears in no export or report.

Whoever owns the machine and the installation's information-assurance folks
should sign off before it goes live — that call is above this README.

---

## Managing patrons

The **Patrons** tab lists everyone on file with their DoD ID, what they have
had tonight, and when they were last in. **Anyone already drinking tonight
sorts to the top**, since mid-service that is almost always who is being looked
for.

Search matches names, full DoD IDs, the **last four** of an ID, notes, and the
tail of a raw card payload for cards whose ID could not be parsed. The last
four is derived from the stored ID automatically — nobody has to type it. Each
row has three actions:

- **Open** loads them at the bar, as though their card had just been scanned.
- **Drinks** opens their history — every order, every night, with each drink
  removable (see below).
- **Edit** adds or corrects first name, last name, DoD ID, date of birth and
  notes. Setting a date of birth switches the age check on for that person.
- **Delete** removes them, after a manager PIN.

Names are stored as **first and last separately**, so a surname search matches
properly and surnames rank above other hits. Existing records created before
this were split automatically on upgrade.

### Removing a drink after the fact

**Patrons → Drinks** lists every order with its individual drinks. Each has a
**Remove** button (**Remove one** where the same drink was rung up more than
once), plus **Void whole order** for cancelling the lot. Removing a drink:

- puts that unit back into stock,
- takes it off the patron's count for **the night it was sold**, not today,
- recomputes the order's total so the takings still reconcile,
- and voids the order outright if nothing is left on it.

It needs a reason and the manager PIN, and both land in the audit log. Tonight's
last few orders can also be voided straight from **Recent** on the Bar screen,
and **Undo Last Sale** on that screen reverses the most recent sale in one tap —
for the wrong-button case, which needs to be quick.

**Deleting keeps their sales.** The drinks were poured and the money was taken,
so the orders are detached rather than destroyed — the person disappears, the
night's takings do not move, and the reports stay consistent with the till. The
confirmation tells you exactly how many orders and how much money are involved
before you commit, and the deletion is written to the audit log. It cannot be
undone.

---

## Sales tracking and reports

Every completed sale is stored with its line items, unit prices, payment
method, bartender, timestamp and business date — so the reporting is just a
view over what actually happened at the till, not a separate tally anyone has
to keep.

The **Reports** tab has one date-range control at the top that scopes
everything below it, with quick buttons for *Tonight*, *Last 7*, *Last 30* and
*This month*. Set the range and the whole page — figures, chart, tables and
exports — follows it.

What you get:

- **Headline figures** with a comparison against the equal-length period
  immediately before (last 7 nights vs the 7 before that, and so on): gross
  sales, standard drinks poured, patrons served, spend per patron, overrides
  and voids.
- **Takings per night** as a column chart. Every date in the range gets a
  column, including nights you were closed, so the time axis never silently
  compresses and flatters a quiet stretch. The best night is highlighted and
  labelled; hovering or tabbing to any column gives the full figures. A
  **Table** toggle shows the same data as numbers.
- **Breakdowns**: by category, by payment method, busiest hours of the night,
  top sellers, highest-consumption patrons, and every limit override.

### Closing out at the end of a shift

**Bar → Close Shift** asks for the manager PIN, closes the till and shows the
night's summary — orders, gross, drinks served, patrons, overrides and voids,
broken down by category. Two buttons on that summary export the night directly,
both scoped to the business date just closed:

- **Export CSV + Database** — the full bundle: every report as CSV plus a
  complete `.db` copy, written to a folder or drive you pick.
- **PDF Report** — the formatted one-document version, which opens when it's
  done.

Neither closes the summary, so you can take both. The same exports are always
available from **Reports** for any date range if you miss them on the night, or
want a week or a month at once.

### Generating a report

**Generate PDF Report** produces a formatted, paginated document for the date
range — headline figures, the chart, a night-by-night table, category and
payment splits, top sellers, averages, and the override log. It opens when it
is finished. This is the one to hand to leadership or put in a continuity
binder; it needs no software beyond a PDF reader.

The shift-close summary also offers a one-click export of the night just
finished.

## Exporting

**Reports → Export Everything** asks for a folder and writes:

- `orders.csv`, `line_items.csv`, `patron_drinks_by_day.csv`, `daily_totals.csv`,
  `product_mix.csv`, `inventory_on_hand.csv`, `inventory_adjustments.csv`,
  `shifts.csv`, `audit_log.csv`
- `bar.db` — a complete SQLite database
- `README.txt` describing the contents

CSVs are UTF-8 with a BOM so Excel on Windows opens them correctly, and every
`*_cents` column has a matching `*_usd` column in dollars.

`bar.db` is the one to hand to whoever needs the data downstream. It opens in
DB Browser for SQLite, Power BI, Python, R, or anything that speaks SQLite —
no conversion needed. **Database Backup (.db)** writes the same thing on its
own; it uses SQLite's `VACUUM INTO`, so it is always a consistent snapshot even
mid-service.

The live database sits in `%APPDATA%\Drop Zone Tea Party\data\bar.db`. **Open
Data Folder** jumps straight there. Copying that file while the app is closed
is a perfectly good backup — do it weekly onto a separate drive.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| *(just scan)* | Look up the patron — no need to click anywhere first |
| `F2` | Complete the sale |
| `Esc` | Clear the ticket; press again to clear the patron |
| `Ctrl+1`–`Ctrl+5` | Bar / Inventory / Patrons / Reports / Admin |
| `Ctrl+E` | Jump to Export |

---

## Backups

Everything lives in one SQLite file on one machine, so that machine is a single
point of failure for the whole season. **Admin → Backups** fixes that: point it
at a USB stick or a shared drive and a copy is taken automatically

- when a shift is closed,
- once per business day, and
- on launch, if a day was missed because the bar was shut or the box was off.

Old copies are rotated out (30 by default) so a stick cannot fill up. Only
files the app itself wrote are ever deleted — anything else in that folder is
left alone.

**An unplugged drive never interrupts service.** A backup that cannot run is
skipped and logged, the bartender is told at shift close, and the till keeps
taking orders. The Admin panel says plainly whether backups are actually
happening, when the last one ran, and how many copies exist.

Each copy is a complete, self-contained database — open it in DB Browser for
SQLite, or drop it back at `%APPDATA%\Drop Zone Tea Party\data\bar.db` to
restore.

---

## Where everything lives

| What | Where |
|---|---|
| Source code | `~/cac-bar-pos` |
| Built installers | `~/cac-bar-pos/dist/` (not in git — too big) |
| **The bar's data (Windows)** | `%APPDATA%\Drop Zone Tea Party\data\bar.db` |
| The data on this Mac | `~/Library/Application Support/Drop Zone Tea Party/data/bar.db` |

The database sits **outside** the install folder deliberately, so reinstalling
or upgrading the app never touches it. That file is the whole night's takings —
it is the one to back up.

---

## Shipping it to the bar

The installers are ~100 MB each, which is GitHub's hard limit for a file inside
a repository. They cannot be committed; they go out as **Release downloads**
instead, which have no practical size limit.

A workflow at `.github/workflows/release.yml` does this for you. Push a version
tag and GitHub builds the installers on a Windows machine and publishes them:

```bash
npm version patch          # bumps package.json and creates the tag
git push && git push --tags
```

A few minutes later the Release appears with both `.exe` files attached. Send
the bar the release page URL; they download and run it. No Mac, no build step,
no toolchain on their end.

To build without releasing, use the **Run workflow** button on the Actions tab —
the installers come out as downloadable build artifacts.

### Pushing an update

1. Make the change, run `npm test` and `npm run test:ui`.
2. `git commit -am "what changed"`
3. `npm version patch` (or `minor`), then `git push && git push --tags`.
4. The bar downloads the new installer from the Release page and runs it over
   the top. **Their data is kept** — the database is outside the install folder
   and is migrated automatically on first launch.

### The SmartScreen warning

These builds are not code-signed, so the first run on a new machine shows a blue
*"Windows protected your PC"* box. **More info → Run anyway** gets past it. This
is expected for unsigned software and is not a sign anything is wrong; removing
the warning entirely means buying a code-signing certificate.

---

## Development

```bash
npm install          # rebuilds the native SQLite module for Electron
npm start            # run the app
npm test             # 439 main-process checks: limits, caps, rollover, lookup, sales
npm run test:ui      # 152 checks driving the real window, incl. a real PDF render
npm run dist:win     # build the Windows x64 installer + portable exe
                     # (--publish never: releases are published by CI, not by
                     #  electron-builder, which otherwise tries to publish by
                     #  itself whenever HEAD happens to be on a tag)
npm run fix:native   # repair node_modules after a Windows build (see below)
npm run shot         # seed demo trade and screenshot the UI + report into .shots/
node scripts/make-icon.js   # regenerate build/icon.ico and build/icon.png
```

Built artifacts land in `dist/`.

> **After a Windows build on a Mac**, `dist:win` leaves `node_modules` holding
> the *Windows* copy of the native SQLite module, so `npm start` and `npm test`
> will fail with `ERR_DLOPEN_FAILED`. Run `npm run fix:native` to put the local
> one back. `npm start` and `npm test` check this up front and tell you as
> much rather than dumping a stack trace.

### Version pinning — do not casually bump these

`package.json` pins **`better-sqlite3@12.11.1`** and **`electron@42.11.3`**.
That pairing is deliberate: better-sqlite3 publishes prebuilt native binaries
only up to Electron ABI 146, which is Electron 42. Newer versions of either
force a from-source build, which **cannot cross-compile to Windows from macOS**
(it needs MSVC). With these pins, `npm run dist:win` works from a Mac.

If you bump them, either check that a matching prebuild exists for the new
Electron ABI, or do the Windows build on a Windows machine with build tools
installed.

### Theme

USAF palette, defined once at the top of `src/renderer/styles.css`:
Air Force blue `#00308F` as the accent, silver `#C3C9D0` for text and metal
edges, near-black `#07090C` for the ground. Change those three variables and
the whole app follows.

One deliberate exception: **chart bars use a lighter step, `#3b7dd8`.** The
brand blue only reaches 1.5:1 contrast against the dark panel, well under the
3:1 a chart mark needs to be legible; the lighter step measures 4.3:1. That is
the normal dark-mode anchor flip for a value ramp, and the UI tests assert it
so nobody "fixes" it back to the brand blue.

### Icon

`build/icon.ico` and `build/icon.png` are generated by
`node scripts/make-icon.js` — no binary assets are checked in and no image
library is needed. Edit the colours or geometry at the top of that script and
re-run it.

### Layout

```
src/main/main.js      Electron entry, window, IPC handlers
src/main/db.js        Schema, migrations, every query and business rule
src/main/cac.js       Scan parsing: hashing, heuristics, layout decoding
src/main/exports.js   CSV reports and database snapshots
src/preload/          The only renderer↔Node bridge (context-isolated)
src/renderer/         UI — plain HTML/CSS/JS, no framework
scripts/              Preflight checks, icon generator, screenshot tool
build/                Generated app icons
test/                 Smoke tests
```

The sales chart is hand-built inline SVG — no charting library, which keeps the
strict Content-Security-Policy intact (no third-party scripts can run in the
renderer at all).

The renderer is fully sandboxed: `contextIsolation` on, `nodeIntegration` off,
a strict CSP, external navigation blocked, and a fixed list of IPC calls as the
only surface. The renderer cannot touch the filesystem or the database directly.

---

## Limitations, stated plainly

- **No payment processing.** It does not talk to a card reader or a cash
  drawer — payment is handled on a separate terminal. Card is the only tender
  recorded, and there is no comp option; say the word if you want one.
- **No open tabs.** Each sale is rung up and closed immediately.
- **One machine, one copy.** The app refuses to run twice at once to protect
  the database. Two bartenders on two laptops would need two databases.
- **No receipt printer support.**
- **CAC name auto-fill is best-effort until calibrated**, for the reasons
  above. Drink tracking is not affected.
- **Not yet exercised on real hardware.** The logic, the UI and the Windows
  build are all tested, but nobody has run this against a live scanner and a
  real CAC. Budget an evening to calibrate and dry-run it before a live night.
