// Read a vendor's quotation and pick the rate for each ticked Vendor Rates item
// by matching item names (mam 2026-09-11: "select items and vendor upload
// pdf/imag anything else pick rate by item match").
//
// Input: the ticked items + the uploaded file (PDF, photo, Excel, CSV, Word).
// Output per item: the unit rate found, the quotation line it came from, and a
// confidence — a PROPOSAL the purchase team reviews before anything is saved.
//
//   • AI configured (Admin → AI Settings): the AI reads the quotation text, or
//     the photo / scanned PDF itself, and matches every item.
//   • No AI, or AI failed on a text quotation: word-match each item to its best
//     quotation line (lib/textMatch) and take the price from that line.
//   • A photo / scanned PDF without AI → a clear message (nothing to read).

const { tokens, scoreMatch } = require('./textMatch');
const { aiComplete, aiConfig, extractJsonArray } = require('./aiComplete');

const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const NA = /^n\/?a$/i;

const toLines = (text) => String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 1);
const httpError = (message, status) => Object.assign(new Error(message), { status });

// PDF text, one line per printed row, table cells joined with " | ".
// pdf-parse's own text glues neighbouring cells ("63mm217903580" = size, qty,
// rate and amount in one word), which made "12 V" and "6 Amp" look like the
// only prices on the line — so rebuild each row from the X/Y positions.
async function pdfTextLines(buffer) {
  const pages = [];
  const pagerender = (pageData) =>
    pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((tc) => {
        pages.push({
          n: pageData.pageNumber,
          items: tc.items
            .filter((it) => String(it.str).trim())
            .map((it) => ({ s: String(it.str), x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 10 })),
        });
        return '';
      });
  await require('pdf-parse')(buffer, { pagerender });
  pages.sort((a, b) => a.n - b.n);
  const out = [];
  for (const pg of pages) {
    const rows = [];
    for (const it of [...pg.items].sort((a, b) => b.y - a.y)) {   // top of the page first
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - it.y) <= Math.max(2, it.h * 0.3)) row.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prev = null;
      for (const it of row.items) {
        if (prev) {
          const gap = it.x - (prev.x + prev.w);
          if (gap > Math.max(4, prev.h * 0.8)) text = text.trimEnd() + ' | ';          // next table cell
          else if (gap > prev.h * 0.15 && !/\s$/.test(text) && !/^\s/.test(it.s)) text += ' ';
        }
        text += it.s;
        prev = it;
      }
      out.push(text);
    }
  }
  return toLines(out.join('\n'));
}

// → { lines: [string], attachment: { mime, data, name } | null }
async function readQuotation(buffer, originalName) {
  const ext = String(originalName || '').toLowerCase().split('.').pop();
  if (IMAGE_MIME[ext]) {
    return { lines: [], attachment: { mime: IMAGE_MIME[ext], data: buffer.toString('base64'), name: originalName } };
  }
  if (ext === 'pdf') {
    let lines = [];
    try { lines = await pdfTextLines(buffer); } catch (_) { lines = []; }
    // A scanned PDF has (almost) no text layer — the AI reads the pages instead.
    const scanned = lines.join('').replace(/[^a-z0-9]/gi, '').length < 40;
    return { lines: scanned ? [] : lines, attachment: scanned ? { mime: 'application/pdf', data: buffer.toString('base64'), name: originalName } : null };
  }
  if (ext === 'docx') {
    const r = await require('mammoth').extractRawText({ buffer });
    return { lines: toLines(r.value), attachment: null };
  }
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const lines = [];
    for (const name of wb.SheetNames) {
      for (const row of XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })) {
        const cells = (row || []).map(c => (c == null ? '' : String(c).trim())).filter(Boolean);
        if (cells.length) lines.push(cells.join(' | '));
      }
    }
    return { lines, attachment: null };
  }
  throw httpError('Upload the quotation as PDF, photo (JPG / PNG), Excel, CSV or Word (.docx)', 400);
}

// A word after a number that makes it a size / spec / part of the name, not a price.
const SPEC_WORDS = new Set(['v', 'vdc', 'vac', 'volt', 'volts', 'dc', 'ac', 'amp', 'amps', 'mm', 'cm', 'm', 'mtr', 'mtrs',
  'meter', 'metre', 'meters', 'metres', 'kg', 'kgs', 'g', 'gm', 'gms', 'ltr', 'ltrs', 'l', 'litre', 'liter', 'litres', 'liters',
  'w', 'watt', 'watts', 'kw', 'kva', 'hp', 'inch', 'inches', 'ft', 'feet', 'sqmm', 'sq', 'core', 'bar', 'psi', 'nb', 'hz',
  'ah', 'mah', 'ton', 'tons', 'pin', 'way', 'door', 'pole', 'phase', 'ph', 'gang', 'step', 'x']);

// "1,500.00", "Rs.2000", "₹ 9,000", "1500/-" → number; anything else → null.
const plainNumber = (s, allowQtyUnit) => {
  let t = String(s || '').trim().replace(/^(rs\.?|inr)\s*/i, '').replace(/[₹,]/g, '').replace(/\/-$/, '').trim();
  if (allowQtyUnit) t = t.replace(/\s*(nos?|pcs?|each|sets?)\.?$/i, '');
  return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
};

// Plain numbers on a quotation line.
//  • Table row (Excel / CSV / PDF columns, "a | b | c"): only a cell that is just a
//    number is a qty / rate / amount — "3 Pin Top Plug 6 Amp" in the description
//    cell holds no prices.
//  • Free text: numbers glued to letters ("25MM", "12volt") and numbers followed
//    by a spec word ("12 V", "6 Amp", "3 Pin") are part of the item, not prices.
function numbersIn(line) {
  const s = String(line || '');
  if (s.includes('|')) return s.split('|').map(c => plainNumber(c, true)).filter(n => n != null);
  const toks = s.split(/\s+/);
  const out = [];
  toks.forEach((tok, i) => {
    const n = plainNumber(tok, false);
    if (n == null) return;
    const next = String(toks[i + 1] || '').toLowerCase().replace(/[^a-z].*$/, '');
    if (!SPEC_WORDS.has(next)) out.push(n);
  });
  return out;
}

// The unit rate on one quotation line, for an item of quantity `qty`.
function rateFromLine(line, qty) {
  let nums = numbersIn(line);
  // A leading serial number ("3 | FIRE BUCKET …", "3. FIRE BUCKET") is not a price.
  if (nums.length > 1 && /^\s*\d{1,3}\s*[|.)]?\s/.test(line)) nums = nums.slice(1);
  if (!nums.length) return null;
  // qty × rate = amount on the same line → the rate is the factor that isn't the qty.
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      for (let k = 0; k < nums.length; k++) {
        if (k === i || k === j) continue;
        const a = nums[i], b = nums[j], c = nums[k];
        if (a > 0 && b > 0 && Math.abs(a * b - c) <= Math.max(0.5, c * 0.005)) {
          if (qty && a === qty) return { rate: b, how: 'qty × rate = amount' };
          if (qty && b === qty) return { rate: a, how: 'qty × rate = amount' };
          return { rate: b, how: 'qty × rate = amount' };
        }
      }
    }
  }
  if (nums.length === 1) return { rate: nums[0], how: 'only price on the line' };
  // "qty rate" with no amount: the qty is not the rate.
  if (qty && nums[nums.length - 2] === qty) return { rate: nums[nums.length - 1], how: 'number after the qty' };
  return { rate: nums[nums.length - 2], how: 'rate before the amount' };
}

const itemText = (it) => [it.name, it.specification, it.size].filter(p => p && !NA.test(String(p).trim())).join(' / ');

// Word-match fallback: each item → its best quotation line → the price on it.
function textMatch(items, lines) {
  const lineTokens = lines.map(l => new Set(tokens(l)));
  return items.map((it, index) => {
    const itemTokens = tokens(itemText(it));
    let best = null;
    lines.forEach((_, li) => {
      const score = scoreMatch(lineTokens[li], itemTokens);
      if (score > 0 && (!best || score > best.score)) best = { li, score };
    });
    if (!best || best.score < 0.2) return { index, rate: null, quoted_text: '', unit: '', confidence: 0, how: 'no matching line' };
    const found = rateFromLine(lines[best.li], Number(it.qty) || 0);
    return {
      index,
      rate: found ? found.rate : null,
      quoted_text: lines[best.li].slice(0, 300),
      unit: '',
      confidence: +(best.score * (found ? 1 : 0.5)).toFixed(2),
      how: found ? found.how : 'matched line has no price',
    };
  });
}

async function aiMatch(db, items, quote) {
  const list = items.map((it, i) => `${i}. ${itemText(it)}${it.make ? ` (make ${it.make})` : ''} — qty ${it.qty || '?'} ${it.unit || ''}`).join('\n');
  const prompt = `You are reading a vendor's price quotation for a fire-fighting / electrical contractor in India.
For EACH numbered item below, find the matching line in the quotation and give its UNIT RATE: the price of ONE unit in rupees, before GST when both are shown. If the quotation has no line for an item, give rate null — never take the rate of a different item.
Return ONLY a JSON array, one object per item:
[{"item": <item number>, "rate": <number or null>, "quoted_text": "<the quotation line you used>", "unit": "<unit written on the quotation>", "confidence": <0 to 1>}]

ITEMS:
${list}
${quote.lines.length ? `\nQUOTATION TEXT:\n${quote.lines.join('\n').slice(0, 14000)}` : '\nThe quotation is attached.'}`;
  const res = await aiComplete(db, {
    prompt, json: true, maxTokens: 4096, timeout: 55000, prefer: 'capable', retries429: 1,
    attachments: quote.attachment ? [quote.attachment] : [],
  });
  const arr = extractJsonArray(res.text);
  if (!arr) throw new Error('the AI answer had no rates in it');
  return items.map((_, index) => {
    const o = arr.find(x => x && Number(x.item) === index);
    const rate = o && Number(o.rate) > 0 ? +Number(o.rate).toFixed(2) : null;
    return {
      index,
      rate,
      quoted_text: o ? String(o.quoted_text || '').slice(0, 300) : '',
      unit: o ? String(o.unit || '').slice(0, 20) : '',
      confidence: o ? Math.max(0, Math.min(1, Number(o.confidence) || 0)) : 0,
      how: 'AI',
    };
  });
}

// items: [{ name, specification, size, make, qty, unit }]
async function matchQuotationRates(db, items, buffer, originalName) {
  const quote = await readQuotation(buffer, originalName);
  const hasText = quote.lines.length > 0;
  if (aiConfig(db).configured) {
    try {
      return { source: 'ai', lines_read: quote.lines.length, matches: await aiMatch(db, items, quote) };
    } catch (e) {
      console.warn('[quote-rates] AI read failed:', e.status || '', e.message);
      if (!hasText) throw httpError(`AI could not read this quotation (${e.message}). Try the Excel or text PDF version.`, 502);
    }
  }
  if (!hasText) {
    throw httpError(quote.attachment
      ? 'A photo or scanned PDF can only be read with AI. Turn AI on in Admin → AI Settings, or upload the Excel / text PDF quotation.'
      : 'No text could be read from this file.', 400);
  }
  return { source: 'text', lines_read: quote.lines.length, matches: textMatch(items, quote.lines) };
}

module.exports = { readQuotation, numbersIn, rateFromLine, textMatch, matchQuotationRates };
