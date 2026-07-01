/**
 * src/automation/run.js
 *
 * Ported from ../../playwright-script.spec.ts. This is a mechanical refactor:
 * all selectors, flows, and gotchas are preserved verbatim. test()/expect()
 * calls become plain control flow + thrown Errors; console.* calls become
 * emit({ type: 'log', ... }) calls; the whole run is wrapped in try/finally so
 * the browser always closes.
 *
 * Net-new behavior vs. the reference script (see spec §4.4 / §4.5):
 *   - Payer-by-name autocomplete selection (works even when customerId is
 *     unknown for a payer).
 *   - A confirm-before-upload gate between split and CTSI login.
 *
 * @param {RunParams} params
 * @param {(evt: ProgressEvent) => void} emit        progress callback
 * @param {() => Promise<boolean>} awaitConfirm       resolves true=proceed, false=abort (the confirm gate)
 * @param {() => boolean} isCancelled                 polled at safe points
 * @param {{ downloadDir: string, splitDir: string }} dirs  absolute output dirs (under userData)
 * @returns {Promise<{ batchIds: string[] }>}
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { splitInvoices } = require('../../split-invoices.js');

const MAX_PER_BATCH = 20; // CTSI accepts at most 20 files per submit

// Pace every Playwright action by this many ms. The TAI/CTSI sites are
// client-rendered SPAs (Angular/PrimeNG + Kendo) whose controls settle a beat
// AFTER networkidle; firing actions at full speed raced past the two-step login
// and reached for "Show Advanced" before the invoice-search toolbar rendered
// (login completed in ~2s, then a 30s timeout). The validated dry-run scripts
// used slowMo (300-350ms) and worked end-to-end, so we match that here. It also
// makes a visual run watchable.
const SLOW_MO_MS = 300;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CTSI_APP_URL = 'https://portal.ctsi-global.com/TMSV5/apploader/C17';
const CTSI_DASHBOARD_URL = 'https://portal.ctsi-global.com/TMSV5/apps/Dashboard';
const CTSI_CARRIER = 'BOVT - BOOST TRANSPORT';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Resolve the full-Chromium chrome.exe under PLAYWRIGHT_BROWSERS_PATH, if that
 * env var points at an on-disk browsers dir (set by main.js in the packaged
 * app). Used only as a fallback if the normal launch can't find the browser.
 * Returns undefined in dev (where Playwright resolves the browser itself).
 */
function resolveChromiumExecutable() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || base === '0') return undefined;
  try {
    const revs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
      .sort();
    for (const rev of revs.reverse()) {
      const exe = path.join(base, rev, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/**
 * Launch Chromium.
 *
 * In the PACKAGED app, main.js sets PLAYWRIGHT_BROWSERS_PATH to the unpacked
 * .local-browsers dir, so resolveChromiumExecutable() finds the full-Chromium
 * chrome.exe on disk. We launch that binary explicitly (via executablePath) for
 * BOTH headed and headless runs — full Chromium runs headless fine, and this
 * avoids depending on the separate chrome-headless-shell binary (one less
 * moving part in the bundle, and it sidesteps the asar path-resolution bug that
 * pointed launches inside app.asar → ENOENT).
 *
 * In DEV (PLAYWRIGHT_BROWSERS_PATH unset or '0'), resolveChromiumExecutable()
 * returns undefined and Playwright resolves the browser itself as usual.
 */
async function launchChromium(visualRun) {
  const opts = { headless: !visualRun, acceptDownloads: true, slowMo: SLOW_MO_MS };
  const executablePath = resolveChromiumExecutable();
  if (executablePath) opts.executablePath = executablePath;
  return await chromium.launch(opts);
}

/**
 * Strip a payer dropdown label down to its core name for the TAI autocomplete.
 * Labels look like "CM - Binghamton (2031) c/o CTSI"; the autocomplete wants
 * just "CM - Binghamton" (drop everything from the first "(").
 */
function coreName(label) {
  return label.replace(/\s*\(.*$/, '').trim();
}

/**
 * Select a single day in the open PrimeNG (p-datepicker) calendar.
 *
 * Navigates to the target month via the Prev/Next Month arrows (reading the
 * header's month + year labels), then clicks the exact in-month day cell by its
 * `data-date` attribute. `data-date` is "YYYY-M-D" — month & day are NOT
 * zero-padded and month is 1-based (e.g. "2026-7-1"). Works for any date.
 *
 * @param scope The page (or frame) whose calendar popup is open.
 * @param iso   Date as "YYYY-MM-DD".
 */
async function pickDayInOpenCalendar(scope, iso) {
  const [y, m, d] = iso.split('-').map(Number); // m is 1-based

  // Walk the calendar to the target month/year.
  for (let guard = 0; guard < 400; guard++) {
    const monthName = (await scope.locator('.p-datepicker-month').first().innerText()).trim();
    const year = parseInt((await scope.locator('.p-datepicker-year').first().innerText()).trim(), 10);
    const curMonth = MONTH_NAMES.indexOf(monthName) + 1;
    if (curMonth === m && year === y) break;
    const goPrev = year > y || (year === y && curMonth > m);
    await scope
      .locator(`button[aria-label="${goPrev ? 'Previous' : 'Next'} Month"]`)
      .click();
    await scope.waitForTimeout(120); // let the month animate/re-render
  }

  // Click the day that belongs to the current month (not a leading/trailing
  // day borrowed from an adjacent month).
  await scope
    .locator(`td:not(.p-datepicker-other-month) span[data-date="${y}-${m}-${d}"]`)
    .click();
}

/**
 * Fill the "Invoice Date" range filter: open the picker, click start then end
 * (PrimeNG range mode), then apply with Search.
 */
async function applyInvoiceDateRange(scope, startIso, endIso) {
  await scope.getByRole('button', { name: 'Show Advanced' }).click();
  await scope.getByRole('combobox', { name: 'Start - End' }).click();
  await pickDayInOpenCalendar(scope, startIso); // range start
  await pickDayInOpenCalendar(scope, endIso); // range end
  await scope.getByRole('button', { name: 'Search' }).click();
  await scope.waitForLoadState('networkidle');
}

/**
 * Select the payer by name via the TAI autocomplete (#selectedOrganization).
 * See spec §4.4. Defensive: a missing input is only fatal when there is no
 * customerId fallback (i.e. direct-nav by ID did not happen).
 */
async function selectPayerByName(page, taiPayerName, taiCustomerId, emit) {
  const core = coreName(taiPayerName);
  const input = page.locator('#selectedOrganization');
  const visible = await input.isVisible().catch(() => false);

  if (!visible) {
    if (taiCustomerId) {
      // Fast path already navigated by ID; autocomplete just isn't present
      // on this view. Non-fatal.
      emit({ type: 'log', level: 'info', message: 'Payer autocomplete not present; continuing with direct customerId navigation.' });
      return;
    }
    throw new Error(`Could not find payer "${core}" in TAI's payer search.`);
  }

  await input.click();
  await input.fill(core);

  // Wait for the autocomplete option list to render.
  const option = page.getByRole('option').filter({ hasText: core }).first();
  const found = await option
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    if (taiCustomerId) {
      emit({ type: 'log', level: 'warn', message: `Payer autocomplete found no match for "${core}"; continuing with direct customerId navigation.` });
      return;
    }
    throw new Error(`Could not find payer "${core}" in TAI's payer search.`);
  }

  await option.click();
  await page.waitForLoadState('networkidle');
}

/**
 * Log in to CTSI (auth0 Lock widget) and confirm the app is reachable.
 * The auth0 form can be slow/flaky, so we retry the whole login up to 3×.
 */
async function ctsiLogin(page, ctsiUser, ctsiPass, emit) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CTSI_APP_URL, { waitUntil: 'domcontentloaded' });
      const userInput = page.locator('input[name="username"]');
      const showsLogin = await userInput
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (showsLogin) {
        await userInput.fill(ctsiUser);
        await page.locator('input[name="password"]').fill(ctsiPass);
        await page.locator('button.auth0-lock-submit').click();
        await page.waitForURL(/portal\.ctsi-global\.com\/TMSV5/, { timeout: 30000 });
      }
      // Confirm we're really in: the Invoice Upload link must be reachable.
      await page.goto(CTSI_DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Invoice Upload' }).waitFor({ timeout: 20000 });
      emit({ type: 'log', level: 'info', message: `CTSI logged in (attempt ${attempt}).` });
      return;
    } catch (e) {
      emit({ type: 'log', level: 'warn', message: `CTSI login attempt ${attempt} failed: ${String(e.message).split('\n')[0]}` });
    }
  }
  throw new Error('CTSI login failed after 3 attempts.');
}

/**
 * From the dashboard, open Invoice Upload, pick carrier + account, and wait for
 * the upload widget to finish initializing. Returns the iframe's FrameLocator.
 * Called once per batch so multi-batch uploads always start from a clean form.
 */
async function ctsiReachUploadScreen(page, ctsiAccount) {
  await page.goto(CTSI_DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Invoice Upload' }).click();
  const frame = page.locator('iframe').contentFrame();

  // Carrier dropdown (always Boost).
  await frame.locator('span').nth(2).click();
  await frame.getByRole('option', { name: CTSI_CARRIER }).click();

  // Account dropdown — app-driven selection (ctsiAccount, e.g. "2036").
  await frame
    .locator('div:nth-child(4) > .full-width > .k-dropdown-wrap > .k-select > .k-icon')
    .click();
  await frame.getByRole('option').filter({ hasText: ctsiAccount }).first().click();

  await frame.getByRole('button', { name: 'Go To Upload' }).click();

  // The upload widget shows "Initializing…" first; wait for the file picker
  // ("SELECT FILES..." — accessible name "Choose File") to render.
  await frame
    .getByRole('button', { name: 'Choose File' })
    .waitFor({ state: 'visible', timeout: 30000 });
  return frame;
}

async function run(params, emit, awaitConfirm, isCancelled, dirs) {
  const { downloadDir, splitDir } = dirs;
  let browser = null;
  let stage = null;

  try {
    // Fresh output dirs so we never re-upload stale split PDFs.
    fs.rmSync(splitDir, { recursive: true, force: true });
    fs.mkdirSync(downloadDir, { recursive: true });

    browser = await launchChromium(params.visualRun);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    // ── STEP 1: TAI login (two-step) ──────────────────────────────────────
    stage = 'tai-login';
    emit({ type: 'stage', stage, status: 'start' });
    await page.goto('https://atl.taicloud.net/');
    await page.getByRole('link', { name: 'Other ways to sign in' }).click();
    await page.getByRole('textbox', { name: 'Username' }).fill(params.taiUser);
    await page.locator('#login-method-form-user-row').getByRole('button').click();
    await page.getByRole('textbox', { name: 'Password' }).fill(params.taiPass);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForLoadState('networkidle');
    emit({ type: 'stage', stage, status: 'done' });

    // ── STEP 2: open the selected customer's invoices (direct-nav) ───────
    // Instead of clicking the fragile balance link (which changes daily), we
    // navigate straight to the invoice search for the selected customer.
    const asOfDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (today)
    const customerIdQuery = params.taiCustomerId
      ? `customerId=${encodeURIComponent(params.taiCustomerId)}&`
      : '';
    await page.goto(
      `https://atl.taicloud.net/back-office/accounting/invoice-search` +
        `?${customerIdQuery}daysOverDue=0&asOfDate=${asOfDate}`
    );
    await page.waitForLoadState('networkidle');

    // ── Payer selection (§4.4) ────────────────────────────────────────────
    // PRIMARY path: direct-nav by customerId above. Every known payer now
    // carries a verified customerId (shared/payers.js), extracted from TAI's
    // own collections-summary hrefs, so direct-nav is authoritative — this is
    // exactly what the validated reference script did.
    //
    // FAILSAFE BACKUP: the payer-by-name autocomplete (#selectedOrganization)
    // is invoked ONLY when a payer has no known customerId (taiCustomerId is
    // null) — e.g. a future payer added to the dropdown without an ID yet.
    if (!params.taiCustomerId) {
      await selectPayerByName(page, params.taiPayerName, params.taiCustomerId, emit);
    }

    // ── STEP 3: apply the Invoice Date range filter (app-configured) ─────
    // Show Advanced → pick start/end in the PrimeNG range picker → Search.
    await applyInvoiceDateRange(page, params.startDate, params.endDate);

    // ── STEP 4: select all invoices and download the merged PDF ──────────
    stage = 'download';
    emit({ type: 'stage', stage, status: 'start' });
    // The "Download (N)" button in "Bulk Operations" only renders reliably after
    // the selection is toggled, so ALWAYS un-check and re-check "select all".
    // (Retry the toggle a couple times in case it still doesn't appear.)
    const selectAll = page.locator('#selectAll');
    const downloadBtn = page.getByRole('button', { name: /^Download/ });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await selectAll.check();
      await page.waitForTimeout(400);
      await selectAll.uncheck();
      await page.waitForTimeout(400);
      await selectAll.check();
      await page.waitForTimeout(700);
      if (await downloadBtn.isVisible().catch(() => false)) break;
      emit({ type: 'log', level: 'info', message: `  Download button still hidden after toggle (attempt ${attempt}).` });
    }
    await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

    const mergedPath = path.join(downloadDir, 'merged-invoices.pdf');
    const ctx = page.context();
    // The merge can be slow, and TAI may either fire a real download or open the
    // PDF inline in a new tab. Listen for both at the context level (long timeout).
    const downloadPromise = ctx.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    const popupPromise = ctx.waitForEvent('page', { timeout: 120000 }).catch(() => null);
    await downloadBtn.click(); // "Download (N)"
    const result = await Promise.race([
      downloadPromise,
      popupPromise.then((p) => (p ? { __popup: p } : null)),
    ]);

    if (result && !result.__popup) {
      await result.saveAs(mergedPath);
    } else {
      // Inline PDF opened in a new tab — fetch its bytes using the session cookies.
      const popup = result?.__popup || (await popupPromise);
      if (!popup) throw new Error('No download event and no popup tab after Download click.');
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const resp = await ctx.request.get(popup.url());
      fs.writeFileSync(mergedPath, await resp.body());
      await popup.close().catch(() => {});
    }
    if (!fs.existsSync(mergedPath)) {
      throw new Error(`Merged PDF was not downloaded (no file at ${mergedPath}).`);
    }
    emit({ type: 'log', level: 'info', message: `Downloaded merged PDF -> ${mergedPath}` });
    emit({ type: 'stage', stage, status: 'done' });

    // ── STEP 5: split the merged PDF by Boost cover page ──────────────────
    stage = 'split';
    emit({ type: 'stage', stage, status: 'start' });
    const splitFiles = await splitInvoices(mergedPath, splitDir);
    if (!(splitFiles.length > 0)) {
      throw new Error('No invoices were split out of the merged PDF (no Boost cover pages found).');
    }
    emit({ type: 'log', level: 'info', message: `Split into ${splitFiles.length} invoice PDF(s).` });
    emit({ type: 'split', files: splitFiles });
    emit({ type: 'stage', stage, status: 'done' });

    // ── CONFIRM GATE (NEW, §4.5) ──────────────────────────────────────────
    const batchCount = Math.ceil(splitFiles.length / MAX_PER_BATCH);
    emit({ type: 'confirm-request', splitDir, files: splitFiles, batches: batchCount });
    const proceed = await awaitConfirm();
    if (!proceed) {
      emit({ type: 'cancelled' });
      return { batchIds: [] };
    }
    if (isCancelled()) {
      emit({ type: 'cancelled' });
      return { batchIds: [] };
    }

    // ── STEP 6: CTSI login (auth0 Lock, with retry) ────────────────────────
    stage = 'ctsi-login';
    emit({ type: 'stage', stage, status: 'start' });
    await ctsiLogin(page, params.ctsiUser, params.ctsiPass, emit);
    emit({ type: 'stage', stage, status: 'done' });

    // ── STEP 7 & 8: upload the split PDFs in batches of ≤20, submit each ──
    stage = 'upload';
    emit({ type: 'stage', stage, status: 'start' });
    // CTSI allows at most 20 files per submission ("Drop files here… (Max 20)").
    // We re-open a fresh upload screen (carrier + account + Go To Upload) for
    // each batch so multi-batch runs always start clean.
    const batches = chunk(splitFiles, MAX_PER_BATCH);
    emit({ type: 'log', level: 'info', message: `Uploading ${splitFiles.length} file(s) in ${batches.length} batch(es) of up to ${MAX_PER_BATCH}.` });

    const batchIds = [];
    for (let b = 0; b < batches.length; b++) {
      if (isCancelled()) {
        emit({ type: 'cancelled' });
        return { batchIds };
      }
      const batch = batches[b];
      emit({ type: 'batch', index: b + 1, total: batches.length, count: batch.length, status: 'start' });

      const frame = await ctsiReachUploadScreen(page, params.ctsiAccount);

      // Set this batch on the multi-file input (name="files", accepts up to 20).
      await frame.locator('input[type="file"]').setInputFiles(batch);

      // Submit for processing (button reads "Submit Files for Processing").
      await frame
        .getByRole('button', { name: /Submit Files? for Processing/i })
        .click();

      // Don't wait for networkidle — CTSI keeps the network busy while processing.
      // Instead wait for the success confirmation: a "Batch ID" is assigned.
      const batchIdText = frame.getByText(/Batch ID/i);
      await batchIdText.waitFor({ state: 'visible', timeout: 90000 });
      const confirmation = (await batchIdText.innerText().catch(() => '')).trim();
      batchIds.push(confirmation || `Batch ${b + 1}`);
      emit({ type: 'batch', index: b + 1, total: batches.length, count: batch.length, status: 'done', batchId: confirmation || undefined });
    }

    emit({ type: 'stage', stage, status: 'done' });
    emit({ type: 'log', level: 'info', message: 'All batches submitted.' });
    emit({ type: 'done', batchIds });
    return { batchIds };
  } catch (err) {
    emit({ type: 'error', message: err && err.message ? err.message : String(err), stage: stage || undefined });
    throw err;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { run, coreName };
