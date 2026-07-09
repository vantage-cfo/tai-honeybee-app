/**
 * src/renderer/app.js — main screen logic.
 */

(function () {
  const STAGES = [
    { key: 'tai-login', label: 'TAI Login' },
    { key: 'download', label: 'Download' },
    { key: 'split', label: 'Split' },
    { key: 'ctsi-login', label: 'CTSI Login' },
    { key: 'upload', label: 'Upload' },
  ];

  const signoutBtn = document.getElementById('signout-btn');
  const resultBanner = document.getElementById('result-banner');
  const resultBannerText = document.getElementById('result-banner-text');
  const resultBannerDismiss = document.getElementById('result-banner-dismiss');

  const runForm = document.getElementById('run-form');
  const runBtn = document.getElementById('run-btn');
  const payerSelect = document.getElementById('payer');
  const accountSelect = document.getElementById('account');
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  const visualRunCheckbox = document.getElementById('visualRun');

  const progressSection = document.getElementById('progress-section');
  const stageTracker = document.getElementById('stage-tracker');
  const cancelRunBtn = document.getElementById('cancel-run-btn');

  const splitPanel = document.getElementById('split-panel');
  const splitFileList = document.getElementById('split-file-list');
  const reviewFilesBtn = document.getElementById('review-files-btn');

  const confirmPanel = document.getElementById('confirm-panel');
  const confirmPanelText = document.getElementById('confirm-panel-text');
  const confirmOpenFolderBtn = document.getElementById('confirm-open-folder-btn');
  const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
  const confirmUploadBtn = document.getElementById('confirm-upload-btn');

  const batchPanel = document.getElementById('batch-panel');
  const batchList = document.getElementById('batch-list');

  const runLog = document.getElementById('run-log');
  const copyLogBtn = document.getElementById('copy-log-btn');

  let payers = [];
  let accounts = [];
  let currentSplitDir = null;
  let batchRows = {}; // index -> row element

  // ── Sign out ──────────────────────────────────────────────────────────
  signoutBtn.addEventListener('click', async () => {
    // clearCreds deletes the persisted file AND drops the in-memory session set.
    await window.boost.clearCreds();
    window.boost.navigate('login');
  });

  // ── Result banner ────────────────────────────────────────────────────
  function showBanner(kind, message) {
    resultBanner.className = `banner visible banner-${kind}`;
    resultBannerText.textContent = message;
  }
  function hideBanner() {
    resultBanner.className = 'banner';
  }
  resultBannerDismiss.addEventListener('click', hideBanner);

  // ── Options ───────────────────────────────────────────────────────────
  async function loadOptions() {
    const opts = await window.boost.getOptions();
    payers = opts.payers;
    accounts = opts.accounts;

    payerSelect.innerHTML = payers
      .map((p, i) => `<option value="${i}">${escapeHtml(p.label)}</option>`)
      .join('');
    accountSelect.innerHTML = accounts
      .map((a, i) => `<option value="${i}">${escapeHtml(a.label)}</option>`)
      .join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Stage tracker ─────────────────────────────────────────────────────
  function renderStageTracker() {
    stageTracker.innerHTML = STAGES.map(
      (s) => `
      <div class="stage-row pending" data-stage="${s.key}">
        <span class="stage-icon">&#10003;</span>
        <span class="stage-label">${s.label}</span>
      </div>`
    ).join('');
  }

  function setStageStatus(stageKey, status) {
    const row = stageTracker.querySelector(`[data-stage="${stageKey}"]`);
    if (!row) return;
    row.classList.remove('pending', 'active', 'done', 'error');
    if (status === 'start') row.classList.add('active');
    else if (status === 'done') row.classList.add('done');
    else if (status === 'error') row.classList.add('error');
    else row.classList.add('pending');
  }

  // ── Run log ───────────────────────────────────────────────────────────
  function appendLog(line) {
    const ts = new Date().toLocaleTimeString();
    runLog.value += `[${ts}] ${line}\n`;
    runLog.scrollTop = runLog.scrollHeight;
  }

  copyLogBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(runLog.value);
      copyLogBtn.textContent = 'Copied!';
      setTimeout(() => (copyLogBtn.textContent = 'Copy log'), 1500);
    } catch {
      runLog.select();
      document.execCommand('copy');
    }
  });

  // ── Form validation ───────────────────────────────────────────────────
  function clearFieldError(id) {
    const wrapper = document.getElementById(`field-${id}`);
    if (wrapper) wrapper.classList.remove('has-error');
    const input = document.getElementById(id);
    if (input) input.classList.remove('field-error');
  }
  function setFieldError(id) {
    const wrapper = document.getElementById(`field-${id}`);
    if (wrapper) wrapper.classList.add('has-error');
    const input = document.getElementById(id);
    if (input) input.classList.add('field-error');
  }

  function validateForm() {
    let valid = true;
    ['startDate', 'endDate'].forEach(clearFieldError);

    if (!startDateInput.value) {
      setFieldError('startDate');
      valid = false;
    }
    if (!endDateInput.value) {
      setFieldError('endDate');
      valid = false;
    }
    if (startDateInput.value && endDateInput.value && startDateInput.value > endDateInput.value) {
      setFieldError('endDate');
      valid = false;
    }
    return valid;
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────
  function setRunning(running) {
    runBtn.disabled = running;
    // Disable Sign out mid-run (MED-6): signing out clears creds and strands
    // the active run, blocking new runs until an app restart.
    signoutBtn.disabled = running;
    cancelRunBtn.style.display = running ? '' : 'none';
  }

  async function ensureCreds() {
    // The main process owns the plaintext creds (MED-2). We only ask whether a
    // run can proceed; the actual values are merged into the run params in the
    // main process. Preserves the "No saved login details" error path.
    const hasCreds = await window.boost.hasEffectiveCreds();
    if (!hasCreds) {
      throw new Error('No saved login details found. Please sign in again.');
    }
  }

  runForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBanner();
    if (!validateForm()) return;

    try {
      await ensureCreds();
    } catch (err) {
      showBanner('error', err.message);
      return;
    }

    const payer = payers[Number(payerSelect.value)];
    const account = accounts[Number(accountSelect.value)];

    const params = {
      taiPayerName: payer.label,
      taiCustomerId: payer.customerId,
      startDate: startDateInput.value,
      endDate: endDateInput.value,
      ctsiAccount: account.account,
      visualRun: visualRunCheckbox.checked,
    };

    // Reset progress UI for a fresh run.
    renderStageTracker();
    splitPanel.classList.add('hidden');
    confirmPanel.classList.add('hidden');
    batchPanel.classList.add('hidden');
    batchList.innerHTML = '';
    batchRows = {};
    runLog.value = '';
    progressSection.classList.remove('hidden');
    setRunning(true);

    try {
      await window.boost.startRun(params);
    } catch (err) {
      setRunning(false);
      showBanner('error', err && err.message ? err.message : 'Could not start run.');
    }
  });

  cancelRunBtn.addEventListener('click', async () => {
    await window.boost.cancelRun();
  });

  // ── Split / confirm / batch UI ────────────────────────────────────────
  reviewFilesBtn.addEventListener('click', () => {
    if (currentSplitDir) window.boost.openFolder(currentSplitDir);
  });

  confirmOpenFolderBtn.addEventListener('click', () => {
    if (currentSplitDir) window.boost.openFolder(currentSplitDir);
  });

  confirmCancelBtn.addEventListener('click', async () => {
    await window.boost.confirmUpload(false);
  });

  confirmUploadBtn.addEventListener('click', async () => {
    confirmPanel.classList.add('hidden');
    await window.boost.confirmUpload(true);
  });

  function renderBatchRow(evt) {
    let row = batchRows[evt.index];
    if (!row) {
      row = document.createElement('div');
      row.className = 'batch-row';
      batchList.appendChild(row);
      batchRows[evt.index] = row;
    }
    const statusText = evt.status === 'done' ? 'Done' : 'Uploading…';
    const batchIdText = evt.batchId ? ` — ${escapeHtml(evt.batchId)}` : '';
    row.innerHTML = `<span>Batch ${evt.index}/${evt.total} — ${evt.count} files</span><span class="batch-status ${evt.status}">${statusText}${batchIdText}</span>`;
  }

  // ── Progress event dispatch ───────────────────────────────────────────
  function handleEvent(evt) {
    switch (evt.type) {
      case 'stage':
        setStageStatus(evt.stage, evt.status);
        appendLog(`${evt.stage} ${evt.status}${evt.message ? ' — ' + evt.message : ''}`);
        break;

      case 'log':
        appendLog(evt.message);
        break;

      case 'split': {
        currentSplitDir = null; // filled in by confirm-request (has splitDir)
        splitPanel.classList.remove('hidden');
        splitFileList.innerHTML = evt.files
          .map((f) => `<div>${escapeHtml(f.split(/[\\/]/).pop())}</div>`)
          .join('');
        appendLog(`Split into ${evt.files.length} file(s).`);
        break;
      }

      case 'confirm-request': {
        currentSplitDir = evt.splitDir;
        confirmPanel.classList.remove('hidden');
        confirmPanelText.textContent =
          `${evt.files.length} invoices split into ${evt.batches} batch(es) of up to 20. ` +
          `Review the PDFs, then confirm to upload to CTSI. This cannot be undone.`;
        appendLog(`Awaiting confirmation to upload (${evt.files.length} files, ${evt.batches} batches).`);
        break;
      }

      case 'batch':
        batchPanel.classList.remove('hidden');
        renderBatchRow(evt);
        appendLog(
          `Batch ${evt.index}/${evt.total} (${evt.count} files) ${evt.status}` +
            (evt.batchId ? ` — ${evt.batchId}` : '')
        );
        break;

      case 'done':
        setRunning(false);
        showBanner(
          'success',
          `Run complete. Batch ID(s): ${evt.batchIds.join(', ') || '(none)'}`
        );
        appendLog(`Done. Batch ID(s): ${evt.batchIds.join(', ')}`);
        break;

      case 'error':
        setRunning(false);
        confirmPanel.classList.add('hidden');
        showBanner('error', `${evt.message}${evt.stage ? ` (stage: ${evt.stage})` : ''}`);
        appendLog(`ERROR: ${evt.message}${evt.stage ? ` (stage: ${evt.stage})` : ''}`);
        if (evt.stage) setStageStatus(evt.stage, 'error');
        break;

      case 'cancelled':
        setRunning(false);
        confirmPanel.classList.add('hidden');
        showBanner('neutral', 'Run cancelled.');
        appendLog('Run cancelled.');
        break;

      default:
        break;
    }
  }

  window.boost.onProgress(handleEvent);

  // ── Init ──────────────────────────────────────────────────────────────
  (async function init() {
    renderStageTracker();
    setRunning(false);
    await loadOptions();
  })();
})();
