// PNB One Biz PDF statement parser (mam 2026-09-04: "even this pdf is actual
// statement of pnb" — she had no CSV to hand, only the OpTransactionHistory
// PDF the portal gives out).
//
// WHY COORDINATES AND NOT TEXT
// ----------------------------
// pdf-parse's plain `.text` flattens the table into one linear stream, and the
// Dr/Cr/Balance columns interleave unpredictably — badly enough that a text
// parser silently drifts one row out of alignment after any malformed record
// and then reports DEBITS AS CREDITS. Measured on mam's August statement: a
// text parser reconciled 330/331 rows on magnitude yet still inverted the
// direction on 20 of them. Wrong-signed money is worse than no import.
//
// So we read the PDF positionally. Every value's X coordinate says which
// column it is, which is exactly what the printed statement means:
//
//   Txn No.  x~64     Txn Date x~165    Description x 250-520
//   Cheque   x~473    Dr Amount x 660-730    Cr Amount x 760-800    Balance x~871
//
// Those clusters are cleanly separated in the file (gaps at 730-760 and
// 800-860), so direction is READ, never inferred from balance arithmetic.
//
// A transaction is anchored on its Txn-No/Date line; its balance sits ~8pt
// ABOVE that line and its description spreads a few lines either side, so
// description fragments are assigned to their NEAREST anchor within a
// vertical window (which also drops the repeated page headers/footers).
const pdfParse = require('pdf-parse');

// Column boundaries. Deliberately wide: PNB right-aligns amounts, so the X of
// a short amount ("5.90") sits further right than a long one ("3,61,900.00")
// within the SAME column — 683 and 718 are both Dr. The split at 750 is the
// empty gutter between the Dr and Cr clusters.
const X = {
  txnNoMax: 130,
  dateMin: 150, dateMax: 210,
  descMin: 250, descMax: 520,
  amtMin: 640, drCrSplit: 750, amtMax: 830,
  balMin: 830,
};
// Description fragments this far (pt) from the anchor line belong to it.
const DESC_WINDOW = 28;
// The balance for a row is printed slightly above that row's anchor.
const BAL_ABOVE = 14;

const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const NUM_RE = /^[\d,]+\.\d{2}$/;

const toPaise = (s) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100);
const toIso = (s) => { const m = s.match(DATE_RE); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/**
 * Parse a PNB One Biz statement PDF.
 * @param {Buffer} buffer raw PDF bytes
 * @returns {Promise<{rows: Array, accountNumber: string|null, pages: number, anchors: number}>}
 *   rows: { date, description, ref, debit, credit, balance }  (rupees, not paise)
 */
async function parsePnbStatementPdf(buffer) {
  const pages = [];
  // pdf-parse hands each page to `pagerender`; we keep the positioned items
  // instead of the joined string it would otherwise build.
  const pagerender = (pageData) =>
    pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        pages.push({
          n: pageData.pageNumber,
          items: tc.items
            .map((it) => ({ s: String(it.str).trim(), x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }))
            .filter((i) => i.s),
        });
        return '';   // nothing appended to .text; we only want the coordinates
      });

  const parsed = await pdfParse(buffer, { pagerender });
  pages.sort((a, b) => a.n - b.n);

  // Account number off the page header, so the caller can refuse a statement
  // that belongs to a different account than the one selected in the UI.
  let accountNumber = null;
  for (const pg of pages) {
    for (const it of pg.items) {
      const m = it.s.match(/Account Number\s*:?\s*(\d{6,})/i);
      if (m) { accountNumber = m[1]; break; }
    }
    if (accountNumber) break;
  }

  const rows = [];
  let anchors = 0;
  for (const pg of pages) {
    // Anchor = the Txn Date cell. Sorted top-of-page first (PDF Y grows upward).
    const anchorItems = pg.items
      .filter((i) => i.x >= X.dateMin && i.x <= X.dateMax && DATE_RE.test(i.s))
      .sort((a, b) => b.y - a.y);
    anchors += anchorItems.length;

    // Description fragments, each claimed by whichever anchor it sits nearest.
    // A lone "-" is the EMPTY Cheque No cell, not narration — without this it
    // gets spliced into the middle of the description ("…769633/-HDFC0000259").
    const descItems = pg.items.filter((i) => i.x >= X.descMin && i.x <= X.descMax && !NUM_RE.test(i.s) && i.s !== '-');

    for (const a of anchorItems) {
      const onAnchorLine = (i) => Math.abs(i.y - a.y) <= 2;

      const amt = pg.items.find((i) => onAnchorLine(i) && NUM_RE.test(i.s) && i.x >= X.amtMin && i.x < X.amtMax);
      if (!amt) continue;   // no amount on this line — not a transaction row

      const bal = pg.items.find((i) => i.y > a.y && i.y <= a.y + BAL_ABOVE && NUM_RE.test(i.s) && i.x >= X.balMin);
      const txnNo = (pg.items.find((i) => onAnchorLine(i) && i.x < X.txnNoMax) || {}).s || '';
      const chq = pg.items.find((i) => onAnchorLine(i) && i.x > X.descMax && i.x < X.amtMin && i.s !== '-');

      const description = descItems
        .filter((i) => Math.abs(i.y - a.y) <= DESC_WINDOW)
        .filter((i) => anchorItems.reduce((best, c) => (Math.abs(i.y - c.y) < Math.abs(i.y - best.y) ? c : best), anchorItems[0]) === a)
        .sort((p, q) => q.y - p.y)
        .map((i) => i.s)
        .join('');

      const paise = toPaise(amt.s);
      // THE decision, read straight off the page geometry.
      const isDebit = amt.x < X.drCrSplit;
      const date = toIso(a.s);
      if (!date || !paise) continue;

      rows.push({
        date,
        description: description.slice(0, 300),
        // UTR / RRN out of the narration, else the cheque-number cell.
        ref: (description.match(/\b(\d{9,})\b/) || [])[1] || (chq ? chq.s : '') || '',
        debit: isDebit ? paise / 100 : 0,
        credit: isDebit ? 0 : paise / 100,
        balance: bal ? toPaise(bal.s) / 100 : null,
        txn_no: txnNo,
      });
    }
  }

  return { rows, accountNumber, pages: parsed.numpages, anchors };
}

module.exports = { parsePnbStatementPdf };
