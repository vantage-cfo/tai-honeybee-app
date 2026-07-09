# CLAUDE.md — tai-honeybee-app

Display name **TAI-Honeybee App** (electron-builder `productName`). Automates Boost Transport's TAI→CTSI billing. "Boost" elsewhere = the carrier/workflow, not the app.

## What it is
Windows-first **Electron desktop app** wrapping a validated Playwright automation so a non-technical team can run the workflow locally:
1. **TAI** (`atl.taicloud.net`): log in, open a payer's Invoice Search, apply a date range, select all, download one merged PDF.
2. **Split**: break the merged PDF into one PDF per invoice — a new invoice starts at every page carrying the "Payable To: Boost Transport / PO Box 852 / Oakwood, GA 30566" block (invoice first, backups after).
3. **CTSI/Honeybee** (`portal.ctsi-global.com`): log in (auth0), Invoice Upload, pick carrier **BOVT - BOOST TRANSPORT** + client account, upload split PDFs in batches of **≤20**, capture each Batch ID.

The automation was validated as a Playwright test (`playwright-script.spec.ts`) before the app existed; it remains the reference.

## Stack decisions
- **Electron + electron-builder (NSIS)** over Tauri: the automation is Node (Playwright + `pdf-lib` + `pdfjs-dist`) and runs unchanged in Electron's main process.
- **Renderer = no-build HTML/CSS/vanilla JS** (two static screens; no framework/bundler).
- **Bundled Chromium ships in the app** so users need no Node/Playwright: `.npmrc` sets `PLAYWRIGHT_BROWSERS_PATH=0`; `electron-builder.yml` `asarUnpack`s `playwright/**` + `playwright-core/**`; `main.js` sets the same env when `app.isPackaged`.
- **Credentials via Electron `safeStorage`** (DPAPI) → `userData/creds.enc`; never plaintext, never logged. They stay **main-process only** — merged into run params in `runner.startRun` via `credentials.getEffectiveCreds()`; the renderer never receives passwords (the `creds:hasEffective` IPC returns only a boolean). Unsaved-session creds live in-memory in main (not renderer `sessionStorage` — `file://` origins are opaque).
- **Confirm-before-upload gate**: after splitting, the run blocks on an IPC round-trip (`confirm-request` → `confirmUpload`) before any CTSI login/upload. Nothing is submitted until the user confirms, so TAI-pull → split is safe to exercise with real creds.
- **Payer selection: `customerId` direct-nav is PRIMARY**, name-autocomplete is only a failsafe. `shared/payers.js` holds verified `customerId`s for all 9 payers; `selectPayerByName` runs ONLY when a payer's `customerId` is null. Don't re-enable autocomplete as an every-run confirmation (removed intentionally).

## Architecture
- **Main** (`src/main/`): `main.js` (window + IPC; `sandbox:true`), `credentials.js` (safeStorage + in-memory cache; `saveCreds` validates), `runner.js` (IPC↔automation bridge, single-run guard, computes `downloadDir`/`splitDir` under `userData`, wires confirm/cancel, streams `run:progress`).
- **Preload** (`src/preload/preload.js`): the only renderer↔Node surface, `window.boost` via `contextBridge` (contextIsolation on, nodeIntegration off).
- **Automation** (`src/automation/run.js`): mechanical port of the spec; `run(params, emit, awaitConfirm, isCancelled, {downloadDir, splitDir})`. Polls `isCancelled()` at stage boundaries; browser always closed in `finally`.
- **Renderer** (`src/renderer/`): `login.html/js` (screen 1), `main.html/app.js` (screen 2) + `styles.css`. Sign-out disabled while a run is active.
- **Shared** (`src/shared/payers.js`): single source for the 9 payer + 2 account options and the payer→customerId map.
- `split-invoices.js` (repo root) is reused as-is via `require('../../split-invoices.js')` — do NOT move/copy/rewrite it.

## Workflow gotchas (hard-won — don't regress)
- **TAI login is two-step**: "Other ways to sign in" → Username → click button in `#login-method-form-user-row` → Password → "Log In".
- **Skip the fragile collections-summary click**; direct-nav to `invoice-search?customerId=<ID>&daysOverDue=0&asOfDate=<TODAY>`.
- **Date picker is PrimeNG** (`p-datepicker`): navigate via `button[aria-label="Previous/Next Month"]`, click `td:not(.p-datepicker-other-month) span[data-date="YYYY-M-D"]` (month 1-based, not zero-padded). Start, then end, then Search.
- **"Download (N)" only appears after toggling `#selectAll`** (check → uncheck → re-check). Required, not optional.
- **Download capture is dual-mode**: TAI fires a real `download` OR opens the PDF in a popup. Listen for both at context level (~120s); for the popup, fetch bytes via `ctx.request.get(popup.url())`.
- **CTSI login is auth0 Lock, flaky**: `input[name="username"]`/`[name="password"]`, `button.auth0-lock-submit`; retry whole login up to 3×; `waitForURL(/portal\.ctsi-global\.com\/TMSV5/)`.
- **CTSI upload is inside an `iframe`**: carrier via `frame.locator('span').nth(2)` → "BOVT - BOOST TRANSPORT"; account via `.k-dropdown-wrap .k-select .k-icon` then the option with the account number; "Go To Upload"; wait for "Choose File".
- **File input** `input[type="file"]` (multiple); `setInputFiles(batch)` ≤20 paths; fresh upload screen per batch; after Submit wait for the `Batch ID` text (not networkidle).
- **Working dirs** (`downloads/`, `split-output/`) live under `userData`, never the installed app dir (read-only under Program Files).
- **Anti-bot pacing**: browser launches with `slowMo` (`SLOW_MO_MS` 300ms) and ALL text inputs go through `typeInto()` (char-by-char, `TYPE_DELAY_MS`), not `.fill()` (instant paste trips anti-bot). Firing at full speed raced past the two-step login. Don't revert either.

## Commands
- `npm install` — deps; `postinstall` runs `playwright install chromium`.
- `npm start` — dev run (`electron .`).
- `npm run dist` — unsigned NSIS installer under `dist/` (VERIFIED: produced `TAI-Honeybee App Setup 1.0.0.exe` ~314 MB, Chromium correctly unpacked). Use `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing. **First-build gotcha:** `winCodeSign` symlink extraction fails on Windows ("Cannot create symbolic link") — fix via Developer Mode / admin terminal / pre-extracting the cache skipping `darwin` (see README). Installs per-user to `AppData\Local\Programs\TAI-Honeybee App`.
- `npm run test:e2e-live` — the original Playwright automation. **Hits production CTSI with real uploads** (needs `.env` + live creds). `npm test` is a no-op that warns.

## Status / notes
- Not runtime-verified on a clean box: packaged Chromium launch, a real non-Binghamton payer direct-nav landing on the right customer (wrong `customerId` silently pulls the wrong one), the confirm gate blocking upload in a visual run, the unsaved-cred round-trip.
- Installer is **unsigned** — SmartScreen shows "Unrecognized app" (expected; add a signing cert before wider release).
- Electron 33 is past EOL — bump in a dedicated branch (packaged-Chromium path is fragile).
- `.env` holds live TAI/CTSI creds and is OneDrive-synced — keep it out of sync / rotate; the app itself uses safeStorage, not `.env`.
