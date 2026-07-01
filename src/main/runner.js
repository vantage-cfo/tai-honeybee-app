/**
 * src/main/runner.js
 *
 * Bridges IPC <-> src/automation/run.js. Owns the single-run-at-a-time state,
 * the pending confirm-before-upload gate, and the cancel flag. Streams
 * ProgressEvents to the given webContents via the 'run:progress' channel.
 */

const path = require('path');
const { app } = require('electron');
const { run } = require('../automation/run');

let active = false;
let cancelFlag = false;
let pendingConfirmResolve = null;

function isRunActive() {
  return active;
}

/**
 * @param {RunParams} params
 * @param {import('electron').WebContents} sender
 * @returns {Promise<void>} resolves once the run is ACCEPTED (not once it finishes)
 */
async function startRun(params, sender) {
  if (active) {
    throw new Error('A run is already in progress.');
  }
  active = true;
  cancelFlag = false;
  pendingConfirmResolve = null;

  const downloadDir = path.join(app.getPath('userData'), 'downloads');
  const splitDir = path.join(app.getPath('userData'), 'split-output');

  const emit = (evt) => {
    if (sender && !sender.isDestroyed()) {
      sender.send('run:progress', evt);
    }
  };

  const awaitConfirm = () =>
    new Promise((resolve) => {
      pendingConfirmResolve = resolve;
    });

  const isCancelled = () => cancelFlag;

  // Echo the resolved params (WITHOUT credentials) so the run log can confirm
  // what will actually be sent — see spec acceptance criterion 8.
  emit({
    type: 'log',
    level: 'info',
    message:
      `Starting run: payer="${params.taiPayerName}" customerId=${params.taiCustomerId ?? 'null'} ` +
      `ctsiAccount=${params.ctsiAccount} range=${params.startDate}..${params.endDate} ` +
      `visualRun=${params.visualRun}`,
  });

  // Run in the background; do not await here so `run:start` resolves once
  // accepted (per IPC contract).
  run(params, emit, awaitConfirm, isCancelled, { downloadDir, splitDir })
    .catch(() => {
      // run() already emitted { type: 'error' } before rethrowing; swallow
      // here so we don't produce an unhandled rejection.
    })
    .finally(() => {
      active = false;
      cancelFlag = false;
      pendingConfirmResolve = null;
    });
}

/**
 * Resolve the pending confirm-before-upload gate.
 * @param {boolean} proceed
 */
function confirmUpload(proceed) {
  if (pendingConfirmResolve) {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve(!!proceed);
  }
}

/**
 * Request cancellation of the active run. If a confirm gate is pending,
 * resolve it with `false` (abort) so the run unblocks and exits cleanly.
 */
function cancelRun() {
  cancelFlag = true;
  if (pendingConfirmResolve) {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve(false);
  }
}

module.exports = { startRun, confirmUpload, cancelRun, isRunActive };
