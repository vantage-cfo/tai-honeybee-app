/**
 * split-invoices.js
 *
 * Splits a large merged Boost Transport PDF into one PDF per invoice.
 *
 * Each invoice's FIRST page contains the "Payable To: Boost Transport" block:
 *
 *     Payable To:
 *     Boost Transport
 *     PO Box 852
 *     Oakwood, GA 30566
 *     Tel.: (877) 873-8535
 *     Fax: (800) 282-1735
 *
 * We scan every page for that marker. Every page that has it starts a new
 * split PDF; all following pages (until the next marker) belong to that
 * invoice. Where possible each output file is named by its Invoice # so the
 * files are easy to match on the CTSI side.
 *
 * Usage (standalone):
 *   node split-invoices.js <merged.pdf> [outputDir]
 *
 * Usage (as a module):
 *   const { splitInvoices } = require('./split-invoices');
 *   const files = await splitInvoices('merged.pdf', 'split-output');
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// pdfjs-dist v6 is ESM-only, so it must be loaded via dynamic import() from
// this CommonJS module. The legacy build runs under Node without a DOM.
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjs;
}

/**
 * Pull the plain text of one page as a single normalized string.
 * pdfjs returns positioned text items; we join them with spaces and
 * collapse whitespace so layout quirks don't defeat our marker match.
 */
async function getPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const raw = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * True when a page is the first page of a Boost invoice.
 *
 * We don't require the exact multi-line block (PDF text order is unreliable).
 * Instead we look for the strongest, most unique fragments of the Payable-To
 * block. Requiring two independent hits avoids false positives from any page
 * that merely mentions "Boost".
 */
function isCoverPage(text) {
  const t = text.toLowerCase();
  const signals = [
    /payable to/,
    /boost transport/,
    /po box 852/,
    /oakwood,?\s*ga\s*30566/,
    /\(877\)\s*873-?8535/,       // Tel
    /\(800\)\s*282-?1735/,       // Fax
  ];
  const hits = signals.reduce((n, re) => (re.test(t) ? n + 1 : n), 0);
  // Address/phone are unique to Boost; two independent signals = confident.
  return hits >= 2;
}

/**
 * Best-effort Invoice # extraction for a friendly filename.
 * The invoice template shows "Invoice #  127946276" (a 6-12 digit number).
 * Returns null if we can't find one; caller falls back to a sequential name.
 */
function extractInvoiceNumber(text) {
  const m =
    text.match(/invoice\s*#\s*:?\s*(\d{5,15})/i) ||
    text.match(/invoice\s*number\s*:?\s*(\d{5,15})/i);
  return m ? m[1] : null;
}

/**
 * Split a merged PDF into per-invoice PDFs.
 *
 * @param {string} mergedPath  Path to the combined PDF.
 * @param {string} outputDir   Directory to write split PDFs into (created if missing).
 * @returns {Promise<string[]>} Absolute paths of the written split PDFs, in order.
 */
async function splitInvoices(mergedPath, outputDir) {
  const bytes = fs.readFileSync(mergedPath);

  // 1) Find invoice boundaries by scanning text with pdfjs.
  const pdfjsLib = await getPdfjs();
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    // Silence the noisy font warnings; they don't affect text extraction.
    verbosity: 0,
  }).promise;

  const pageCount = pdf.numPages;
  const coverPages = []; // 1-based page numbers that begin an invoice
  const pageTexts = {};
  for (let p = 1; p <= pageCount; p++) {
    const text = await getPageText(pdf, p);
    pageTexts[p] = text;
    if (isCoverPage(text)) coverPages.push(p);
  }

  if (coverPages.length === 0) {
    throw new Error(
      `No Boost cover pages found in "${mergedPath}". ` +
        `Checked ${pageCount} page(s) for the "Payable To: Boost Transport" marker.`
    );
  }

  // Warn (but don't fail) if there are stray pages before the first invoice.
  if (coverPages[0] !== 1) {
    console.warn(
      `Warning: pages 1-${coverPages[0] - 1} appear before the first Boost ` +
        `cover page; they will be attached to the first invoice.`
    );
    coverPages[0] = 1;
  }

  // 2) Build page ranges: each invoice runs from its cover page up to
  //    (but not including) the next cover page.
  const ranges = coverPages.map((start, i) => {
    const end = i + 1 < coverPages.length ? coverPages[i + 1] - 1 : pageCount;
    return { start, end };
  });

  // 3) Copy the page ranges into fresh PDFs with pdf-lib.
  fs.mkdirSync(outputDir, { recursive: true });
  const srcDoc = await PDFDocument.load(bytes);
  const written = [];
  const usedNames = new Set();

  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    const out = await PDFDocument.create();

    // pdf-lib uses 0-based indices; our ranges are 1-based inclusive.
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);
    const copied = await out.copyPages(srcDoc, indices);
    copied.forEach((pg) => out.addPage(pg));

    // Filename: prefer the invoice number, else a padded sequence.
    const seq = String(i + 1).padStart(3, '0');
    const invNo = extractInvoiceNumber(pageTexts[start] || '');
    let base = invNo ? `invoice-${invNo}` : `invoice-${seq}`;
    // Guard against duplicate invoice numbers in the same merged file.
    let name = `${base}.pdf`;
    let dup = 2;
    while (usedNames.has(name)) name = `${base}-${dup++}.pdf`;
    usedNames.add(name);

    const outPath = path.join(outputDir, name);
    fs.writeFileSync(outPath, await out.save());
    written.push(path.resolve(outPath));
    console.log(
      `  ${name}  (pages ${start}-${end}${invNo ? '' : ', no invoice # found'})`
    );
  }

  console.log(
    `Split "${path.basename(mergedPath)}" -> ${written.length} invoice PDF(s) in "${outputDir}".`
  );
  return written;
}

module.exports = { splitInvoices, isCoverPage, extractInvoiceNumber };

// Allow running directly from the command line.
if (require.main === module) {
  const [, , merged, outDir] = process.argv;
  if (!merged) {
    console.error('Usage: node split-invoices.js <merged.pdf> [outputDir]');
    process.exit(1);
  }
  splitInvoices(merged, outDir || 'split-output')
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Split failed:', err.message);
      process.exit(1);
    });
}
