# TAI-Honeybee App

A downloadable Windows desktop app that automates the Boost freight-billing workflow:
pull a payer's invoices from **TAI**, split the merged PDF into one file per invoice, and
upload them in batches to **CTSI / Honeybee TMS**. **A run is fully automatic** — once
started, it downloads, splits, and uploads to CTSI with no pause for review (uploads begin
while later chunks are still downloading), so only click **Run** when you mean it.

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

### Updating
When a newer release is published, the app shows an **"Update available — v…"** button in
its header (it checks the Releases page on launch and every few hours). Clicking it opens
the Releases page in your browser — download and run the new installer; it replaces the
old version in place. If the button never appears, you're up to date (or offline).

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
3. Click **Run**. The app logs in, downloads the invoices in chunks, splits each chunk into
   per-invoice PDFs, and **uploads each chunk to CTSI automatically as soon as it's ready —
   there is no review pause before uploading**. Double-check the payer, client, and date range
   before starting; use **Cancel run** to stop the remaining work (batches already submitted
   to CTSI stay submitted).
4. Watch the stage tracker and batch progress; each batch's **Batch ID** is shown on success.
   Use **Copy log** to copy the full run log if you need to share it.

---

## For developers

### Prerequisites
- Node.js 20+ (the app is built/run with Node 24 locally).
- **No Windows machine is needed to build the Windows installer** — build it in CI on a
  hosted Windows runner, or cross-build it straight from macOS/Linux (see below).

### Setup
```bash
npm install                 # also runs `playwright install chromium` (project-local)
```

### Run in dev
```bash
npm start                   # electron .
```

### Build the Windows installer

Output for every option: `dist/TAI-Honeybee App Setup <version>.exe` (~300 MB — it bundles
Electron + Playwright's Chromium), unsigned.

**Option A — GitHub Actions (recommended; no computer needed).**
The [`build-windows-installer`](.github/workflows/build-windows-installer.yml) workflow builds
on a hosted Windows runner:
- **On demand:** GitHub → *Actions* → *Build Windows installer* → *Run workflow*, then download
  the installer from the run's **Artifacts**.
- **Release:** push a `v*` tag matching `package.json`'s version; the workflow builds and
  attaches the installer to a **GitHub Release** — the same *Releases* page end users install
  from (see "For end users" above).
  ```bash
  git tag v1.3.0 && git push origin v1.3.0
  ```

**Option B — cross-build from macOS/Linux.**
```bash
npm run dist:win-from-mac
```
This downloads the **win64** Playwright browser packages (Chromium, headless shell, ffmpeg,
winldd) for the pinned Playwright version, temporarily swaps them into
`node_modules/playwright-core/.local-browsers` (your host's browsers are stashed and restored
afterwards, even on failure), and runs `electron-builder --win --x64`. electron-builder builds
the NSIS installer fine from macOS/Linux — nothing extra to install; it fetches its own helper
tooling (NSIS, and on mac a bundled Wine for exe metadata) automatically on first build.
Browser downloads are cached in `~/.cache/tai-honeybee-win-browsers`, so rebuilds are quick.
Verified 2026-08-14: produced a working `TAI-Honeybee App Setup 1.3.0.exe` from an
Apple-silicon Mac.

**Option C — on a Windows machine (the original route).**
```bash
npm run dist                # electron-builder --win -> unsigned NSIS installer in dist/
```
Build the installer with signing disabled so electron-builder doesn't try to sign the exe with
a cert you don't have:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist    # bash
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; npm run dist   # PowerShell
```

**Known gotcha for Option C only — `winCodeSign` symlink error** (hosted CI runners and
macOS/Linux cross-builds are not affected). On its first build, electron-builder
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
Windows box, a real non-Binghamton payer landing on the correct customer, a real batch
producing a Batch ID, and the credential save/session round-trip through the UI. (Reminder:
runs are fully automatic — there is no confirm gate before CTSI upload.)
The installer is currently **unsigned**.
