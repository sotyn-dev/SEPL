// Shared quotation-workbook builder (Workstream 1). The heavy Excel generation
// for the estimator export lives here, in ONE place, so it can be called
// IDENTICALLY by two callers:
//   • the /quotations/estimate-export route, as the inline fallback when the job
//     queue is unavailable (Redis/worker down) — today's behavior, unchanged; and
//   • the BullMQ files worker, so the CPU-heavy `XLSX/ExcelJS.write` runs in the
//     separate worker process and never blocks the API event loop on the 2-core VPS.
//
// Input is a normalized object: { title, client_name, client_address,
// quotation_no, prep_by, byCat: { <category>: [items] }, manpower: [...] }.
// Output is a Buffer of the .xlsx. Preferred output is the styled ExcelJS
// workbook; if exceljs isn't installed (or styling throws) it falls through to a
// plain SheetJS workbook — this function NEVER throws for a styling reason, it
// degrades, exactly like the original route did.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// ── Styled quotation workbook (ExcelJS) — logo, navy headers, borders, wrapped
// descriptions, currency number formats.
async function buildStyledQuotation(ExcelJS, d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Secured Engineers Pvt Ltd';
  const NAVY = 'FF1E3A8A', LIGHT = 'FFE8EEF7', GREY = 'FFF4F6FA', MONEY = '#,##0.00';
  const thin = { style: 'thin', color: { argb: 'FFD0D7E2' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const QH = ['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP'];
  const styleHeader = (ws, rowIdx, n) => {
    const r = ws.getRow(rowIdx); r.height = 26;
    for (let c = 1; c <= n; c++) { const cell = r.getCell(c); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; cell.border = border; }
  };

  // ── SUMMARY ──
  const sum = wb.addWorksheet('SUMMARY');
  sum.columns = [{ width: 34 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 18 }];
  // repo root is three levels up from server/jobs/lib
  const logoPath = path.join(__dirname, '..', '..', '..', 'client', 'public', 'sepl-logo.png');
  if (fs.existsSync(logoPath)) {
    const imgId = wb.addImage({ filename: logoPath, extension: 'png' });
    sum.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 175, height: 56 } });
    sum.getRow(1).height = 46;
  }
  const co = [['B1', 'SECURED ENGINEERS PVT. LTD', { bold: true, size: 14, color: { argb: NAVY } }],
    ['B2', 'H.O: 2480/1, B.K. Towers, Janta Nagar, Gill Road, Ludhiana', { size: 9, color: { argb: 'FF555555' } }],
    ['B3', 'C.O: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016', { size: 9, color: { argb: 'FF555555' } }],
    ['B4', 'Website: www.securedengineers.com', { size: 9, color: { argb: 'FF555555' } }]];
  co.forEach(([a, v, f], i) => { sum.mergeCells(`${a}:E${i + 1}`); sum.getCell(a).value = v; sum.getCell(a).font = f; });
  sum.mergeCells('A6:E6'); const tb = sum.getCell('A6'); tb.value = `QUOTATION FOR ${d.title || 'WORK'}`; tb.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; tb.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }; tb.alignment = { horizontal: 'center', vertical: 'middle' }; sum.getRow(6).height = 24;
  const info = [['NAME', d.client_name, 'Date', new Date().toISOString().slice(0, 10)], ['ADDRESS', d.client_address, 'Quotation No', d.quotation_no], ['PREP BY', d.prep_by, 'Revision No', 'R0']];
  let rr = 8;
  info.forEach(([k, v, k2, v2]) => { sum.getCell(`A${rr}`).value = k; sum.getCell(`A${rr}`).font = { bold: true }; sum.getCell(`B${rr}`).value = v; sum.getCell(`B${rr}`).alignment = { wrapText: true }; sum.getCell(`D${rr}`).value = k2; sum.getCell(`D${rr}`).font = { bold: true }; sum.getCell(`E${rr}`).value = v2; rr++; });
  rr++;
  sum.getCell(`A${rr}`).value = 'S.No.'; sum.getCell(`B${rr}`).value = 'Description'; sum.getCell(`C${rr}`).value = 'SP Amount (Rs)'; styleHeader(sum, rr, 3); rr++;
  let grand = 0, ci = 1;
  for (const [cat, items] of Object.entries(d.byCat)) { const sp = items.reduce((t, it) => t + (Number(it.sp) || 0), 0); grand += sp; sum.getCell(`A${rr}`).value = ci++; sum.getCell(`B${rr}`).value = cat; const cc = sum.getCell(`C${rr}`); cc.value = Math.round(sp * 100) / 100; cc.numFmt = MONEY; [`A${rr}`, `B${rr}`, `C${rr}`].forEach(a => sum.getCell(a).border = border); rr++; }
  sum.getCell(`B${rr}`).value = 'SUB TOTAL'; sum.getCell(`B${rr}`).font = { bold: true }; const stc = sum.getCell(`C${rr}`); stc.value = Math.round(grand * 100) / 100; stc.numFmt = MONEY; stc.font = { bold: true }; rr += 2;
  ['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount'].forEach((h, k) => sum.getCell(rr, k + 1).value = h); styleHeader(sum, rr, 5); rr++;
  let mTotal = 0;
  d.manpower.filter(m => m && m.name).forEach(m => { const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0); mTotal += amt; sum.getCell(rr, 1).value = m.name; sum.getCell(rr, 2).value = Number(m.qty) || 0; const mc = sum.getCell(rr, 3); mc.value = Number(m.monthly_cost) || 0; mc.numFmt = MONEY; sum.getCell(rr, 4).value = Number(m.months) || 0; const ac = sum.getCell(rr, 5); ac.value = Math.round(amt * 100) / 100; ac.numFmt = MONEY; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).border = border; rr++; });
  sum.getCell(rr, 4).value = 'Manpower Total'; sum.getCell(rr, 4).font = { bold: true }; const mtc = sum.getCell(rr, 5); mtc.value = Math.round(mTotal * 100) / 100; mtc.numFmt = MONEY; mtc.font = { bold: true }; rr++;
  sum.getCell(rr, 4).value = 'GRAND TOTAL'; sum.getCell(rr, 4).font = { bold: true, size: 12 }; const gtc = sum.getCell(rr, 5); gtc.value = Math.round((grand + mTotal) * 100) / 100; gtc.numFmt = MONEY; gtc.font = { bold: true, size: 12, color: { argb: NAVY } }; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };

  // ── per-category sheets ──
  const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
  for (const [cat, items] of Object.entries(d.byCat)) {
    const ws = wb.addWorksheet(safeSheet(cat));
    ws.columns = [{ width: 6 }, { width: 52 }, { width: 12 }, { width: 7 }, { width: 7 }, { width: 12 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 9 }, { width: 13 }];
    QH.forEach((h, k) => ws.getCell(1, k + 1).value = h); styleHeader(ws, 1, QH.length);
    let sp = 0, ri = 2;
    items.forEach((it, idx) => {
      const vals = [idx + 1, it.description || '', it.make || '', it.unit || '', Number(it.qty) || 0, Number(it.rate) || 0, Number(it.sp) || 0, Number(it.pp) || 0, Number(it.acc) || 0, Number(it.lab) || 0, Number(it.tp) || 0, Number(it.tpa) || 0, (Number(it.margin) || 0) + '%', Number(it.sp) || 0];
      vals.forEach((v, k) => {
        const cell = ws.getCell(ri, k + 1); cell.value = v; cell.border = border;
        cell.alignment = { vertical: 'top', wrapText: k === 1, horizontal: k === 0 ? 'center' : (k >= 4 ? 'right' : 'left') };
        if (k === 4) cell.numFmt = '0';
        else if ([5, 6, 7, 8, 9, 10, 11, 13].includes(k)) cell.numFmt = MONEY;
        if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
      });
      sp += Number(it.sp) || 0; ri++;
    });
    ws.getCell(ri, 1).value = 'TOTAL'; ws.getCell(ri, 1).font = { bold: true };
    const t7 = ws.getCell(ri, 7); t7.value = Math.round(sp * 100) / 100; t7.numFmt = MONEY; t7.font = { bold: true };
    const t14 = ws.getCell(ri, 14); t14.value = Math.round(sp * 100) / 100; t14.numFmt = MONEY; t14.font = { bold: true };
    for (let c = 1; c <= QH.length; c++) { ws.getCell(ri, c).border = border; ws.getCell(ri, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Plain SheetJS workbook — the fallback when exceljs is unavailable. Same data,
// no styling. Uses the already-grouped byCat (the route used to regroup rows).
function buildPlainQuotation(d) {
  const { title = '', client_name = '', client_address = '', quotation_no = '', prep_by = '', byCat = {}, manpower = [] } = d;
  const wb = XLSX.utils.book_new();
  const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';

  const catTotals = [];
  for (const [cat, items] of Object.entries(byCat)) {
    const aoa = [['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', '', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP']];
    let sp = 0;
    items.forEach((it, i) => {
      aoa.push([i + 1, it.description || '', it.make || '', it.unit || '', it.qty || 0, it.rate || 0, it.sp || 0,
        '', it.pp || 0, it.acc || 0, it.lab || 0, it.tp || 0, it.tpa || 0, (it.margin || 0) + '%', it.sp || 0]);
      sp += Number(it.sp) || 0;
    });
    aoa.push(['TOTAL', '', '', '', '', '', Math.round(sp * 100) / 100, '', '', '', '', '', Math.round(sp * 100) / 100]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), safeSheet(cat));
    catTotals.push({ cat, sp });
  }

  const sum = [];
  sum.push(['SECURED ENGINEERS PVT. LTD']);
  sum.push(['H.O: 2480/1 , B.K. Towers, Janta Nagar, Gill Road, Ludhiana']);
  sum.push(['C.O : 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016']);
  sum.push(['Website : www.securedengineers.com']);
  sum.push([`QUOTATION FOR ${title || 'WORK'}`]);
  sum.push(['NAME', client_name, '', 'Date-:', new Date().toISOString().slice(0, 10)]);
  sum.push(['ADDRESS', client_address, '', 'Quotation No', quotation_no]);
  sum.push(['PREP BY', prep_by, '', 'Revision No', 'R0']);
  sum.push([]);
  sum.push(['S.No.', 'Description', 'SP Amount (Rs)']);
  let grand = 0;
  catTotals.forEach((c, i) => { sum.push([i + 1, c.cat, Math.round(c.sp * 100) / 100]); grand += c.sp; });
  sum.push(['', 'SUB TOTAL', Math.round(grand * 100) / 100]);
  sum.push([]);
  sum.push(['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount']);
  let mTotal = 0;
  manpower.filter(m => m && m.name).forEach(m => {
    const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);
    sum.push([m.name, m.qty || 0, m.monthly_cost || 0, m.months || 0, Math.round(amt * 100) / 100]);
    mTotal += amt;
  });
  sum.push(['', '', '', 'Manpower Total', Math.round(mTotal * 100) / 100]);
  sum.push(['', '', '', 'GRAND TOTAL', Math.round((grand + mTotal) * 100) / 100]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'SUMMARY');
  wb.SheetNames.unshift(wb.SheetNames.pop()); // SUMMARY first

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// The single entry point. Prefer the styled ExcelJS workbook; degrade to the
// plain SheetJS one if exceljs is missing or styling throws (never 500 for a
// styling reason — matches the original route).
async function buildQuotationBuffer(d) {
  let ExcelJS = null;
  try { ExcelJS = require('exceljs'); } catch { ExcelJS = null; }
  if (ExcelJS) {
    try { return await buildStyledQuotation(ExcelJS, d); }
    catch (_) { /* fall through to plain */ }
  }
  return buildPlainQuotation(d);
}

module.exports = { buildQuotationBuffer };
