/**
 * playwright-script.spec.ts
 *
 * End-to-end Boost billing automation:
 *   1. Log in to TAI, pull the selected customer's open invoices, ticking them
 *      in chunks of 20 and downloading each subset as its own smaller merged PDF
 *      (a single "select all" download breaks once the file gets too large).
 *   2. Split each merged chunk into one PDF per invoice (each invoice's first
 *      page carries the "Payable To: Boost Transport" block). See split-invoices.js.
 *   3. Log in to CTSI, pick carrier + account, and upload ONLY the split PDFs in
 *      batches of at most 20, submitting each batch (with a safe retry).
 *
 * NOTE: this reference keeps the flow SEQUENTIAL (download+split everything,
 * then upload) for readability. The shipping Electron app (src/automation/run.js)
 * runs the same site interactions as a PARALLEL pipeline — downloads+splits on
 * this page while uploads run on a second CTSI page concurrently.
 *
 * ── Required environment variables (see .env / .env.example) ──────────────────
 *   TAI_USERNAME     TAI login
 *   TAI_PASSWORD     TAI password
 *   TAI_CUSTOMER_ID  TAI customer to pull (793141 = "CM - Binghamton" demo default)
 *   TAI_START_DATE   Invoice Date range start, YYYY-MM-DD (app-configured)
 *   TAI_END_DATE     Invoice Date range end,   YYYY-MM-DD (app-configured)
 *   CTSI_USERNAME    CTSI login
 *   CTSI_PASSWORD    CTSI password
 *   CTSI_ACCOUNT     Account selected on CTSI (2036 = demo default)
 *   CTSI_CARRIER     (optional) carrier dropdown label, default "BOVT - BOOST TRANSPORT"
 *   HEADLESS=1       (optional) run without a visible browser
 *
 * Run:
 *   npx playwright test                # headed demo
 *   HEADLESS=1 npx playwright test     # headless
 *
 * NOTE: TAI_CUSTOMER_ID, TAI_START_DATE/TAI_END_DATE, and CTSI_ACCOUNT are the
 * "user selection" seams your app will drive. Everything else is fixed workflow.
 */

import { test, expect } from '@playwright/test';
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { splitInvoices } from './split-invoices';

// ── Config / parameters ───────────────────────────────────────────────────────
const TAI_USERNAME = requireEnv('TAI_USERNAME');
const TAI_PASSWORD = requireEnv('TAI_PASSWORD');
const TAI_CUSTOMER_ID = requireEnv('TAI_CUSTOMER_ID'); // app-selected account
const TAI_START_DATE = requireIsoDate('TAI_START_DATE'); // app-configured range start
const TAI_END_DATE = requireIsoDate('TAI_END_DATE'); // app-configured range end
const CTSI_USERNAME = requireEnv('CTSI_USERNAME');
const CTSI_PASSWORD = requireEnv('CTSI_PASSWORD');
const CTSI_ACCOUNT = requireEnv('CTSI_ACCOUNT'); // app-selected account (e.g. "2036")
const CTSI_CARRIER = process.env.CTSI_CARRIER || 'BOVT - BOOST TRANSPORT';

const MAX_PER_BATCH = 20; // CTSI accepts at most 20 files per submit
const DOWNLOAD_CHUNK = 10; // TAI invoices ticked + downloaded per merged PDF (~4s/invoice server-side merge)
const DOWNLOAD_WAIT_MS = 300000; // TAI merges the WHOLE PDF server-side before the blob download event fires

const DOWNLOAD_DIR = path.resolve('downloads');
const SPLIT_DIR = path.resolve('split-output');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('your-')) {
    throw new Error(`Missing env var ${name}. Set it in .env (see .env.example).`);
  }
  return v;
}

function requireIsoDate(name: string): string {
  const v = requireEnv(name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`${name} must be YYYY-MM-DD (got "${v}").`);
  }
  return v;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Select a single day in the open PrimeNG (p-datepicker) calendar.
 *
 * Navigates to the target month via the Prev/Next Month arrows (reading the
 * header's month + year labels), then clicks the exact in-month day cell by its
 * `data-date` attribute.
 *
 * TAI upgraded PrimeNG (seen live 2026-07-29): header labels are now buttons
 * `.p-datepicker-select-month` / `.p-datepicker-select-year`, and `data-date`
 * months are 0-BASED ("2026-6-1" = July 1; the old panel was 1-based).
 * Selectors accept both generations. See src/automation/run.js for detail.
 *
 * @param scope The page (or frame) whose calendar popup is open.
 * @param iso   Date as "YYYY-MM-DD".
 */
async function pickDayInOpenCalendar(scope: import('@playwright/test').Page, iso: string) {
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
 */
async function applyInvoiceDateRange(
  scope: import('@playwright/test').Page,
  startIso: string,
  endIso: string
) {
  await scope.getByRole('button', { name: 'Show Advanced' }).click();
  // New PrimeNG: clicking the input only focuses it; the calendar opens via
  // the sibling `button.p-datepicker-dropdown`. Try the input first (old
  // behavior), fall back to the dropdown button.
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

const CTSI_APP_URL = 'https://portal.ctsi-global.com/TMSV5/apploader/C17';
const CTSI_DASHBOARD_URL = 'https://portal.ctsi-global.com/TMSV5/apps/Dashboard';

/**
 * Log in to CTSI (auth0 Lock widget) and confirm the app is reachable.
 * The auth0 form can be slow/flaky, so we retry the whole login up to 3×.
 */
async function ctsiLogin(page: import('@playwright/test').Page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(CTSI_APP_URL, { waitUntil: 'domcontentloaded' });
      const userInput = page.locator('input[name="username"]');
      const showsLogin = await userInput
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (showsLogin) {
        await userInput.fill(CTSI_USERNAME);
        await page.locator('input[name="password"]').fill(CTSI_PASSWORD);
        await page.locator('button.auth0-lock-submit').click();
        await page.waitForURL(/portal\.ctsi-global\.com\/TMSV5/, { timeout: 30000 });
      }
      // Confirm we're really in: the Invoice Upload link must be reachable.
      await page.goto(CTSI_DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('link', { name: 'Invoice Upload' }).waitFor({ timeout: 20000 });
      console.log(`CTSI logged in (attempt ${attempt}).`);
      return;
    } catch (e: any) {
      console.warn(`CTSI login attempt ${attempt} failed: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error('CTSI login failed after 3 attempts.');
}

/**
 * From the dashboard, open Invoice Upload, pick carrier + account, and wait for
 * the upload widget to finish initializing. Returns the iframe's FrameLocator.
 * Called once per batch so multi-batch uploads always start from a clean form.
 */
async function ctsiReachUploadScreen(page: import('@playwright/test').Page) {
  await page.goto(CTSI_DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Invoice Upload' }).click();
  const frame = page.locator('iframe').contentFrame();

  // Carrier dropdown (always Boost).
  await frame.locator('span').nth(2).click();
  await frame.getByRole('option', { name: CTSI_CARRIER }).click();

  // Account dropdown — app-driven selection (CTSI_ACCOUNT, e.g. "2036").
  await frame
    .locator('div:nth-child(4) > .full-width > .k-dropdown-wrap > .k-select > .k-icon')
    .click();
  await frame.getByRole('option').filter({ hasText: CTSI_ACCOUNT }).first().click();

  await frame.getByRole('button', { name: 'Go To Upload' }).click();

  // The upload widget shows "Initializing…" first; wait for the file picker
  // ("SELECT FILES..." — accessible name "Choose File") to render.
  await frame
    .getByRole('button', { name: 'Choose File' })
    .waitFor({ state: 'visible', timeout: 30000 });
  return frame;
}

/**
 * Upload ONE batch (≤20 files) to CTSI and return its Batch ID, with a SAFE
 * retry. The Kendo dropdowns + iframe are flaky and a single timed-out click
 * otherwise kills the run (seen on the last batch). We retry (3×) only up to and
 * INCLUDING the Submit click, re-navigating to a fresh upload screen and
 * re-logging-in between attempts (a stale session is the likely last-batch
 * cause; re-login can't double-upload). Once the Submit click resolves we set
 * `submitted` and NEVER retry — a real re-submit would double-upload to
 * production; a Batch-ID-wait timeout after that surfaces without re-uploading.
 */
async function ctsiUploadBatch(
  page: import('@playwright/test').Page,
  batch: string[],
  label: number | string
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let submitted = false;
    try {
      const frame = await ctsiReachUploadScreen(page);
      await frame.locator('input[type="file"]').setInputFiles(batch);
      await frame
        .getByRole('button', { name: /Submit Files? for Processing/i })
        .click({ timeout: 45000 });
      submitted = true; // committed — past here we do NOT retry
      const batchIdText = frame.getByText(/Batch ID/i);
      await batchIdText.waitFor({ state: 'visible', timeout: 120000 });
      return (await batchIdText.innerText().catch(() => '')).trim();
    } catch (e: any) {
      lastErr = e;
      if (submitted) {
        throw new Error(
          `Batch ${label} was submitted but its Batch ID didn't appear: ${String(e.message).split('\n')[0]}. ` +
            `Check CTSI before re-running so you don't upload it twice.`
        );
      }
      console.warn(
        `Batch ${label} upload attempt ${attempt}/${MAX_ATTEMPTS} failed before submit: ${String(e.message).split('\n')[0]}`
      );
      if (attempt < MAX_ATTEMPTS) await ctsiLogin(page).catch(() => {});
    }
  }
  throw lastErr || new Error(`Batch ${label} upload failed after ${MAX_ATTEMPTS} attempts.`);
}

test('Boost: TAI download → split → CTSI batched upload', async ({ page }) => {
  // Fresh output dirs so we never re-upload stale split PDFs.
  fs.rmSync(SPLIT_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // ── STEP 1: TAI login ────────────────────────────────────────────────────
  await page.goto('https://atl.taicloud.net/');
  await page.getByRole('link', { name: 'Other ways to sign in' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill(TAI_USERNAME);
  await page.locator('#login-method-form-user-row').getByRole('button').click();
  await page.getByRole('textbox', { name: 'Password' }).fill(TAI_PASSWORD);
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.waitForLoadState('networkidle');

  // ── STEP 2: open the selected customer's invoices ────────────────────────
  // Instead of clicking the fragile "$4,600.24" balance link (which changes
  // daily), we navigate straight to the invoice search for the selected
  // customer. TAI_CUSTOMER_ID is the app-driven account selection.
  const asOfDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (today)
  await page.goto(
    `https://atl.taicloud.net/back-office/accounting/invoice-search` +
      `?customerId=${encodeURIComponent(TAI_CUSTOMER_ID)}&daysOverDue=0&asOfDate=${asOfDate}`
  );
  await page.waitForLoadState('networkidle');

  // ── STEP 3: apply the Invoice Date range filter (app-configured) ─────────
  // Show Advanced → pick start/end in the PrimeNG range picker → Search.
  await applyInvoiceDateRange(page, TAI_START_DATE, TAI_END_DATE);

  // ── STEP 4: tick invoices in chunks of 20 and download each subset ───────
  // We do NOT "select all" and download one merged PDF — that file grows too
  // large to download once a range has enough invoices. The grid is one long
  // scrolling list; every row is in the DOM at once as
  // `input[name="invoiceCheckbox"]` (they share an invalid duplicate id, so
  // address by index). Ticking any subset makes the bulk "Download (N)" button
  // show that subset's count; the `<a id="clearAll">Clear All</a>` control
  // deselects everything at once.
  const ctx = page.context();
  const invoiceBoxes = page.locator('input[name="invoiceCheckbox"]');

  // Wait for the grid to actually render rows before counting — counting right
  // after Search can race the render and see 0, aborting the run.
  let invoiceCount = 0;
  for (let i = 0; i < 30; i++) {
    invoiceCount = await invoiceBoxes.count();
    if (invoiceCount > 0) break;
    await page.waitForTimeout(500);
  }
  expect(invoiceCount, 'invoices found for this payer/date range').toBeGreaterThan(0);

  const indexChunks = chunk(
    Array.from({ length: invoiceCount }, (_, i) => i),
    DOWNLOAD_CHUNK
  );
  console.log(`Found ${invoiceCount} invoice(s); downloading in ${indexChunks.length} chunk(s).`);

  const mergedPaths: string[] = [];
  for (let c = 0; c < indexChunks.length; c++) {
    const idxs = indexChunks[c];

    // Fast selection: tick the whole chunk in ONE page call (a real
    // element.click() fires Angular change detection so "Download (N)" updates).
    await page.evaluate((indices: number[]) => {
      const boxes = document.querySelectorAll('input[name="invoiceCheckbox"]');
      for (const i of indices) {
        const b = boxes[i] as HTMLInputElement | undefined;
        if (b && !b.checked) b.click();
      }
    }, idxs);

    const downloadBtn = page.getByRole('button', {
      name: new RegExp(`^Download \\(${idxs.length}\\)`),
    });
    await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

    const mergedPath = path.join(DOWNLOAD_DIR, `merged-chunk-${String(c + 1).padStart(2, '0')}.pdf`);
    // TAI may fire a real download OR open the PDF inline in a popup. Scope both
    // listeners to this page (in the app a second CTSI page runs concurrently).
    // TAI's rebuilt page fetches the merged PDF via XHR and delivers it as a blob
    // download, so the event fires only after the FULL server-side merge; wait
    // long and retry the click once (re-requesting a merge is idempotent).
    let captured = false;
    for (let attempt = 1; attempt <= 2 && !captured; attempt++) {
      const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS }).catch(() => null);
      const popupPromise = page.waitForEvent('popup', { timeout: DOWNLOAD_WAIT_MS }).catch(() => null);
      if (attempt === 1) {
        await downloadBtn.click(); // "Download (N)"
      } else {
        await downloadBtn.click().catch(() => {});
      }
      const result = await Promise.race([
        downloadPromise,
        popupPromise.then((p) => (p ? { __popup: p } : null)),
      ]);
      if (result && !(result as any).__popup) {
        await (result as import('@playwright/test').Download).saveAs(mergedPath);
        captured = true;
      } else {
        const popup = (result as any)?.__popup || (await popupPromise);
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          const resp = await ctx.request.get(popup.url());
          fs.writeFileSync(mergedPath, await resp.body());
          await popup.close().catch(() => {});
          captured = true;
        } else if (attempt === 1) {
          console.log(`Chunk ${c + 1}: no download after ${DOWNLOAD_WAIT_MS / 1000}s — retrying the Download click once.`);
        }
      }
    }
    if (!captured) throw new Error(`No download event and no popup after Download click (chunk ${c + 1}).`);
    expect(fs.existsSync(mergedPath), `chunk ${c + 1} downloaded`).toBeTruthy();
    mergedPaths.push(mergedPath);
    console.log(`Downloaded chunk ${c + 1}/${indexChunks.length} (${idxs.length} invoice(s)).`);

    // Deselect everything at once before the next chunk.
    await page.evaluate(() => {
      const el = document.querySelector('#clearAll') as HTMLElement | null;
      if (el) el.click();
    });
  }

  // ── STEP 5: split each merged chunk by Boost cover page ──────────────────
  // Split each chunk into its own subdir: splitInvoices dedupes filenames only
  // WITHIN one call and its fallback name restarts at 001 per call, so a shared
  // flat dir could overwrite across chunks.
  const splitFiles: string[] = [];
  for (let c = 0; c < mergedPaths.length; c++) {
    const chunkSplitDir = path.join(SPLIT_DIR, `chunk-${String(c + 1).padStart(2, '0')}`);
    splitFiles.push(...(await splitInvoices(mergedPaths[c], chunkSplitDir)));
  }
  expect(splitFiles.length, 'at least one invoice was split out').toBeGreaterThan(0);
  console.log(`Split into ${splitFiles.length} invoice PDF(s).`);

  // ── STEP 6: CTSI login (auth0 Lock, with retry) ──────────────────────────
  await ctsiLogin(page);

  // ── STEP 7 & 8: upload the split PDFs in batches of ≤20, submit each batch ─
  // CTSI allows at most 20 files per submission ("Drop files here… (Max 20)").
  // We re-open a fresh upload screen (carrier + account + Go To Upload) for each
  // batch so multi-batch runs always start clean.
  const batches = chunk(splitFiles, MAX_PER_BATCH);
  console.log(
    `Uploading ${splitFiles.length} file(s) in ${batches.length} batch(es) of up to ${MAX_PER_BATCH}.`
  );

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`  Batch ${b + 1}/${batches.length}: ${batch.length} file(s)`);
    const confirmation = await ctsiUploadBatch(page, batch, b + 1);
    console.log(`  ✓ Batch ${b + 1} submitted — ${confirmation || 'confirmed'}`);
  }

  console.log('All batches submitted.');
});
