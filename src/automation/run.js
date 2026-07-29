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

// How many TAI invoices to tick + download at once. TAI's "select all" download
// builds one combined PDF that grows too large to download once a date range has
// enough invoices, so we pull the list in bite-size merged PDFs instead. 20 also
// happens to be CTSI's per-batch max, so a chunk tends to map to one upload batch
// — but the two are independent: splitFiles is re-chunked by MAX_PER_BATCH below.
const DOWNLOAD_CHUNK = 20;

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

// Per-keystroke delay (ms) for typing into text fields. slowMo paces the gaps
// BETWEEN actions, but locator.fill() still pastes a value instantly — which
// anti-bot systems flag. Typing character-by-character with this delay makes
// credential/search entry look human. Applied to ALL text inputs.
const TYPE_DELAY_MS = 90;

/**
 * Type into a field the way a person would: focus it, clear any autofill, then
 * press keys one at a time with a delay. Use for EVERY text input instead of
 * locator.fill() (which sets the whole value at once, with no keystrokes).
 */
async function typeInto(locator, text) {
  await locator.click();
  await locator.fill(''); // clear any pre-filled/autofilled value first
  await locator.pressSequentially(text, { delay: TYPE_DELAY_MS });
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
 * `data-date` attribute.
 *
 * TAI upgraded PrimeNG (seen live 2026-07-29), which reshaped the datepicker:
 *   - the header month/year labels are now BUTTONS `.p-datepicker-select-month`
 *     / `.p-datepicker-select-year` (were `.p-datepicker-month` /
 *     `.p-datepicker-year` — waiting on those was the 30s timeout);
 *   - `data-date` months are now 0-BASED ("2026-6-1" = July 1); the old panel
 *     was 1-based ("2026-7-1"). Day & month remain non-zero-padded.
 * The Prev/Next buttons kept their aria-labels and adjacent-month cells still
 * carry `p-datepicker-other-month`. Header and day selectors below accept BOTH
 * generations (comma-joined CSS; only one can exist in the open panel once
 * we're on the target month), so a TAI rollback won't re-break this.
 *
 * @param scope The page (or frame) whose calendar popup is open.
 * @param iso   Date as "YYYY-MM-DD".
 */
async function pickDayInOpenCalendar(scope, iso) {
  const [y, m, d] = iso.split('-').map(Number); // m is 1-based

  const monthHeader = scope.locator('.p-datepicker-select-month, .p-datepicker-month').first();
  const yearHeader = scope.locator('.p-datepicker-select-year, .p-datepicker-year').first();

  // Walk the calendar to the target month/year.
  for (let guard = 0; guard < 400; guard++) {
    const monthName = (await monthHeader.innerText()).trim();
    const year = parseInt((await yearHeader.innerText()).trim(), 10);
    const curMonth = MONTH_NAMES.indexOf(monthName) + 1;
    if (curMonth === m && year === y) break;
    const goPrev = year > y || (year === y && curMonth > m);
    await scope
      .locator(`button[aria-label="${goPrev ? 'Previous' : 'Next'} Month"]`)
      .click();
    await scope.waitForTimeout(120); // let the month animate/re-render
  }

  // Click the day that belongs to the current month (not a leading/trailing
  // day borrowed from an adjacent month). 0-based data-date first (current
  // TAI), 1-based second (pre-upgrade fallback).
  await scope
    .locator(
      `td:not(.p-datepicker-other-month) span[data-date="${y}-${m - 1}-${d}"], ` +
        `td:not(.p-datepicker-other-month) span[data-date="${y}-${m}-${d}"]`
    )
    .first()
    .click();
}

/**
 * Fill the "Invoice Date" range filter: open the picker, click start then end
 * (PrimeNG range mode), then apply with Search.
 *
 * New-PrimeNG gotcha (live 2026-07-29): clicking the "Start - End" input only
 * FOCUSES it — the calendar no longer opens on input click like the old panel
 * did. It now opens via the sibling calendar-icon button
 * (`button.p-datepicker-dropdown`). We still click the input first (harmless,
 * and the old panel needs it), then fall back to the dropdown button if no
 * month header shows up.
 */
async function applyInvoiceDateRange(scope, startIso, endIso) {
  await scope.getByRole('button', { name: 'Show Advanced' }).click();
  const input = scope.getByRole('combobox', { name: 'Start - End' });
  await input.click();

  const monthHeader = scope.locator('.p-datepicker-select-month, .p-datepicker-month').first();
  const opened = await monthHeader
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await scope
      .locator('p-datepicker, p-calendar')
      .filter({ has: input })
      .locator('button.p-datepicker-dropdown')
      .first()
      .click();
    await monthHeader.waitFor({ state: 'visible', timeout: 10000 });
  }

  await pickDayInOpenCalendar(scope, startIso); // range start
  await pickDayInOpenCalendar(scope, endIso); // range end
  await scope.getByRole('button', { name: 'Search' }).click();
  await scope.waitForLoadState('networkidle');
}

/**
 * Select the payer by name via the TAI autocomplete (#selectedOrganization).
 * See spec §4.4. This FAILSAFE path is invoked ONLY when a payer has no known
 * customerId (see the guarded call site), so there is no customerId fallback
 * here — a missing input or no match is always fatal.
 */
async function selectPayerByName(page, taiPayerName) {
  const core = coreName(taiPayerName);
  const input = page.locator('#selectedOrganization');
  const visible = await input.isVisible().catch(() => false);

  if (!visible) {
    throw new Error(`Could not find payer "${core}" in TAI's payer search.`);
  }

  await typeInto(input, core);

  // Wait for the autocomplete option list to render.
  const option = page.getByRole('option').filter({ hasText: core }).first();
  const found = await option
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
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
        await typeInto(userInput, ctsiUser);
        await typeInto(page.locator('input[name="password"]'), ctsiPass);
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

/**
 * Upload ONE batch (≤20 files) to CTSI and return its Batch ID.
 *
 * The CTSI upload screen is flaky (Kendo dropdowns + an iframe), and a single
 * timed-out click otherwise kills the whole run — this was seen on the last
 * batch of a run. So we retry, but SAFELY: we only retry the steps up to and
 * INCLUDING the "Submit" click, re-navigating to a fresh upload screen each
 * attempt. The moment the Submit click resolves we set `submitted` and never
 * retry again — retrying after a real submission could double-upload invoices
 * to production. A click that *times out* never actually submitted, so retrying
 * that batch is safe. If the Batch-ID confirmation is what times out (after a
 * successful submit), we surface that without re-uploading.
 */
async function ctsiUploadBatch(page, ctsiAccount, batch, emit, label, ctsiUser, ctsiPass) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let submitted = false;
    try {
      const frame = await ctsiReachUploadScreen(page, ctsiAccount);
      await frame.locator('input[type="file"]').setInputFiles(batch);
      await frame
        .getByRole('button', { name: /Submit Files? for Processing/i })
        .click({ timeout: 45000 });
      submitted = true; // committed — past here we do NOT retry

      // Don't wait for networkidle — CTSI stays busy while processing. Wait for
      // the success confirmation: a "Batch ID" is assigned.
      const batchIdText = frame.getByText(/Batch ID/i);
      await batchIdText.waitFor({ state: 'visible', timeout: 120000 });
      return (await batchIdText.innerText().catch(() => '')).trim();
    } catch (e) {
      lastErr = e;
      if (submitted) {
        // The files were already submitted; retrying would double-upload.
        throw new Error(
          `Batch ${label} was submitted but its Batch ID didn't appear: ${String(e.message).split('\n')[0]}. ` +
            `Check CTSI before re-running so you don't upload it twice.`
        );
      }
      emit({
        type: 'log',
        level: 'warn',
        message: `Batch ${label} upload attempt ${attempt}/${MAX_ATTEMPTS} failed before submit: ${String(e.message).split('\n')[0]}`,
      });
      // The pre-submit steps failing often means the CTSI session went stale
      // (dashboard/upload controls missing → click times out), which is most
      // likely on the last batch of a long run. Re-login before retrying;
      // re-login never risks a double-upload. Safe no-op if the session is fine.
      if (attempt < MAX_ATTEMPTS) {
        await ctsiLogin(page, ctsiUser, ctsiPass, emit).catch(() => {});
      }
    }
  }
  throw lastErr || new Error(`Batch ${label} upload failed after ${MAX_ATTEMPTS} attempts.`);
}

async function run(params, emit, awaitConfirm, isCancelled, dirs) {
  const { downloadDir, splitDir } = dirs;
  let browser = null;
  let stage = null;

  // Poll cancellation at stage boundaries (MED-5). We never force-close the
  // browser mid-action — we let the current action finish, then bail cleanly
  // and let the finally-block close the browser. Returns true if we bailed.
  const bailIfCancelled = () => {
    if (isCancelled()) {
      emit({ type: 'cancelled' });
      return true;
    }
    return false;
  };

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
    await typeInto(page.getByRole('textbox', { name: 'Username' }), params.taiUser);
    await page.locator('#login-method-form-user-row').getByRole('button').click();
    await typeInto(page.getByRole('textbox', { name: 'Password' }), params.taiPass);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForLoadState('networkidle');
    emit({ type: 'stage', stage, status: 'done' });
    if (bailIfCancelled()) return { batchIds: [] };

    // Steps 2-3 (invoice search + date-range filter) run under this stage so an
    // error there reports 'invoice-search', not a stale 'tai-login' (LOW-13).
    // The renderer no-ops unknown stage keys in its tracker.
    stage = 'invoice-search';

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
      await selectPayerByName(page, params.taiPayerName);
    }

    // ── STEP 3: apply the Invoice Date range filter (app-configured) ─────
    // Show Advanced → pick start/end in the PrimeNG range picker → Search.
    await applyInvoiceDateRange(page, params.startDate, params.endDate);
    if (bailIfCancelled()) return { batchIds: [] };

    // ── STEPS 4-8: parallel pipeline (download+split on the TAI page, upload
    //    on a second CTSI page, running concurrently) ───────────────────────
    // We do NOT "select all" and download one merged PDF: when a date range has
    // enough invoices, TAI's single combined download is too large and the
    // download breaks. Instead we tick the per-row checkboxes DOWNLOAD_CHUNK at
    // a time and download each subset as a smaller merged PDF. The invoice grid
    // is one long scrolling list — every row is in the DOM at once as
    // `input[name="invoiceCheckbox"]` (they share an invalid duplicate id, so we
    // address them by index, not id). Ticking any subset makes the bulk
    // "Download (N)" button show that subset's count.
    //
    // A producer (this TAI page) downloads + splits one chunk at a time and
    // queues it; a consumer (a second CTSI page) uploads queued chunks and
    // deletes their local files as it goes. The two run concurrently, so chunk
    // N+1 downloads while chunk N uploads. There is NO confirm gate — a Run goes
    // straight through to CTSI (per the app's configured behavior).
    stage = 'download';
    emit({ type: 'stage', stage: 'download', status: 'start' });
    emit({ type: 'stage', stage: 'split', status: 'start' });

    // Wait for the invoice grid to actually render rows before counting.
    // Counting immediately after Search can race the grid render and momentarily
    // see 0 rows — which previously aborted the whole run whenever a range had
    // few invoices ("<20 invoices breaks"). Poll for up to ~15s.
    const invoiceBoxes = page.locator('input[name="invoiceCheckbox"]');
    let invoiceCount = 0;
    for (let i = 0; i < 30; i++) {
      invoiceCount = await invoiceBoxes.count();
      if (invoiceCount > 0) break;
      await page.waitForTimeout(500);
    }
    if (invoiceCount === 0) {
      throw new Error('No invoices found for this payer and date range.');
    }
    const downloadChunks = chunk(
      Array.from({ length: invoiceCount }, (_, i) => i),
      DOWNLOAD_CHUNK
    );
    emit({ type: 'log', level: 'info', message: `Found ${invoiceCount} invoice(s); processing in ${downloadChunks.length} chunk(s) of up to ${DOWNLOAD_CHUNK}.` });

    const ctx = page.context();

    // Start CTSI login on its OWN page now, concurrently with the first TAI
    // download, so the uploader is ready by the time the first chunk is split.
    emit({ type: 'stage', stage: 'ctsi-login', status: 'start' });
    const ctsiPage = await ctx.newPage();
    ctsiPage.setDefaultTimeout(30000);
    ctsiPage.setDefaultNavigationTimeout(60000);
    let ctsiLoginError = null;
    let aborted = false; // set if CTSI login fails, so the producer stops early
    const ctsiReady = ctsiLogin(ctsiPage, params.ctsiUser, params.ctsiPass, emit)
      .then(() => { emit({ type: 'stage', stage: 'ctsi-login', status: 'done' }); return true; })
      .catch((e) => { ctsiLoginError = e; aborted = true; emit({ type: 'stage', stage: 'ctsi-login', status: 'error' }); return false; });

    // Producer→consumer handoff. The producer pushes { chunkNumber, files,
    // mergedPath, chunkSplitDir }; the consumer shifts and uploads them.
    const queue = [];
    let producerDone = false;
    let wake = null; // resolve fn used to wake a waiting consumer
    const bump = () => { if (wake) { const w = wake; wake = null; w(); } };
    const allSplit = []; // cumulative split paths, for the UI's split list
    const batchIds = [];
    const estTotalBatches = downloadChunks.length; // 1 chunk ≈ 1 batch (display only)

    // ── Producer: for each chunk, select → download → split → queue ──────
    const produce = async () => {
      try {
        for (let c = 0; c < downloadChunks.length; c++) {
          if (isCancelled() || aborted) break; // aborted = CTSI login failed
          const idxs = downloadChunks[c];

          // Fast selection: tick this chunk's checkboxes in ONE page call
          // (instant) instead of paced per-box Playwright clicks. A real
          // element.click() fires Angular's change detection, so the bulk
          // "Download (N)" button updates just as if a human ticked them.
          await page.evaluate((indices) => {
            const boxes = document.querySelectorAll('input[name="invoiceCheckbox"]');
            for (const i of indices) {
              const b = boxes[i];
              if (b && !b.checked) b.click();
            }
          }, idxs);

          // "Download (N)" reflects the ticked count; wait for OUR exact count
          // so we never click while the button shows a stale/partial total.
          const downloadBtn = page.getByRole('button', {
            name: new RegExp(`^Download \\(${idxs.length}\\)`),
          });
          await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

          const mergedPath = path.join(downloadDir, `merged-chunk-${String(c + 1).padStart(2, '0')}.pdf`);
          // TAI may fire a real download OR open the PDF inline in a popup.
          // Scope BOTH listeners to the TAI page so the concurrent CTSI upload
          // flow on the other page can never be mistaken for our download.
          const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);
          const popupPromise = page.waitForEvent('popup', { timeout: 120000 }).catch(() => null);
          await downloadBtn.click();
          const result = await Promise.race([
            downloadPromise,
            popupPromise.then((p) => (p ? { __popup: p } : null)),
          ]);
          if (result && !result.__popup) {
            await result.saveAs(mergedPath);
          } else {
            const popup = result?.__popup || (await popupPromise);
            if (!popup) throw new Error(`No download event and no popup tab after Download click (chunk ${c + 1}).`);
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            const resp = await ctx.request.get(popup.url());
            fs.writeFileSync(mergedPath, await resp.body());
            await popup.close().catch(() => {});
          }
          if (!fs.existsSync(mergedPath)) {
            throw new Error(`Merged PDF chunk ${c + 1} was not downloaded (no file at ${mergedPath}).`);
          }
          emit({ type: 'log', level: 'info', message: `Downloaded chunk ${c + 1}/${downloadChunks.length} (${idxs.length} invoice(s)).` });

          // Deselect everything at once via the grid's "Clear All" control, so
          // the next chunk's count starts clean.
          await page.evaluate(() => {
            const el = document.querySelector('#clearAll');
            if (el) el.click();
          });

          // Split this chunk into its own subdir: splitInvoices dedupes
          // filenames only WITHIN a single call and its sequential fallback name
          // restarts at 001 each call, so a shared flat dir could overwrite.
          const chunkSplitDir = path.join(splitDir, `chunk-${String(c + 1).padStart(2, '0')}`);
          const files = await splitInvoices(mergedPath, chunkSplitDir);
          if (files.length > 0) {
            allSplit.push(...files);
            emit({ type: 'split', files: allSplit.slice() });
            queue.push({ chunkNumber: c + 1, files, mergedPath, chunkSplitDir });
            bump();
          } else {
            emit({ type: 'log', level: 'warn', message: `Chunk ${c + 1} produced 0 invoices (no Boost cover page); skipping.` });
            fs.rmSync(mergedPath, { force: true });
          }
        }
        if (!isCancelled() && !aborted) {
          emit({ type: 'stage', stage: 'download', status: 'done' });
          emit({ type: 'stage', stage: 'split', status: 'done' });
        }
      } finally {
        producerDone = true;
        bump();
      }
    };

    // ── Consumer: upload each queued chunk to CTSI, then delete its locals ──
    const consume = async () => {
      const loggedIn = await ctsiReady;
      if (!loggedIn) throw ctsiLoginError || new Error('CTSI login failed.');
      stage = 'upload';
      emit({ type: 'stage', stage: 'upload', status: 'start' });
      let batchNo = 0;
      while (true) {
        if (isCancelled()) break;
        if (queue.length === 0) {
          if (producerDone) break;
          await new Promise((r) => { wake = r; }); // sleep until producer bumps
          continue;
        }
        const item = queue.shift();
        // A 20-invoice chunk yields ≤20 split files = one CTSI batch, but guard
        // anyway: re-chunk this item's files by CTSI's per-submit max of 20.
        const subBatches = chunk(item.files, MAX_PER_BATCH);
        for (const batch of subBatches) {
          if (isCancelled()) break;
          batchNo += 1;
          emit({ type: 'batch', index: batchNo, total: estTotalBatches, count: batch.length, status: 'start' });
          // Upload with a safe retry (reach fresh screen + set files + submit,
          // retried only up to the submit click — see ctsiUploadBatch).
          const confirmation = await ctsiUploadBatch(ctsiPage, params.ctsiAccount, batch, emit, batchNo, params.ctsiUser, params.ctsiPass);
          batchIds.push(confirmation || `Batch ${batchNo}`);
          emit({ type: 'batch', index: batchNo, total: estTotalBatches, count: batch.length, status: 'done', batchId: confirmation || undefined });
        }
        // If we were cancelled partway through this chunk's batches, don't
        // delete it — it wasn't fully uploaded.
        if (isCancelled()) break;
        // Uploaded → delete this chunk's local files (merged PDF + split subdir).
        fs.rmSync(item.chunkSplitDir, { recursive: true, force: true });
        fs.rmSync(item.mergedPath, { force: true });
        emit({ type: 'log', level: 'info', message: `Uploaded chunk ${item.chunkNumber} and deleted its local files.` });
      }
      if (!isCancelled()) emit({ type: 'stage', stage: 'upload', status: 'done' });
    };

    // Run both concurrently. Always let the producer settle so a producer error
    // surfaces even if the consumer finished first.
    const producerPromise = produce();
    try {
      await consume();
    } finally {
      await producerPromise.catch(() => {});
    }
    await producerPromise; // re-await: propagates a producer error if any

    if (isCancelled()) {
      emit({ type: 'cancelled' });
      return { batchIds };
    }
    if (allSplit.length === 0) {
      throw new Error('No invoices were split out of the downloaded PDFs (no Boost cover pages found).');
    }

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
