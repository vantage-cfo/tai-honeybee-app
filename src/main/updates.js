/**
 * src/main/updates.js
 *
 * New-release check. Polls the public GitHub Releases API for this repo and
 * remembers whether a release newer than the running app exists. Main-process
 * only: the renderer learns just `{ version }` and can ask main to open the
 * fixed releases page in the system browser — it can never influence which
 * URL is fetched or opened.
 */

const { app, net, shell } = require('electron');

// Fixed URLs. RELEASES_PAGE is what the user's browser opens; the API URL is
// what main fetches. Both constants — never renderer- or API-supplied.
const LATEST_RELEASE_API =
  'https://api.github.com/repos/vantage-cfo/tai-honeybee-app/releases/latest';
const RELEASES_PAGE = 'https://github.com/vantage-cfo/tai-honeybee-app/releases/latest';

// Re-check while the app stays open (long-running days are normal here).
// Unauthenticated GitHub API allows 60 req/hr/IP, so this is far under quota.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let latestUpdate = null; // { version: 'x.y.z' } once a newer release is seen

// Accepts 'v1.2.3' / '1.2.3' (release tags are 'vX.Y.Z'); ignores any suffix.
function parseVersion(value) {
  const m = String(value || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
  for (let i = 0; i < 3; i += 1) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

async function checkOnce() {
  // net.fetch goes through Chromium's network stack, so it honors any system
  // proxy the user's Windows box is behind (plain Node fetch would not).
  const res = await net.fetch(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub releases API responded ${res.status}`);
  const release = await res.json();

  const remote = parseVersion(release && release.tag_name);
  const local = parseVersion(app.getVersion());
  if (remote && local && isNewer(remote, local)) {
    return { version: remote.join('.') };
  }
  return null;
}

/**
 * Start the periodic check. `getWindow` is called at notify time so the event
 * always targets the current BrowserWindow (it can be recreated on macOS).
 * The push covers a window that is already open; a freshly (re)loaded page
 * instead pulls the cached result via the 'updates:get' IPC on init.
 */
function start(getWindow) {
  const tick = async () => {
    try {
      const update = await checkOnce();
      if (update && (!latestUpdate || latestUpdate.version !== update.version)) {
        latestUpdate = update;
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('updates:available', latestUpdate);
        }
      }
    } catch {
      // Offline, rate-limited, or API hiccup: stay quiet, try again next tick.
      // The button simply doesn't appear — never block or nag the user.
    }
  };
  tick();
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
}

function getStatus() {
  return latestUpdate;
}

function openDownloadPage() {
  return shell.openExternal(RELEASES_PAGE);
}

module.exports = { start, getStatus, openDownloadPage };
