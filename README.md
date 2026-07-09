# TAI-Honeybee App

A downloadable Windows desktop app that automates the Boost freight-billing workflow:
pull a payer's invoices from **TAI**, split the merged PDF into one file per invoice, and
upload them in batches to **CTSI / Honeybee TMS** — with a review-and-confirm step before
anything is submitted.

Built with Electron; it bundles the browser automation and a Chromium browser, so end users
need **no Node.js or Playwright installed**.

---

## For end users

### Install
1. Download the latest installer (`TAI-Honeybee App Setup <version>.exe`) from the repo's
   [**Releases** page](https://github.com/vantage-cfo/tai-honeybee-app/releases/latest)
   (or build it yourself — see "For developers" below).
2. Run it. Because the app isn't code-signed yet, Windows SmartScreen will say
   **"Windows protected your PC"** — click **More info → Run anyway**. This is expected.
3. Launch **TAI-Honeybee App** from the Start menu / desktop shortcut.

### Use
1. **Sign in** — enter your **TAI** and **CTSI / Honeybee** usernames and passwords. Leave
   **"Save login details on this computer"** checked to skip this screen next time (credentials
   are stored encrypted via the Windows credential system — never in plain text). Uncheck it to
   keep them for this session only.
2. **Set up a run** on the main screen:
   - **Payer** — the TAI customer to pull invoices for.
   - **Client** — the CTSI account to upload under.
   - **Invoice date range** — Start and End dates.
   - **Watch it run** — check this to open a visible browser window and watch the automation;
     leave unchecked to run in the background.
3. Click **Run**. The app logs in, downloads the invoices, and splits them.
4. **Review before upload** — when splitting finishes, the app shows how many invoices were
   found and pauses. Click **Open folder** to inspect the split PDFs, then either **Confirm &
   upload** to send them to CTSI, or **Cancel run** to stop. **Nothing is uploaded until you
   confirm.**
5. Watch the stage tracker and batch progress; each batch's **Batch ID** is shown on success.
   Use **Copy log** to copy the full run log if you need to share it.

---

## For developers

### Prerequisites
- Node.js 20+ (the app is built/run with Node 24 locally).
- Windows for building the Windows installer.

### Setup
```bash
npm install                 # also runs `playwright install chromium` (project-local)
```

### Run in dev
```bash
npm start                   # electron .
```

### Build the Windows installer
```bash
npm run dist                # electron-builder --win -> unsigned NSIS installer in dist/
```
Output: `dist/TAI-Honeybee App Setup <version>.exe` (~314 MB — it bundles Electron + Playwright's
Chromium). Build the installer with signing disabled so electron-builder doesn't try to sign
the exe with a cert you don't have:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist    # bash
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run dist   # PowerShell
```

**Known Windows build gotcha — `winCodeSign` symlink error.** On its first build, electron-builder
downloads a `winCodeSign` bundle and extracts it with 7-Zip; it contains macOS (`darwin`) symlinks
that Windows refuses to create without elevated privileges, so the build fails with
`Cannot create symbolic link : A required privilege is not held by the client`. Fix it once, any of:
- **Enable Windows Developer Mode** (Settings → Privacy & security → For developers), which lets
  standard users create symlinks — then `npm run dist` works as-is; **or**
- run the build once in an **Administrator** terminal; **or**
- **pre-extract the cache skipping `darwin`** (no admin needed), then build normally:
  ```bash
  CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"   # e.g. C:/Users/<you>/AppData/Local/...
  mkdir -p "$CACHE"
  curl -sL -o "$CACHE/winCodeSign-2.6.0.7z" \
    https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
  node_modules/7zip-bin/win/x64/7za.exe x "$CACHE/winCodeSign-2.6.0.7z" \
    "-o$CACHE/winCodeSign-2.6.0" -xr'!'darwin -y
  ```
  The `darwin` libs are macOS-only and unused by a Windows build. A successful `dist/` build was
  produced this way on 2026-07-01.

### Run the original automation test (reference)
The validated end-to-end automation lives in `playwright-script.spec.ts` and is the source of
truth the app's automation module was ported from. It needs a `.env` (see `.env.example`) with
real credentials.

> **WARNING — this is a LIVE production run.** It logs into TAI/CTSI with real credentials and
> performs REAL invoice uploads to CTSI. It is intentionally NOT wired to `npm test` (which now
> just prints this warning and exits). Only run it when you truly intend to hit production:
```bash
npm run test:e2e-live               # LIVE playwright test (real CTSI uploads)
HEADLESS=1 npm run test:e2e-live    # headless
```

### Project layout
```
src/
  main/         Electron main process: window, IPC, credentials, run bridge
  preload/      contextBridge API exposed to the renderer as window.boost
  automation/   run.js — the automation module (ported from playwright-script.spec.ts)
  renderer/     login + main screens (no-build HTML/CSS/vanilla JS)
  shared/       payers.js — payer/account options + payer->customerId map
split-invoices.js           PDF splitter (reused as-is by the automation)
playwright-script.spec.ts   reference automation (LIVE; runs via `npm run test:e2e-live`)
electron-builder.yml        NSIS installer config
.npmrc                      PLAYWRIGHT_BROWSERS_PATH=0 (project-local Chromium)
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture, key decisions, and the hard-won
automation gotchas that must not be regressed.

### Security
- Credentials are encrypted with Electron `safeStorage` (Windows DPAPI) at
  `userData/creds.enc`; unsaved sessions are held only in the main process's memory. Passwords
  are never written in plain text or logged.
- `contextIsolation` is on and `nodeIntegration` is off; the renderer's only access to
  Node/Electron is the narrow `window.boost` preload API.
- `.env` (used only by the reference test) is git-ignored — never commit real credentials.

### Status / caveats
This build has been statically verified (syntax, module wiring, IPC contract, automation
selectors, payer data). The following still require manual verification on a real machine with
live credentials before production use: the packaged installer + Chromium launch on a clean
Windows box, a real non-Binghamton payer landing on the correct customer, the live confirm-gate
and a real batch producing a Batch ID, and the credential save/session round-trip through the UI.
The installer is currently **unsigned**.
