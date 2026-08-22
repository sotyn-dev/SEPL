// Solar Quotation engine — ported verbatim (logic-wise) from the standalone
// solar-quotation.html. Pure functions: no DOM, no globals. Takes an `inp`
// (form inputs) + `rb` (rate book from GET /api/solar/rate-book) and returns
// engineering sizing + BOQ line items. Throughput model identical to the SOTYN.AI
// estimator: pp → acc → tp → tpa → margin → sp.

export const DEFAULTS = {
  client: '', addr: '', state: 'Himachal Pradesh', conn: 'ongrid', mount: 'ground', area: 5000, wind: 39, dist: 120,
  kw: 500, dcac: 1.0, wp: 550, ptype: 'Bifacial Mono PERC', voc: 49.6, vmp: 41.7, imp: 13.2, tc: -0.25,
  panelmake: 'Waaree', dcr: '0', invmake: 'Sofar', structmake: 'HDG GI 80µ', cablemake: 'Polycab', tracker: 'fixed',
  vdc: 1100, mppt: 550, dcrun: 44, acrun: 120, dcvd: 3, acvd: 2,
  dg: true, rms: true, clean: true, net: true,
  margin: 22, floor: 15, gst: 13.8, netchg: 500000, cont: 1.5, tariff: 8, valid: 10, amcfree: 10, amcfee: 200000,
  transport: true, escal: true, subsidy: false, scope: true,
  // Who the customer is — drives subsidy eligibility (PM Surya Ghar is
  // residential-only). Mirrors qualification.js's property_type options.
  property_type: 'Commercial',
  // Off-grid / hybrid battery sizing
  backupkw: 25, backuphrs: 4, dod: 80, autonomy: 1, batterytype: 'Li-ion LFP',
  // Finance — pure calculator inputs, not tied to any real lender. The
  // salesperson sets rate/tenure from whatever quote the customer's bank
  // actually gave them.
  loanPct: 100, loanRate: 10.5, loanTenure: 5,
};

const FALLBACK_INV_SIZES = [300, 125, 110, 100, 75, 50, 40, 30, 25, 20, 15, 10, 5];

function pickInverters(kwAC, sizes) {
  const list = sizes && sizes.length ? sizes : FALLBACK_INV_SIZES;
  let rem = Math.round(kwAC), out = {};
  for (const m of list) { while (rem >= m) { out[m] = (out[m] || 0) + 1; rem -= m; } }
  if (rem > 0) { const s = list[list.length - 1]; out[s] = (out[s] || 0) + 1; }
  return out;
}

export function compute(inp, rb) {
  const v = (k) => parseFloat(inp[k]) || 0;
  const kwAC = v('kw'), dcac = v('dcac'), wp = v('wp');
  const voc = v('voc'), vmp = v('vmp'), imp = v('imp'), tc = v('tc') / 100;
  const vdcMax = v('vdc'), mpptMin = v('mppt');
  const st = (rb.factors?.state || {})[inp.state] || {};
  const tmin = st.t_min ?? 5;
  const yieldKwh = st.specific_yield ?? 1600;

  const kWpDC = kwAC * dcac;
  const nPanels = Math.ceil(kWpDC * 1000 / wp);
  const realKWp = nPanels * wp / 1000;

  const vocCold = voc * (1 + (tmin - 25) * tc);
  const vmpHot = vmp * (1 + (65 - 25) * -0.0035);
  const maxSeries = Math.floor(vdcMax / vocCold);
  const minSeries = Math.ceil(mpptMin / vmpHot);
  const perString = Math.min(maxSeries, Math.max(minSeries, 20));
  const nStrings = Math.ceil(nPanels / perString);
  const stringV = perString * vmp;

  const invSel = pickInverters(kwAC, rb.inverterSizes);

  const dcRun = v('dcrun'), dcvdLim = v('dcvd');
  const R4 = 4.95, R6 = 3.30;
  const vd4 = (2 * dcRun * imp * R4 / 1000) / stringV * 100;
  const dcSize = vd4 <= dcvdLim ? '4 mm²' : '6 mm²';
  const dcVD = vd4 <= dcvdLim ? vd4 : (2 * dcRun * imp * R6 / 1000) / stringV * 100;
  const totalDC = Math.round(nStrings * dcRun * 2 / 100) * 100;

  const acRun = v('acrun');
  const iAC = kwAC * 1000 / (1.732 * 415 * 0.95);
  const acRuns = Math.max(1, Math.ceil(iAC / 330));
  const totalAC = acRuns * acRun;

  const nPits = Math.max(4, Math.round(realKWp / 90));
  const earthCable = Math.max(200, Math.round(nPits * 60 / 50) * 50);
  const footprint = realKWp * (inp.mount === 'ground' ? 9 : 7);
  const nLA = Math.max(1, Math.ceil(footprint / 6000));
  const nMC4 = nStrings;

  const PR = rb.settings?.['performance_ratio'] ?? 0.80;
  const trkYield = (rb.factors?.array?.[inp.tracker]?.yield_mult) ?? ({ fixed: 1.0, seasonal: 1.05, tracker: 1.18 }[inp.tracker] || 1);
  const annual = realKWp * yieldKwh * PR * trkYield / 1000; // MWh

  // ── Off-grid / hybrid battery sizing ──
  const isBatt = inp.conn === 'offgrid' || inp.conn === 'hybrid';
  let usableKWh = 0, bankKWh = 0;
  if (isBatt) {
    const backupKw = v('backupkw'), backupHrs = v('backuphrs'), dod = (v('dod') || 80) / 100, autonomy = v('autonomy') || 1;
    usableKWh = backupKw * backupHrs * (inp.conn === 'offgrid' ? autonomy : 1);
    bankKWh = dod > 0 ? usableKWh / dod : 0;
  }

  return { kwAC, dcac, wp, kWpDC, nPanels, realKWp, vocCold, vmpHot, maxSeries, minSeries, perString, nStrings, stringV, invSel, dcSize, dcVD, totalDC, iAC, acRuns, totalAC, nPits, earthCable, footprint, nLA, nMC4, annual, yieldKwh, isBatt, usableKWh, bankKWh };
}

// Effective purchase rates from the rate book, driven by the selected makes.
export function ratesFor(inp, rb) {
  const ui = rb.ui || {}, bos = rb.bos || {}, lab = rb.labour || {};
  const dcr = inp.dcr === '1' || inp.dcr === 1 || inp.dcr === true;
  const pa = (ui.panel || {})[inp.panelmake];
  const panel = pa ? (dcr ? (pa[1] ?? pa[0]) : pa[0]) : 11.5;
  const cab = (ui.cable || {})[inp.cablemake] || [42, 650];
  return {
    panel, inv: (ui.inverter || {})[inp.invmake] ?? 2.6, struct: (ui.structure || {})[inp.structmake] ?? 3.0,
    dc: cab[0] ?? 42, ac: cab[1] ?? 650,
    lab: lab['Installation & Commissioning'] ?? 2.0,
    db: bos['ACDB'] ?? 28000, rms: bos['RMS'] ?? 45000, earth: bos['Earthing'] ?? 5500,
    ecable: bos['Earthing Cable'] ?? 110, la: bos['Lightning Arrestor'] ?? 7500, mc4: bos['MC4 Connector'] ?? 140,
    zec: bos['Zero-Export Controller'] ?? 85000, dgsync: bos['DG Sync'] ?? 38000,
    cabacc: bos['Cable Accessories'] ?? 12000, clean: bos['Cleaning System'] ?? 8000,
    transport: lab['Transportation & Handling'] ?? 150,
  };
}

export function buildBOQ(c, inp, rb) {
  const r = ratesFor(inp, rb);
  const acc = (rb.settings?.['accessories_%'] ?? 3) / 100;
  const margin = (parseFloat(inp.margin) || 0) / 100;
  const isZE = inp.conn === 'zeroexport';
  const isDCR = inp.dcr === '1' || inp.dcr === 1 || inp.dcr === true;
  const surf = (rb.factors?.mount?.[inp.mount]?.struct_mult) ?? ({ ground: 1, rcc: 1.15, tin: 0.85, carport: 1.6, floating: 1.9 }[inp.mount] || 1);
  const surfLbl = { ground: 'ground', rcc: 'RCC roof', tin: 'tin-shed', carport: 'carport', floating: 'floating' }[inp.mount] || inp.mount;
  const trk = (rb.factors?.array?.[inp.tracker]?.struct_mult) ?? ({ fixed: 1, seasonal: 1.1, tracker: 1.45 }[inp.tracker] || 1);
  const wind = parseFloat(inp.wind) || 39, windMult = Math.max(0.9, 1 + (wind - 39) * 0.01);
  const structMult = surf * trk * windMult;

  const lines = [];
  // `cat` = the customer-quotation category a line folds under (mam's format).
  // Panel / inverter / battery lines share a category header with lettered
  // sub-items; everything else is left as its own standalone numbered row
  // (cat = null). See groupBOQ() below.
  const add = (desc, unit, make, qty, ppUnit, labUnit = 0, cat = null) => {
    const pp = ppUnit * qty, a = pp * acc, lab = labUnit * qty, tpa = pp + a + lab, sp = tpa * (1 + margin);
    lines.push({ desc, unit, make, qty, ppUnit, pp, tpa, sp, rate: qty ? sp / qty : sp, cat });
  };
  add(`${c.wp} Wp ${inp.ptype}${isDCR ? ' DCR' : ''} Solar Panel`, 'Nos', inp.panelmake, c.nPanels, c.wp * r.panel, c.wp * r.lab, 'SOLAR PANEL');
  const invCat = c.isBatt ? 'HYBRID INVERTER (MPPT, BATTERY-READY)' : 'STRING INVERTER (MPPT GRID CONNECTED STRING INVERTER)';
  Object.entries(c.invSel).forEach(([kw, nn]) => add(`${kw} kW ${c.isBatt ? 'Hybrid' : 'String'} Inverter (MPPT${c.isBatt ? ', battery-ready' : ', grid-tie'})`, 'Nos', inp.invmake, Number(nn), kw * 1000 * r.inv * (c.isBatt ? 1.35 : 1), 0, invCat));
  // Battery bank (off-grid / hybrid)
  if (c.isBatt && c.bankKWh > 0) {
    const battRate = (rb.ui?.battery?.[inp.batterytype]) ?? 22000;
    add(`Battery Bank — ${inp.batterytype} (${Math.round(c.bankKWh)} kWh usable ${Math.round(c.usableKWh)} kWh)`, 'kWh', inp.batterytype, Math.round(c.bankKWh), battRate, 0, 'BATTERY BANK');
    add('Battery rack, BMS & DC cabling', 'Set', 'Standard', 1, Math.round(c.bankKWh * battRate * 0.08), 0, 'BATTERY BANK');
  }
  add(`Module Mounting Structure — ${inp.structmake}${inp.tracker === 'tracker' ? ' (single-axis tracker)' : ''} (${surfLbl}, civil incl.)`, 'kWp', inp.structmake, Math.round(c.realKWp), r.struct * 1000 * structMult);
  const nInv = Object.values(c.invSel).reduce((a, b) => a + b, 0);
  add('AC & DC Distribution Box (with SPD & protections)', 'Set', 'Standard', nInv, r.db);
  if (isZE) add('Zero-Export Controller / Export Limiter (with grid CTs & reverse-power relay)', 'Set', 'Standard', 1, r.zec);
  add(`DC Solar String Cable (1C×${c.dcSize} Cu, TÜV)`, 'Mtr', inp.cablemake, c.totalDC, r.dc);
  add(`AC Cable (Al XLPE armoured, ${c.acRuns} run)`, 'Mtr', inp.cablemake, c.totalAC, r.ac);
  if (inp.dg) add('Solar DG Synchronization System', 'Set', 'Standard', 1, r.dgsync);
  if (inp.rms) add('Plant Monitoring (RMS)', 'Set', 'Standard', 1, r.rms);
  add('MC4 Connector (pair)', 'Pair', 'OEM', c.nMC4, r.mc4);
  add('Cable accessories (ties, clamps, ferrules, thimble)', 'Set', 'Standard', 1, r.cabacc + c.realKWp * 40);
  add('Earthing (copper bonded)', 'Set', 'Cu Bonded', c.nPits, r.earth);
  add('Earthing Cable', 'Mtr', inp.cablemake, c.earthCable, r.ecable);
  add('Lightning Arrestor', 'Nos', 'Cu Bonded', c.nLA, r.la);
  if (inp.clean) add('Solar panel cleaning system', 'Lot', 'Standard', 1, r.clean + c.realKWp * 30);
  const dist = parseFloat(inp.dist) || 0;
  if (dist > 0) { const trucks = Math.max(1, Math.ceil(c.realKWp / 100)); add(`Transportation & handling (${dist} km)`, 'Lot', '—', 1, Math.round(dist * r.transport * trucks)); }
  const cont = (parseFloat(inp.cont) || 0) / 100;
  if (cont > 0) { const matPP = lines.reduce((a, l) => a + l.pp, 0); add(`Contingency & wastage (${inp.cont}%)`, 'Lot', '—', 1, Math.round(matPP * cont)); }
  return lines;
}

// Fold the flat BOQ into the numbered-category shape mam's quotation uses:
//   1.0 SOLAR PANEL            (category header)
//     a  590 Wp … Solar Panel  (lettered sub-item, carries unit/make/qty)
//   3.0 Module Mounting …      (standalone line — its own numbered row)
// Panel / inverter / battery lines (those given a `cat`) group under a header
// with lettered sub-items; every other line becomes its own single row.
// Returns [{ no:'1.0', name, grouped:bool, items:[{desc,unit,make,qty}] }].
export function groupBOQ(lines) {
  const cats = [];
  let cur = null;
  for (const l of (lines || [])) {
    const item = { desc: l.desc, unit: l.unit, make: l.make, qty: l.qty };
    if (l.cat) {
      if (cur && cur.name === l.cat) { cur.items.push(item); continue; }
      cur = { name: l.cat, grouped: true, items: [item] };
      cats.push(cur);
    } else {
      cats.push({ name: l.desc, grouped: false, items: [item] });
      cur = null;
    }
  }
  return cats.map((cat, i) => ({ no: `${i + 1}.0`, ...cat }));
}

export function summarize(lines, c) {
  const totPP = lines.reduce((a, l) => a + l.pp, 0);
  const totTPA = lines.reduce((a, l) => a + l.tpa, 0);
  const totSP = lines.reduce((a, l) => a + l.sp, 0);
  const marginPct = totTPA ? (totSP - totTPA) / totTPA * 100 : 0;
  const wpRate = c.realKWp ? totSP / (c.realKWp * 1000) : 0;
  return { totPP, totTPA, totSP, marginPct, wpRate, kwRate: wpRate * 1000 };
}

// PM Surya Ghar Muft Bijli Yojana — central financial assistance (CFA) for
// residential rooftop solar (MNRE scheme, launched Feb-2024): ₹30,000/kW up
// to 2 kW, ₹18,000/kW for the 2–3 kW slab, flat ₹78,000 above 3 kW. CFA
// eligibility itself caps at 10 kWp. Residential + on-grid + rooftop only —
// commercial/industrial, ground-mount and off-grid systems don't qualify.
// State top-up subsidies vary too much (and change too often) to hard-code
// safely — solar_factors carries a per-state top-up that defaults to ₹0
// until Solar Settings has a confirmed figure for that state.
export function computeSubsidy(c, inp, rb) {
  const wants = inp.subsidy === true || inp.subsidy === 'true';
  const isResidential = inp.property_type === 'Residential';
  const isRooftop = inp.mount === 'rcc' || inp.mount === 'tin';
  const eligible = wants && isResidential && inp.conn === 'ongrid' && isRooftop;
  if (!eligible) {
    let reason = null;
    if (wants && !isResidential) reason = `PM Surya Ghar is residential-only — this quote is marked ${inp.property_type || 'non-residential'}.`;
    else if (wants && inp.conn !== 'ongrid') reason = 'Subsidy needs an on-grid (net-metering) connection.';
    else if (wants && !isRooftop) reason = 'Subsidy applies to rooftop (RCC / tin-shed) mounting only.';
    return { eligible: false, reason, centralSubsidy: 0, stateSubsidy: 0, totalSubsidy: 0 };
  }
  const kwp = Math.min(c.realKWp, 10); // CFA eligibility ceiling
  const central = kwp <= 2 ? kwp * 30000 : kwp <= 3 ? 2 * 30000 + (kwp - 2) * 18000 : 78000;
  const stateSubsidy = (rb.factors?.state?.[inp.state] || {}).subsidy_topup || 0;
  return {
    eligible: true, reason: null,
    centralSubsidy: Math.round(central), stateSubsidy: Math.round(stateSubsidy),
    totalSubsidy: Math.round(central + stateSubsidy),
  };
}

export function computeROI(c, grand, inp, rb) {
  const tariff = parseFloat(inp.tariff) || 0;
  const annualKWh = c.annual * 1000;
  const annualSav = annualKWh * tariff;
  const subsidy = computeSubsidy(c, inp, rb);
  const netCost = Math.max(0, grand - subsidy.totalSubsidy);
  const payback = annualSav > 0 ? netCost / annualSav : 0;
  const f25 = 22.67; // Σ degradation factor over 25 yrs @ ~0.8%/yr
  const sav25 = annualKWh * f25 * tariff;
  const co2 = annualKWh * (rb.settings?.['co2_factor_kg/kWh'] ?? 0.82) / 1000; // t/yr
  return { annualKWh, annualSav, payback, sav25, co2, subsidy, netCost };
}

// Standard reducing-balance EMI. A pure calculator — rate/tenure are
// whatever the salesperson enters from the customer's actual bank quote,
// not pulled from any live lender integration.
export function computeEMI(principal, annualRatePct, tenureYears) {
  const P = Math.max(0, principal || 0);
  const n = Math.round((tenureYears || 0) * 12);
  const r = (annualRatePct || 0) / 100 / 12;
  if (n <= 0 || P <= 0) return { emi: 0, totalPayment: 0, totalInterest: 0, months: 0 };
  if (r <= 0) { const emi = P / n; return { emi, totalPayment: emi * n, totalInterest: 0, months: n }; }
  const factor = Math.pow(1 + r, n);
  const emi = (P * r * factor) / (factor - 1);
  return { emi, totalPayment: emi * n, totalInterest: emi * n - P, months: n };
}

/** EMI on the financed share of the grand total, per the quote's loan inputs. */
export function computeFinance(grand, inp) {
  const principal = (grand || 0) * ((parseFloat(inp.loanPct) || 0) / 100);
  return { principal, ...computeEMI(principal, parseFloat(inp.loanRate) || 0, parseFloat(inp.loanTenure) || 0) };
}

export const PROJECT_TYPES = [
  { v: 'ongrid', label: 'On-grid (net metering)' },
  { v: 'zeroexport', label: 'Zero-export (no grid feed)' },
  { v: 'hybrid', label: 'Hybrid (battery)' },
  { v: 'offgrid', label: 'Off-grid (battery)' },
  { v: 'pump', label: 'Solar pump / SWH' },
  { v: 'streetlight', label: 'Solar street lighting' },
  { v: 'thermal', label: 'Solar thermal' },
];
export const MOUNTS = [
  { v: 'ground', label: 'Ground-mount' }, { v: 'rcc', label: 'Rooftop RCC' }, { v: 'tin', label: 'Rooftop tin-shed' },
  { v: 'carport', label: 'Carport / shed' }, { v: 'floating', label: 'Floating' },
];
// Mirrors qualification.js's property_type options — same vocabulary the
// qualification call already uses, so a value picked there means the same
// thing here.
export const PROPERTY_TYPES = ['Residential', 'Commercial', 'Industrial', 'Institutional', 'Agricultural'];
export const ARRAY_TYPES = [
  { v: 'fixed', label: 'Fixed tilt' }, { v: 'seasonal', label: 'Seasonal tilt' }, { v: 'tracker', label: 'Single-axis tracker' },
];
export const typeLabel = (conn) => ({ ongrid: 'ON GRID', zeroexport: 'ZERO EXPORT', hybrid: 'HYBRID', offgrid: 'OFF GRID', pump: 'SOLAR PUMP/SWH' }[conn] || 'SOLAR');
