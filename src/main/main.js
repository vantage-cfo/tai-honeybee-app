/**
 * src/main/main.js
 *
 * Electron main process: window lifecycle + IPC handlers. Main owns the
 * automation and credential store; the renderer is UI only (see spec §3).
 */

// Must run BEFORE requiring/launching Playwright (via runner.js -> run.js) so
// the packaged app resolves Chromium from the asarUnpack'd location. See
// spec §7.2.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
if (app.isPackaged) {
  // Playwright's Chromium is asarUnpack'd to app.asar.unpacked on real disk.
  // PLAYWRIGHT_BROWSERS_PATH='0' would resolve relative to the playwright-core
  // package dir, which lands INSIDE app.asar (an archive — chrome.exe can't be
  // spawned from there → ENOENT). Point it at the unpacked .local-browsers dir
  // instead. Revision-agnostic: Playwright picks the right chromium-<rev> and
  // headless-shell under this path.
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules', 'playwright', 'node_modules', 'playwright-core', '.local-browsers'
  );
}
const credentials = require('./credentials');
const runner = require('./runner');
const { PAYERS, ACCOUNTS } = require('../shared/payers');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 900,
    minHeight: 640,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const startScreen = credentials.hasCreds() ? 'main' : 'login';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', `${startScreen}.html`));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: credentials ─────────────────────────────────────────────────────
// Plaintext credentials NEVER cross the IPC boundary into the renderer (MED-2).
// creds:hasEffective reports only WHETHER a run can proceed — i.e. whether an
// in-memory session set or the persisted encrypted set exists. The actual
// credential values are merged into the run params inside the main process
// (runner.startRun). creds:has stays file-backed (drives login auto-skip).
ipcMain.handle('creds:hasEffective', () => credentials.getEffectiveCreds() != null);
ipcMain.handle('creds:save', (_event, creds) => credentials.saveCreds(creds));
ipcMain.handle('creds:clear', () => credentials.clearCreds());
ipcMain.handle('creds:has', () => credentials.hasCreds());
ipcMain.handle('creds:setSession', (_event, creds) => credentials.setSessionCreds(creds));

// ── IPC: options ─────────────────────────────────────────────────────────
ipcMain.handle('options:get', () => ({ payers: PAYERS, accounts: ACCOUNTS }));

// ── IPC: run control ─────────────────────────────────────────────────────
ipcMain.handle('run:start', async (event, params) => {
  // Single-run guard lives in runner.startRun (kept there as the single source
  // of truth); no duplicate check here.
  await runner.startRun(params, event.sender);
});

ipcMain.handle('run:confirm', (_event, { proceed }) => {
  runner.confirmUpload(!!proceed);
});

ipcMain.handle('run:cancel', () => {
  runner.cancelRun();
});

// ── IPC: shell ───────────────────────────────────────────────────────────
// Only ever open a folder INSIDE our own userData tree (MED-4). A renderer-
// supplied path is resolved and validated to be under userData; anything else
// (or a missing path) falls back to the split-output dir. Never shell.openPath
// an arbitrary renderer-supplied path — that could launch executables.
ipcMain.handle('shell:openFolder', async (_event, absPath) => {
  const userData = path.resolve(app.getPath('userData'));
  const splitDir = path.join(userData, 'split-output');
  let target = splitDir;
  if (typeof absPath === 'string' && absPath.length > 0) {
    const resolved = path.resolve(absPath);
    if (resolved === userData || resolved.startsWith(userData + path.sep)) {
      target = resolved;
    }
  }
  await shell.openPath(target);
});

// ── IPC: navigation ──────────────────────────────────────────────────────
ipcMain.on('nav:go', (_event, screen) => {
  if (!mainWindow) return;
  const file = screen === 'main' ? 'main.html' : 'login.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', file));
});
