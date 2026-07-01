/**
 * playwright-script.spec.ts
 *
 * End-to-end Boost billing automation:
 *   1. Log in to TAI, pull the selected customer's open invoices, download the
 *      single merged PDF.
 *   2. Split that merged PDF into one PDF per invoice (each invoice's first page
 *      carries the "Payable To: Boost Transport" block). See split-invoices.js.
 *   3. Log in to CTSI, pick carrier + account, and upload ONLY the split PDFs in
 *      batches of at most 20, submitting each batch.
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
 * `data-date` attribute. `data-date` is "YYYY-M-D" — month & day are NOT
 * zero-padded and month is 1-based (e.g. "2026-7-1"). Works for any date.
 *
 * @param scope The page (or frame) whose calendar popup is open.
 * @param iso   Date as "YYYY-MM-DD".
 */
async function pickDayInOpenCalendar(scope: import('@playwright/test').Page, iso: string) {
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
async function applyInvoiceDateRange(
  scope: import('@playwright/test').Page,
  startIso: string,
  endIso: string
) {
  await scope.getByRole('button', { name: 'Show Advanced' }).click();
  await scope.getByRole('combobox', { name: 'Start - End' }).click();
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

  // ── STEP 4: select all invoices and download the merged PDF ──────────────
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
    console.log(`  Download button still hidden after toggle (attempt ${attempt}).`);
  }
  await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

  const mergedPath = path.join(DOWNLOAD_DIR, 'merged-invoices.pdf');
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

  if (result && !(result as any).__popup) {
    await (result as import('@playwright/test').Download).saveAs(mergedPath);
  } else {
    // Inline PDF opened in a new tab — fetch its bytes using the session cookies.
    const popup = (result as any)?.__popup || (await popupPromise);
    if (!popup) throw new Error('No download event and no popup tab after Download click.');
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const resp = await ctx.request.get(popup.url());
    fs.writeFileSync(mergedPath, await resp.body());
    await popup.close().catch(() => {});
  }
  expect(fs.existsSync(mergedPath), 'merged PDF was downloaded').toBeTruthy();
  console.log(`Downloaded merged PDF -> ${mergedPath}`);

  // ── STEP 5: split the merged PDF by Boost cover page ─────────────────────
  const splitFiles = await splitInvoices(mergedPath, SPLIT_DIR);
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

    const frame = await ctsiReachUploadScreen(page);

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
    console.log(`  ✓ Batch ${b + 1} submitted — ${confirmation || 'confirmed'}`);
  }

  console.log('All batches submitted.');
});
