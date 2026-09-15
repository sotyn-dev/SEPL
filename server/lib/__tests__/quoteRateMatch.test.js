const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const { readQuotation, numbersIn, rateFromLine, textMatch, matchQuotationRates } = require('../quoteRateMatch');

(async () => {
  // Numbers: prices yes, sizes glued to letters no.
  assert.deepEqual(numbersIn('HOSE REEL NOZZLE BRASS Rs 1,500.00'), [1500]);
  assert.deepEqual(numbersIn('BATTERY 12volt 130amp ₹2,000/-'), [2000]);
  assert.deepEqual(numbersIn('CONNECTION PIPE 25MM | 9 | 1000 | 9000'), [9, 1000, 9000]);
  // Table rows: numbers inside the description cell are part of the item name, not prices.
  assert.deepEqual(numbersIn('3 | 3 Pin Top Plug 6 Amp | 10 | 42 | 420'), [3, 10, 42, 420]);
  assert.deepEqual(numbersIn('Hose reel nozzle | 11 Nos | Rs 1,500.00 | 16,500'), [11, 1500, 16500]);
  // Free text: a number followed by a unit / name word is a spec ("12 V", "6 Amp", "3 Pin").
  assert.deepEqual(numbersIn('1 Door Magnet 12 V DC ALAUL276SL 615'), [615]);
  assert.deepEqual(numbersIn('3 Pin Top Plug 6 Amp'), []);

  // Rate on a line.
  assert.equal(rateFromLine('1 | CONNECTION PIPE 25MM | 9 | 1000 | 9000', 9).rate, 1000);   // serial + qty×rate=amount
  assert.equal(rateFromLine('FIRE BUCKET 9 LTR 27 1500 40500', 27).rate, 1500);
  assert.equal(rateFromLine('HOSE REEL NOZZLE 1500', 11).rate, 1500);                       // single price
  assert.equal(rateFromLine('STAND FOR BUCKET 9 1500', 9).rate, 1500);                       // qty then rate, no amount
  assert.equal(rateFromLine('WELDING ROD 3.15MM 150 2400', 16).rate, 150);                   // rate before amount
  assert.equal(rateFromLine('WELDING ROD 3.15MM', 16), null);
  assert.equal(rateFromLine('2 | 1 Door Magnet 12 V DC ALAUL276SL | 15 | 615 | 9225', 1).rate, 615);   // quote qty ≠ indent qty
  assert.equal(rateFromLine('33 Pin Top Plug 6 Amp', 10), null);                                        // name only → no rate, never "6"

  // Word-match each item to its line.
  const items = [
    { name: 'CONNECTION PIPE', specification: 'NA', size: '25MM', qty: 9, unit: 'pcs' },
    { name: 'HOSE REEL NOZZLE', specification: 'BRASS TYPE', size: 'NA', qty: 11, unit: 'pcs' },
    { name: 'FIRE BUCKET', specification: 'MS', size: '9 LTR', qty: 27, unit: 'pcs' },
    { name: 'GATE VALVE', specification: 'CI', size: '100MM', qty: 2, unit: 'nos' },
  ];
  const lines = [
    'QUOTATION - FLOW MECH SOLUTIONS',
    'S.No | Description | Qty | Rate | Amount',
    '1 | Connection pipe 25mm | 9 | 1000 | 9000',
    '2 | Hose reel nozzle brass type | 11 | 1500 | 16500',
    '3 | Fire bucket MS 9 ltr with stand | 27 | 1450 | 39150',
    'GST 18% extra',
  ];
  const m = textMatch(items, lines);
  assert.deepEqual(m.map(x => x.rate), [1000, 1500, 1450, null]);
  assert.ok(m[0].confidence > 0.5 && m[2].quoted_text.includes('Fire bucket'));
  assert.equal(m[3].how, 'no matching line');

  // Excel + CSV quotations.
  const ws = XLSX.utils.aoa_to_sheet([['S.No', 'Description', 'Qty', 'Rate', 'Amount'], [1, 'Connection pipe 25mm', 9, 1000, 9000], [2, 'Hose reel nozzle brass type', 11, 1500, 16500]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Quote');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const xq = await readQuotation(xlsxBuf, 'vendor quote.xlsx');
  assert.equal(xq.attachment, null);
  assert.ok(xq.lines.some(l => l.includes('Connection pipe 25mm | 9 | 1000 | 9000')));
  const cq = await readQuotation(Buffer.from('Description,Qty,Rate\nFire bucket MS 9 ltr,27,1450\n'), 'q.csv');
  assert.ok(cq.lines.some(l => l.includes('Fire bucket MS 9 ltr | 27 | 1450')));

  // Photo → attachment; unknown type → 400.
  const pq = await readQuotation(Buffer.from([0xff, 0xd8, 0xff]), 'quote.JPG');
  assert.equal(pq.attachment.mime, 'image/jpeg');
  await assert.rejects(readQuotation(Buffer.from('x'), 'quote.exe'), (e) => e.status === 400);

  // Without AI: text files match, a photo gives the AI message.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  const r = await matchQuotationRates(db, items.slice(0, 2), xlsxBuf, 'quote.xlsx');
  assert.equal(r.source, 'text');
  assert.deepEqual(r.matches.map(x => x.rate), [1000, 1500]);
  await assert.rejects(matchQuotationRates(db, items, Buffer.from([0xff, 0xd8]), 'photo.jpg'),
    (e) => e.status === 400 && /AI/.test(e.message));
  db.close();

  console.log('Quotation rate matching checks passed: prices vs sizes, qty×rate=amount, serial numbers, word-match per item, Excel/CSV/photo input, no-AI fallback');
})().catch((e) => { console.error(e); process.exit(1); });
