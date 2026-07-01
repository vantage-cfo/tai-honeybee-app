# CLAUDE.md — tai-honeybee-app (TAI-Honeybee App desktop app)

> App display name is **TAI-Honeybee App** (electron-builder `productName`); it automates
> the Boost Transport TAI→CTSI billing workflow. "Boost" elsewhere refers to the carrier /
> workflow, not the app name.

> Per-project context + conventions for this repo. Layered on top of the folder-level
> `projects/CLAUDE.md`. Keep this current: when a convention, selector, or build step
> changes, update the relevant section here rather than appending at the bottom.

## What this is
A downloadable **Electron desktop app** (Windows-first) that wraps a validated Playwright
automation so a non-technical Boost/Vantage team can run a freight-billing workflow locally:

1. **TAI** (`atl.taicloud.net`): log in, open a payer's Invoice Search, apply an Invoice
   Date range, select all, and download one merged PDF of their invoices.
2. **Split**: break the merged PDF into one PDF per invoice — every page carrying the
   "Payable To: Boost Transport / PO Box 852 / Oakwood, GA 30566" block starts a new
   invoice (invoice first, backup docs after — exactly what CTSI expects).
3. **CTSI / Honeybee TMS** (`portal.ctsi-global.com`): log in (auth0), open Invoice
   Upload, pick carrier (always **BOVT - BOOST TRANSPORT**) + client account, and upload
   the split PDFs in batches of **max 20**, capturing the Batch ID for each.

The app is a friendly wrapper — **the automation itself was already validated** as a
Playwright test (`playwright-script.spec.ts`) before the app existed. That test remains in
the repo as the reference/source-of-truth and still runs via `npx playwright test`.

## Stack & key decisions
- **Electron + electron-builder (NSIS)**, chosen over Tauri: the automation is Node +
  Playwright + `pdf-lib` + `pdfjs-dist`, so it runs unchanged in Electron's main process.
  Tauri (Rust backend) would need a separate Node sidecar for zero benefit. Bundle size is
  irrelevant for an internal tool.
- **Renderer = plain no-build HTML/CSS/vanilla JS.** Two static screens don't justify a
  framework/bundler. No React, no Vite.
- **Playwright's bundled Chromium ships inside the app** so end users need no Node/Playwright
  install. `.npmrc` sets `PLAYWRIGHT_BROWSERS_PATH=0` (project-local browser under
  `node_modules/playwright-core/.local-browsers/`); `electron-builder.yml` `asarUnpack`s
  both `node_modules/playwright/**` and `node_modules/playwright-core/**` so the binary is
  launchable from disk. `main.js` sets `PLAYWRIGHT_BROWSERS_PATH=0` when `app.isPackaged`.
- **Credentials via Electron `safeStorage`** (DPAPI on Windows) → `userData/creds.enc`.
  No native module, no plaintext, credentials are never logged or emitted in progress events.
  Unsaved-session creds (when "Save login details" is unchecked) live **in-memory in the main
  process** (`credentials.getEffectiveCreds()`), NOT in renderer `sessionStorage` — `file://`
  documents get opaque origins so sessionStorage isn't shared across the login→main navigation.
- **Confirm-before-upload gate**: after splitting, the run BLOCKS on an IPC round-trip
  (`confirm-request` → `confirmUpload(proceed)`) before any CTSI login/upload. Uploading is
  hard to undo, so nothing is submitted until the user explicitly confirms. This also makes
  TAI-pull → split safe to exercise with real creds without ever hitting CTSI.
- **Payer selection: customerId direct-nav is PRIMARY**, autocomplete is a FAILSAFE.
  `shared/payers.js` holds a verified `customerId` for all 9 payers (extracted from TAI's
  own collections-summary hrefs, 2026-07-01). `run.js` direct-navs by `customerId`; the
  `#selectedOrganization` name-autocomplete (`selectPayerByName`) runs ONLY when a payer's
  `customerId` is null (a future payer added without an ID). Do not re-enable autocomplete
  as an every-run "confirmation" — that was removed intentionally.

## Architecture
- **Main process** (`src/main/`): `main.js` (window + IPC), `credentials.js` (safeStorage +
  in-memory session cache), `runner.js` (bridges IPC ↔ automation, single-run guard, computes
  `downloadDir`/`splitDir` under `app.getPath('userData')`, wires the confirm/cancel closures,
  streams `run:progress` events).
- **Preload** (`src/preload/preload.js`): the ONLY renderer↔Node surface, exposed as
  `window.boost` via `contextBridge` (contextIsolation on, nodeIntegration off).
- **Automation** (`src/automation/run.js`): a **mechanical port** of
  `playwright-script.spec.ts` — plain async module, `run(params, emit, awaitConfirm,
  isCancelled, {downloadDir, splitDir})`. All selectors/flow preserved verbatim; browser
  always closed in `finally`.
- **Renderer** (`src/renderer/`): `login.html`/`login.js` (screen 1) and
  `main.html`/`app.js` (screen 2) + `styles.css`. Dropdowns populated from `options:get`.
- **Shared** (`src/shared/payers.js`): single source of truth for the 9 payer + 2 account
  options AND the payer→customerId map. Used by both the renderer (via IPC) and run params.
- `split-invoices.js` (repo root) is reused as-is via `require('../../split-invoices.js')` —
  do NOT move, copy, or rewrite it.

## Conventions / gotchas (do not regress — these were hard-won in the script)
- **TAI login is two-step**: "Other ways to sign in" → fill Username → click the button in
  `#login-method-form-user-row` → fill Password → "Log In".
- **Skip the fragile collections-summary click**; direct-nav to
  `invoice-search?customerId=<ID>&daysOverDue=0&asOfDate=<TODAY>` (asOfDate = today).
- **Date picker is PrimeNG** (`p-datepicker`), not Kendo. Navigate months via
  `button[aria-label="Previous/Next Month"]`, click `td:not(.p-datepicker-other-month)
  span[data-date="YYYY-M-D"]` — month 1-based, month/day NOT zero-padded. Start then end, Search.
- **The "Download (N)" button only appears after toggling `#selectAll`** (check → uncheck →
  re-check). This toggle loop is required, not optional.
- **Download capture is dual-mode**: TAI may fire a real `download` OR open the PDF in a popup
  tab. Listen for both at context level (~120s), and for the popup fetch bytes via
  `ctx.request.get(popup.url())`.
- **CTSI login is auth0 Lock, flaky**: `input[name="username"]`/`[name="password"]`,
  `button.auth0-lock-submit`; retry the whole login up to 3×; wait to leave the auth0 domain
  (`waitForURL(/portal\.ctsi-global\.com\/TMSV5/)`).
- **CTSI upload is inside an `iframe`**: carrier via `frame.locator('span').nth(2)` → option
  "BOVT - BOOST TRANSPORT"; account via the `.k-dropdown-wrap .k-select .k-icon` then the
  option containing the account number; "Go To Upload"; wait for the "Choose File" button.
- **File input** is `input[type="file"]` (multiple); `setInputFiles(batch)` with ≤20 paths.
  Re-open a fresh upload screen per batch. After Submit, do NOT wait for networkidle — wait
  for the `Batch ID` text and capture it.
- **Working dirs** (`downloads/`, `split-output/`) are written under `userData`, never inside
  the installed app dir (read-only under Program Files).
- **Human-like pacing (anti-bot):** the browser launches with `slowMo` (`SLOW_MO_MS`, 300ms) so
  every action is paced — the validated dry-run scripts used this and firing at full speed raced
  past the two-step login and timed out on "Show Advanced". On top of that, ALL text inputs (TAI +
  CTSI logins, payer search) go through `typeInto()` which types character-by-character
  (`TYPE_DELAY_MS`) instead of `locator.fill()` (instant paste, which anti-bot systems flag). Do
  not revert either to a plain fast `.fill()`.

## Commands
- `npm install` — installs deps; `postinstall` runs `playwright install chromium` (project-local).
- `npm start` — run the app in dev (`electron .`). Opens Login, or Main if creds are saved.
- `npm run dist` — build the unsigned NSIS installer under `dist/` (Windows). Use
  `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing. **First-build gotcha:** electron-builder's
  `winCodeSign` extraction fails on Windows with "Cannot create symbolic link" (macOS `darwin`
  symlinks need symlink privilege). Fix once via Windows Developer Mode, an admin terminal, or
  pre-extracting the cache skipping `darwin` — see README "Known Windows build gotcha". A working
  `TAI-Honeybee App Setup 1.0.0.exe` (~314 MB) was built this way on 2026-07-01, with the bundled
  Chromium correctly unpacked under `app.asar.unpacked/.../.local-browsers/` (asarUnpack verified).
  Installer is named `TAI-Honeybee App Setup <version>.exe`; installs to
  `AppData\Local\Programs\TAI-Honeybee App` (per-user).
- `npm test` — runs the original reference Playwright automation (needs `.env` + live creds).

## Not-yet-verified (needs manual check before production use)
The build was assembled and statically verified (syntax, module load, IPC wiring, gotchas,
payer data). `npm run dist` is now VERIFIED — it produced `TAI-Honeybee App Setup 1.0.0.exe`
(~314 MB) with Chromium correctly unpacked. The following still require a display / live
credentials / a clean machine and were NOT verified in the build environment:
- The packaged Chromium actually LAUNCHES on a clean Windows box with no Node/Playwright
  (binary is present on disk and asarUnpack is confirmed, but runtime launch is unproven).
- A real non-Binghamton payer direct-nav lands on the correct customer (the user-supplied
  customerIds are unverifiable statically — a wrong ID would silently pull the wrong customer).
- The confirm gate actually blocks upload in a visual run; a real ≤20 batch produces a Batch ID.
- The unsaved-Save credential round-trip through the UI.

## Deploy / distribution note
The installer is **unsigned** (no code-signing cert). Windows SmartScreen shows an
"Unrecognized app" warning on first run — users click **More info → Run anyway**. Expected,
not a bug. Add a signing cert before any wider/polished release.
