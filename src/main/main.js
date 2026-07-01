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
      sandbox: false,
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
// creds:load returns the EFFECTIVE creds (in-memory session set first, else
// the persisted encrypted set) so the unsaved-session path works across the
// login->main navigation. creds:has stays file-backed (drives login auto-skip).
ipcMain.handle('creds:load', () => credentials.getEffectiveCreds());
ipcMain.handle('creds:save', (_event, creds) => credentials.saveCreds(creds));
ipcMain.handle('creds:clear', () => credentials.clearCreds());
ipcMain.handle('creds:has', () => credentials.hasCreds());
ipcMain.handle('creds:setSession', (_event, creds) => credentials.setSessionCreds(creds));

// ── IPC: options ─────────────────────────────────────────────────────────
ipcMain.handle('options:get', () => ({ payers: PAYERS, accounts: ACCOUNTS }));

// ── IPC: run control ─────────────────────────────────────────────────────
ipcMain.handle('run:start', async (event, params) => {
  if (runner.isRunActive()) {
    throw new Error('A run is already in progress.');
  }
  await runner.startRun(params, event.sender);
});

ipcMain.handle('run:confirm', (_event, { proceed }) => {
  runner.confirmUpload(!!proceed);
});

ipcMain.handle('run:cancel', () => {
  runner.cancelRun();
});

// ── IPC: shell ───────────────────────────────────────────────────────────
ipcMain.handle('shell:openFolder', async (_event, absPath) => {
  await shell.openPath(absPath);
});

// ── IPC: navigation ──────────────────────────────────────────────────────
ipcMain.on('nav:go', (_event, screen) => {
  if (!mainWindow) return;
  const file = screen === 'main' ? 'main.html' : 'login.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', file));
});
