/**
 * src/preload/preload.js
 *
 * contextBridge API exposed to the renderer as `window.boost`. contextIsolation
 * is on and nodeIntegration is off; this is the ONLY surface the renderer has
 * into Node/Electron (see spec §3).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boost', {
  // Credentials — plaintext values never cross this boundary (MED-2).
  // hasEffectiveCreds returns only a boolean: whether a run can proceed.
  hasEffectiveCreds: () => ipcRenderer.invoke('creds:hasEffective'),
  saveCreds: (creds) => ipcRenderer.invoke('creds:save', creds),
  clearCreds: () => ipcRenderer.invoke('creds:clear'),
  hasCreds: () => ipcRenderer.invoke('creds:has'),
  setSessionCreds: (creds) => ipcRenderer.invoke('creds:setSession', creds),

  // Options
  getOptions: () => ipcRenderer.invoke('options:get'),

  // Run control
  startRun: (params) => ipcRenderer.invoke('run:start', params),
  confirmUpload: (proceed) => ipcRenderer.invoke('run:confirm', { proceed }),
  cancelRun: () => ipcRenderer.invoke('run:cancel'),

  // Events (main -> renderer)
  onProgress: (cb) => {
    const listener = (_event, evt) => cb(evt);
    ipcRenderer.on('run:progress', listener);
    return () => ipcRenderer.removeListener('run:progress', listener);
  },

  // Updates — main checks GitHub Releases; the renderer only learns
  // { version } and can ask main to open the fixed releases page.
  getUpdateStatus: () => ipcRenderer.invoke('updates:get'),
  openDownloadPage: () => ipcRenderer.invoke('updates:openDownload'),
  onUpdateAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('updates:available', listener);
    return () => ipcRenderer.removeListener('updates:available', listener);
  },

  // Utilities
  openFolder: (absPath) => ipcRenderer.invoke('shell:openFolder', absPath),
  navigate: (screen) => ipcRenderer.send('nav:go', screen),
});
