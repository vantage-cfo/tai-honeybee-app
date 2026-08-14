#!/usr/bin/env node
/**
 * scripts/dist-win-from-mac.js — build the Windows NSIS installer from
 * macOS/Linux, no Windows machine needed.
 *
 * Why this exists: `playwright install chromium` (our postinstall) only
 * downloads browser binaries for the HOST platform, so a plain
 * `electron-builder --win` on a Mac would package macOS Chromium into the
 * Windows app. This script recreates exactly what a Windows `npm install`
 * would have put in node_modules/playwright-core/.local-browsers:
 *
 *   1. downloads the win64 Playwright browser packages (chromium, headless
 *      shell, ffmpeg, winldd) for the revisions pinned in the installed
 *      playwright-core's browsers.json;
 *   2. stashes the host's .local-browsers to node_modules/.local-browsers.host-stash
 *      (OUTSIDE the playwright-core package dir, so electron-builder's
 *      dependency collector can never pack the mac binaries) and swaps the
 *      win64 packages in;
 *   3. runs `electron-builder --win --x64` (cross-builds NSIS from macOS with
 *      zero setup — electron-builder auto-fetches its helper tooling,
 *      including NSIS and, on mac, its bundled Wine for exe metadata;
 *      unsigned like the Windows build, so CSC_IDENTITY_AUTO_DISCOVERY=false);
 *   4. restores the host browsers afterwards — on build failure (finally) and
 *      on Ctrl+C/SIGTERM (signal handlers) — so `npm start` keeps working.
 *      If the process dies uncleanly anyway (e.g. SIGKILL), just re-run this
 *      script: it detects the leftover stash and restores it first.
 *
 * Download URLs/layouts mirror playwright-core's registry
 * (lib/coreBundle.js): chromium + headless shell use the Chrome-for-Testing
 * CDN layout `builds/cft/<browserVersion>/win64/<pkg>.zip`; ffmpeg/winldd use
 * `builds/<name>/<revision>/<name>-win64.zip` on the Playwright CDN mirrors.
 * Zips are cached in ~/.cache/tai-honeybee-win-browsers so rebuilds are fast.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const PW_CORE = path.join(ROOT, 'node_modules', 'playwright-core');
const BROWSERS_DIR = path.join(PW_CORE, '.local-browsers');
// Stash must live outside any npm package dir: electron-builder collects
// whole dependency package dirs, and a stash inside playwright-core would
// ship ~150 MB of mac Chromium inside the Windows installer.
const STASH_DIR = path.join(ROOT, 'node_modules', '.local-browsers.host-stash');
// Zips are cached in the home dir (survives npm ci), but extraction is staged
// inside node_modules: the staged dirs are renameSync'd into playwright-core,
// and rename(2) can't cross filesystems — ~/.cache may be a different volume
// than the repo (external disk, separate /Users mount, tmpfs). Top-level
// non-package dirs in node_modules are never packed by electron-builder.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'tai-honeybee-win-browsers');
const STAGING_DIR = path.join(ROOT, 'node_modules', '.win-browsers-staging');

// Mirrors as listed in playwright-core's registry (PLAYWRIGHT_CDN_MIRRORS).
const PW_CDN_MIRRORS = [
  'https://cdn.playwright.dev/dbazure/download/playwright',
  'https://playwright.download.prss.microsoft.com/dbazure/download/playwright',
  'https://cdn.playwright.dev',
];
const CFT_CDN = 'https://cdn.playwright.dev';

function log(msg) {
  process.stdout.write(`[dist:win-from-mac] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[dist:win-from-mac] ERROR: ${msg}\n`);
  process.exit(1);
}

function winPackages() {
  const browsersJson = path.join(PW_CORE, 'browsers.json');
  if (!fs.existsSync(browsersJson))
    fail(`missing ${browsersJson} — run \`npm install\` first`);
  const byName = Object.fromEntries(
    require(browsersJson).browsers.map((b) => [b.name, b])
  );
  for (const name of ['chromium', 'chromium-headless-shell', 'ffmpeg', 'winldd']) {
    if (!byName[name]) fail(`browsers.json has no "${name}" entry — playwright layout changed?`);
  }
  return [
    {
      // Installed dir name = browser name with '-'→'_' + '-<revision>'
      // (see registry's isBrowserDirectory).
      dir: `chromium-${byName['chromium'].revision}`,
      urls: [`${CFT_CDN}/builds/cft/${byName['chromium'].browserVersion}/win64/chrome-win64.zip`],
      // Path the app resolves at runtime (run.js resolveChromiumExecutable).
      expect: path.join('chrome-win64', 'chrome.exe'),
    },
    {
      dir: `chromium_headless_shell-${byName['chromium-headless-shell'].revision}`,
      urls: [
        `${CFT_CDN}/builds/cft/${byName['chromium-headless-shell'].browserVersion}/win64/chrome-headless-shell-win64.zip`,
      ],
      expect: path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    },
    {
      dir: `ffmpeg-${byName['ffmpeg'].revision}`,
      urls: PW_CDN_MIRRORS.map((h) => `${h}/builds/ffmpeg/${byName['ffmpeg'].revision}/ffmpeg-win64.zip`),
      expect: 'ffmpeg-win64.exe',
    },
    {
      dir: `winldd-${byName['winldd'].revision}`,
      urls: PW_CDN_MIRRORS.map((h) => `${h}/builds/winldd/${byName['winldd'].revision}/winldd-win64.zip`),
      expect: 'PrintDeps.exe',
    },
  ];
}

async function download(urls, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`cached: ${path.basename(dest)}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (const url of urls) {
    try {
      log(`downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.tmp`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      log(`  failed (${err.message}), trying next mirror...`);
    }
  }
  fail(`could not download ${path.basename(dest)}: ${lastErr}`);
}

function extract(zip, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zip, '-d', destDir], { stdio: 'inherit' });
  if (r.status !== 0) fail(`unzip failed for ${zip}`);
}

async function prepareWinBrowsers() {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  const dirs = [];
  for (const pkg of winPackages()) {
    const zip = path.join(CACHE_DIR, `${pkg.dir}.zip`);
    await download(pkg.urls, zip);
    const dest = path.join(STAGING_DIR, pkg.dir);
    extract(zip, dest);
    const expected = path.join(dest, pkg.expect);
    if (!fs.existsSync(expected)) {
      fail(
        `${pkg.dir}: expected ${pkg.expect} after extraction but it is missing ` +
          `(zip layout changed?). Contents: ${fs.readdirSync(dest).join(', ')}`
      );
    }
    // Same marker `playwright install` writes; registry treats the browser
    // as installed only when present.
    fs.writeFileSync(path.join(dest, 'INSTALLATION_COMPLETE'), '');
    dirs.push(dest);
  }
  return dirs;
}

function swapInWinBrowsers(stagedDirs) {
  if (fs.existsSync(STASH_DIR)) {
    // Leftover stash from a previous crashed run — the stash is the real
    // host browsers; put them back before stashing again.
    log('restoring leftover host-browser stash from a previous run');
    fs.rmSync(BROWSERS_DIR, { recursive: true, force: true });
    fs.renameSync(STASH_DIR, BROWSERS_DIR);
  }
  if (fs.existsSync(BROWSERS_DIR)) fs.renameSync(BROWSERS_DIR, STASH_DIR);
  fs.mkdirSync(BROWSERS_DIR, { recursive: true });
  for (const dir of stagedDirs)
    fs.renameSync(dir, path.join(BROWSERS_DIR, path.basename(dir)));
}

function restoreHostBrowsers() {
  // Only act if a stash exists — otherwise nothing was swapped and removing
  // BROWSERS_DIR would delete the real host browsers.
  if (!fs.existsSync(STASH_DIR)) return;
  fs.rmSync(BROWSERS_DIR, { recursive: true, force: true });
  fs.renameSync(STASH_DIR, BROWSERS_DIR);
}

async function main() {
  if (process.platform === 'win32')
    fail('you are on Windows — just run `npm run dist`.');

  log('preparing win64 Playwright browser packages...');
  const staged = await prepareWinBrowsers();

  // From here on the host browsers may be stashed — every exit path must put
  // them back: swap/build failures via finally, Ctrl+C/kill/terminal-close
  // via signal handlers (finally does NOT run when a signal kills the
  // process). Both are idempotent; if the process dies uncleanly anyway
  // (SIGKILL), the leftover-stash branch in swapInWinBrowsers heals on rerun.
  const cleanup = () => {
    restoreHostBrowsers();
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      log(`${sig} received — restoring host browsers...`);
      cleanup();
      process.exit(130);
    });
  }

  let status = 1;
  try {
    swapInWinBrowsers(staged);
    log('win64 browsers in place; running electron-builder --win --x64...');
    const r = spawnSync('npx', ['electron-builder', '--win', '--x64'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
    status = r.status ?? 1;
  } finally {
    cleanup();
    log('host browsers restored.');
  }

  if (status !== 0) fail(`electron-builder exited with ${status}`);
  log('done — installer is under dist/.');
}

main().catch((err) => fail(err.stack || String(err)));
