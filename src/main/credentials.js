/**
 * src/main/credentials.js
 *
 * Encrypted credential storage backed by Electron's safeStorage (OS keychain /
 * DPAPI on Windows). No native module to rebuild, no extra dependency.
 *
 * File: userData/creds.enc
 * NEVER writes plaintext credentials to disk, and never logs credential
 * values.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

function credsPath() {
  return path.join(app.getPath('userData'), 'creds.enc');
}

const REQUIRED_FIELDS = ['taiUser', 'taiPass', 'ctsiUser', 'ctsiPass'];

function isValidCreds(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return REQUIRED_FIELDS.every((k) => typeof obj[k] === 'string' && obj[k].length > 0);
}

/**
 * @param {{taiUser:string, taiPass:string, ctsiUser:string, ctsiPass:string}} creds
 */
function saveCreds(creds) {
  if (!isValidCreds(creds)) {
    throw new Error('Invalid login details; all fields (TAI + CTSI username and password) are required.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage unavailable on this machine; login details cannot be saved.');
  }
  const json = JSON.stringify({
    taiUser: creds.taiUser || '',
    taiPass: creds.taiPass || '',
    ctsiUser: creds.ctsiUser || '',
    ctsiPass: creds.ctsiPass || '',
  });
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(credsPath(), encrypted);
}

/**
 * @returns {{taiUser:string, taiPass:string, ctsiUser:string, ctsiPass:string} | null}
 */
function loadCreds() {
  try {
    const buf = fs.readFileSync(credsPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    const json = safeStorage.decryptString(buf);
    const obj = JSON.parse(json);
    return isValidCreds(obj) ? obj : null;
  } catch {
    return null;
  }
}

function clearCreds() {
  sessionCreds = null; // also drop any in-memory session-only creds
  const p = credsPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

function hasCreds() {
  // File-backed only: this drives the login auto-skip, which must NOT trigger
  // for session-only (unsaved) creds.
  return isValidCreds(loadCreds());
}

// ── Session-only credentials (in-memory, never persisted) ──────────────────
// When the user unchecks "Save login details", creds are held here for the
// life of the app process instead of being written to disk. This survives the
// login.html -> main.html loadFile navigation (unlike renderer sessionStorage,
// which is not shared across file:// documents' opaque origins).
let sessionCreds = null;

function setSessionCreds(creds) {
  sessionCreds = isValidCreds(creds) ? creds : null;
}

function getSessionCreds() {
  return sessionCreds;
}

/**
 * Creds to actually run with: prefer the in-memory session set (unsaved run),
 * else the persisted encrypted set. Returns null if neither is present.
 */
function getEffectiveCreds() {
  return sessionCreds || loadCreds();
}

module.exports = {
  saveCreds,
  loadCreds,
  clearCreds,
  hasCreds,
  setSessionCreds,
  getSessionCreds,
  getEffectiveCreds,
};
