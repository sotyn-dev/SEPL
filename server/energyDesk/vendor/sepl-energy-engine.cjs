/*
 * SEPL Energy Desk engine — GENERATED, do not edit by hand.
 * Source: sotyn-dev/secured-engineers-website src/lib/energy-desk (+ src/lib/solar)
 * Engine version: 1.0.0
 * Source sha256: 8ae44bc33c8f07e5ef5a8b21dde0753286332f9cce35c0aeb88cc1315243b358
 * Built from commit: 2ded5fd
 * Rebuild with `npm run build:engine` in the website repo and copy the file
 * to server/energyDesk/vendor/ in the ERP.
 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/lib/energy-desk/index.ts
var index_exports = {};
__export(index_exports, {
  DISCLAIMER: () => DISCLAIMER,
  ENGINE_SOURCES: () => ENGINE_SOURCES,
  ENGINE_SOURCE_SHA256: () => ENGINE_SOURCE_SHA256,
  ENGINE_VERSION: () => ENGINE_VERSION,
  REGIONS: () => REGIONS,
  STATE_REGION: () => STATE_REGION,
  avoidableRate: () => avoidableRate,
  buildReport: () => buildReport,
  isOwnerPlaceholder: () => isOwnerPlaceholder,
  leadFields: () => leadFields,
  regionForState: () => regionForState,
  resolveConfig: () => resolveConfig,
  roundKwp: () => roundKwp,
  summaryLine: () => summaryLine,
  validate: () => validate
});
module.exports = __toCommonJS(index_exports);

// src/lib/energy-desk/config.ts
var OWNER = /^\[\[OWNER/;
function isOwnerPlaceholder(v) {
  return typeof v === "string" && OWNER.test(v);
}
function sourced(v, kind) {
  if (!v || typeof v !== "object") return null;
  const o = v;
  if (typeof o.source !== "string" || !o.source.trim()) return null;
  if (kind === "number" && (typeof o.value !== "number" || !Number.isFinite(o.value))) return null;
  if (kind === "string" && typeof o.value !== "string") return null;
  return {
    value: o.value,
    source: o.source,
    ...typeof o.verifiedOn === "string" ? { verifiedOn: o.verifiedOn } : {},
    ...typeof o.url === "string" ? { url: o.url } : {}
  };
}
function resolveState(raw) {
  if (!raw || typeof raw !== "object" || isOwnerPlaceholder(raw)) return null;
  const r = raw;
  return {
    meteringRegime: sourced(r.meteringRegime, "string"),
    netMeteringCapPct: sourced(r.netMeteringCapPct, "number"),
    capBasis: sourced(r.capBasis, "string"),
    kvaToKw: sourced(r.kvaToKw, "number"),
    netMeteringMaxKwp: sourced(r.netMeteringMaxKwp, "number"),
    feederLimitPct: sourced(r.feederLimitPct, "number"),
    yearEndSurplusPctOfFit: sourced(r.yearEndSurplusPctOfFit, "number"),
    todIndustrialAboveKva: sourced(r.todIndustrialAboveKva, "number")
  };
}
function resolveConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const obj = (v) => v && typeof v === "object" ? v : {};
  const s = obj(c.settings);
  const states = {};
  for (const [name, v] of Object.entries(c.states || {})) states[name] = resolveState(v);
  return {
    version: typeof c.version === "string" ? c.version : "unknown",
    settings: {
      erpModuleLive: s.erpModuleLive === true,
      erpApiBase: typeof s.erpApiBase === "string" ? s.erpApiBase : "",
      healthTimeoutMs: typeof s.healthTimeoutMs === "number" ? s.healthTimeoutMs : 3e3,
      aiExtraction: s.aiExtraction === true
    },
    sqftPerKw: sourced(obj(c.roof).sqftPerKw, "number"),
    openAccessMinKw: sourced(obj(c.detectors).openAccessMinKw, "number"),
    states
  };
}

// src/lib/solar/assumptions.ts
var DEFAULTS = {
  unitsPerKwPerMonth: 120,
  costPerKw: 28e3,
  costBandPct: 0.11,
  sqftPerKw: 100,
  degradationRate: 5e-3,
  co2PerUnit: 0.71,
  omPctOfCapex: 0.01,
  tariffEscalation: 0.03,
  discountRate: 0.1,
  projectLifeYears: 25,
  inverterReplacementYear: 12,
  inverterReplacementPctOfCapex: 0.07
};
var ASSUMPTION_NOTES = {
  unitsPerKwPerMonth: "North India annual average (~4 peak sun hours). Real yield varies by site, tilt, shading and season \u2014 winter fog months run materially below this.",
  costPerKw: "Turnkey C&I rooftop benchmark, excluding GST. Structure type, HT works and cable runs move this more than module brand does.",
  costBandPct: "Band shown around the benchmark cost.",
  sqftPerKw: "Shadow-free area per kW. Skylights, vents and parapet shadows typically remove 10\u201320% of paper roof area.",
  degradationRate: "Annual output decline, typical Tier-1 linear warranty.",
  co2PerUnit: "Indian grid emission factor, CEA CO2 Baseline Database FY24-25.",
  omPctOfCapex: "Annual operations & maintenance as a share of project cost.",
  tariffEscalation: "Assumed annual grid tariff rise. Historic C&I escalation has varied by state; this is deliberately conservative.",
  discountRate: "Discount rate for NPV \u2014 represents your cost of capital / hurdle rate.",
  projectLifeYears: "Modelling horizon. Modules typically carry 25-year performance warranties.",
  inverterReplacementYear: "Assumed inverter replacement year.",
  inverterReplacementPctOfCapex: "Inverter replacement cost as a share of original project cost."
};
var DISCLAIMER = "Indicative estimate only. Actual generation, savings and payback depend on site conditions, irradiation, tariff structure, system design, equipment selection, DISCOM regulations, financing terms and execution. Figures are not guaranteed and are subject to a site survey and electricity-bill analysis.";
var REGIONS = [
  {
    id: "north",
    label: "North India",
    states: "Punjab, Haryana, Delhi NCR, UP, Uttarakhand, HP",
    unitsPerKwPerMonth: 120,
    shape: [0.86, 0.95, 1.08, 1.14, 1.16, 1.02, 0.88, 0.9, 1.02, 1.08, 0.96, 0.83],
    note: "Strong summers, but a genuine December\u2013January fog trough across the Punjab\u2013Haryana\u2013western UP belt."
  },
  {
    id: "west",
    label: "West India",
    states: "Rajasthan, Gujarat",
    unitsPerKwPerMonth: 135,
    shape: [1.02, 1.08, 1.15, 1.18, 1.16, 0.92, 0.72, 0.75, 0.95, 1.08, 1.02, 0.97],
    note: "India's highest irradiation belt. Sharp monsoon dip in July\u2013August, no meaningful winter fog."
  },
  {
    id: "central",
    label: "Central India",
    states: "Madhya Pradesh, Chhattisgarh, Vidarbha",
    unitsPerKwPerMonth: 128,
    shape: [1.02, 1.08, 1.14, 1.16, 1.14, 0.94, 0.74, 0.78, 0.96, 1.06, 1.02, 0.96],
    note: "High irradiation with a pronounced monsoon trough."
  },
  {
    id: "south",
    label: "South India",
    states: "Karnataka, Tamil Nadu, Telangana, Andhra Pradesh, Kerala",
    unitsPerKwPerMonth: 128,
    shape: [1.06, 1.12, 1.16, 1.12, 1.02, 0.88, 0.84, 0.88, 0.96, 0.96, 0.98, 1.02],
    note: "The flattest profile in the country \u2014 no winter trough, and two monsoons spread the dip rather than concentrating it."
  },
  {
    id: "east",
    label: "East India",
    states: "West Bengal, Bihar, Jharkhand, Odisha",
    unitsPerKwPerMonth: 115,
    shape: [0.98, 1.06, 1.14, 1.16, 1.1, 0.88, 0.76, 0.8, 0.9, 1.02, 1.04, 0.98],
    note: "Lower than the west on annual irradiation, with a heavy monsoon and higher humidity."
  },
  {
    id: "northeast",
    label: "North East & hills",
    states: "Assam, Meghalaya, Sikkim and the eastern hill states",
    unitsPerKwPerMonth: 105,
    shape: [0.98, 1.06, 1.12, 1.1, 1.02, 0.86, 0.8, 0.84, 0.94, 1.08, 1.1, 1.02],
    note: "The lowest band nationally \u2014 persistent cloud cover and very high monsoon rainfall."
  }
];
function normaliseShape(shape) {
  const mean = shape.reduce((a, b) => a + b, 0) / shape.length;
  return mean > 0 ? shape.map((f) => f / mean) : shape;
}
for (const r of REGIONS) r.shape = normaliseShape(r.shape);
function findRegion(id) {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}

// src/lib/solar/finance.ts
function npv(rate, cashFlows) {
  if (!cashFlows.length) return 0;
  if (rate <= -1) return NaN;
  return cashFlows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
}
function irr(cashFlows, lo = -0.9999, hi = 10) {
  if (cashFlows.length < 2) return null;
  const hasPositive = cashFlows.some((c) => c > 0);
  const hasNegative = cashFlows.some((c) => c < 0);
  if (!hasPositive || !hasNegative) return null;
  let fLo = npv(lo, cashFlows);
  let fHi = npv(hi, cashFlows);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) return null;
  let mid = 0;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const fMid = npv(mid, cashFlows);
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return mid;
}
function paybackYears(cashFlows) {
  let cumulative = 0;
  for (let t = 0; t < cashFlows.length; t++) {
    const prev = cumulative;
    cumulative += cashFlows[t];
    if (cumulative >= 0 && t > 0) {
      const needed = -prev;
      const thisYear = cashFlows[t];
      if (thisYear <= 0) continue;
      return t - 1 + needed / thisYear;
    }
  }
  return null;
}
function discountedPaybackYears(cashFlows, rate) {
  const discounted = cashFlows.map((cf, t) => cf / Math.pow(1 + rate, t));
  return paybackYears(discounted);
}
function roi(cashFlows) {
  const outlay = -cashFlows[0];
  if (!(outlay > 0)) return null;
  const net = cashFlows.reduce((a, b) => a + b, 0);
  return net / outlay;
}

// src/lib/solar/model.ts
function sizeSystem(input, a = DEFAULTS) {
  const tariff = Math.max(0.01, input.tariff);
  const monthlyUnits = input.monthlyBill / tariff;
  const kwByConsumption = monthlyUnits / a.unitsPerKwPerMonth;
  const kwByRoof = input.roofArea / a.sqftPerKw;
  const kwBySanction = input.sanctionedLoadKw && input.sanctionedLoadKw > 0 ? input.sanctionedLoadKw : Infinity;
  const systemKw = Math.max(0, Math.min(kwByConsumption, kwByRoof, kwBySanction));
  let limitedBy = "consumption";
  if (kwByRoof <= kwByConsumption && kwByRoof <= kwBySanction) limitedBy = "roof";
  else if (kwBySanction < kwByConsumption && kwBySanction < kwByRoof) limitedBy = "sanctioned load";
  const areaUsedSqft = systemKw * a.sqftPerKw;
  return {
    monthlyUnits,
    kwByConsumption,
    kwByRoof,
    kwBySanction,
    limitedBy,
    systemKw,
    areaUsedSqft,
    roofUtilisation: input.roofArea > 0 ? Math.min(1, areaUsedSqft / input.roofArea) : 0
  };
}
function annualGeneration(systemKw, year, a = DEFAULTS) {
  const year0 = systemKw * a.unitsPerKwPerMonth * 12;
  return year0 * Math.pow(1 - a.degradationRate, Math.max(0, year - 1));
}
var MONTHLY_SHAPE = normaliseShape([0.86, 0.95, 1.08, 1.14, 1.16, 1.02, 0.88, 0.9, 1.02, 1.08, 0.96, 0.83]);
function monthlyGeneration(systemKw, a = DEFAULTS, shape = MONTHLY_SHAPE) {
  const avg = systemKw * a.unitsPerKwPerMonth;
  return shape.map((f) => avg * f);
}
function buildModel(input, overrides = {}) {
  const a = { ...DEFAULTS, ...overrides };
  const sizing = sizeSystem(input, a);
  const systemKw = input.systemKw && input.systemKw > 0 ? input.systemKw : sizing.systemKw;
  const costPerKw = input.costPerKw ?? a.costPerKw;
  const capex = systemKw * costPerKw;
  const netCapex = Math.max(0, capex - (input.incentive ?? 0));
  const annualConsumption = sizing.monthlyUnits * 12;
  const rows = [];
  let cumulative = -netCapex;
  for (let y = 1; y <= a.projectLifeYears; y++) {
    const generationKwh = annualGeneration(systemKw, y, a);
    const tariff = input.tariff * Math.pow(1 + a.tariffEscalation, y - 1);
    const usableKwh = Math.min(generationKwh, annualConsumption);
    const grossSaving = usableKwh * tariff;
    const om = capex * a.omPctOfCapex;
    const otherCost = y === a.inverterReplacementYear ? capex * a.inverterReplacementPctOfCapex : 0;
    const netCashFlow = grossSaving - om - otherCost;
    cumulative += netCashFlow;
    rows.push({ year: y, generationKwh, tariff, grossSaving, om, otherCost, netCashFlow, cumulative });
  }
  const cashFlows = [-netCapex, ...rows.map((r) => r.netCashFlow)];
  const year1 = rows[0];
  const co2PerYear = year1.generationKwh * a.co2PerUnit / 1e3;
  return {
    sizing,
    capex,
    netCapex,
    year1Generation: year1.generationKwh,
    year1Saving: year1.grossSaving,
    monthlySaving: year1.grossSaving / 12,
    monthlyGenerationKwh: monthlyGeneration(systemKw, a, input.shape ?? MONTHLY_SHAPE),
    rows,
    cashFlows,
    lifetimeSaving: rows.reduce((s, r) => s + r.netCashFlow, 0),
    irr: irr(cashFlows),
    npv: npv(a.discountRate, cashFlows),
    roi: roi(cashFlows),
    paybackYears: paybackYears(cashFlows),
    discountedPaybackYears: discountedPaybackYears(cashFlows, a.discountRate),
    co2TonnesPerYear: co2PerYear,
    co2TonnesLifetime: rows.reduce((s, r) => s + r.generationKwh * a.co2PerUnit / 1e3, 0),
    assumptions: a
  };
}
var CO2_PER_TREE_PER_YEAR_KG = 21;
function treesEquivalent(tonnesPerYear) {
  return Math.round(tonnesPerYear * 1e3 / CO2_PER_TREE_PER_YEAR_KG);
}

// src/lib/energy-desk/report.ts
var round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
function roundKwp(kw) {
  if (!Number.isFinite(kw) || kw <= 0) return 0;
  return kw < 10 ? Math.floor(kw * 10) / 10 : Math.floor(kw);
}
function avoidableRate(b) {
  const kwh = b.monthlyKwh;
  const fixed = b.fixedDemandInr;
  if (fixed != null && fixed >= 0 && fixed < b.monthlyBillInr) {
    return {
      inrPerKwh: (b.monthlyBillInr - fixed) / kwh,
      excludesFixed: true,
      basis: "Your bill less its fixed and demand charges, divided by the units \u2014 the part of the bill solar can actually cut."
    };
  }
  return {
    inrPerKwh: b.monthlyBillInr / kwh,
    excludesFixed: false,
    basis: "Your whole bill divided by the units. It still includes fixed and demand charges, which solar does not cut, so the saving shown is on the high side \u2014 enter those charges for a closer figure."
  };
}
function loadInKw(b, rules) {
  const v = b.sanctionedLoad;
  if (v == null || !(v > 0)) return null;
  if ((b.sanctionedLoadUnit ?? "kW") === "kW") return { kw: v, label: `${v} kW sanctioned load` };
  const f = rules?.kvaToKw?.value;
  if (f) return { kw: v * f, label: `${v} kVA contract demand \xD7 ${f}`, factorSource: rules?.kvaToKw?.source };
  return { kw: v, label: `${v} kVA, compared as printed (no conversion factor is configured for ${b.state})` };
}
function validate(b) {
  const errors = [];
  if (!b.state) errors.push("Choose your state.");
  if (!REGIONS.some((r) => r.id === b.regionId)) errors.push("Choose your solar region.");
  if (!(b.monthlyKwh > 0)) errors.push("Enter your average monthly units (kWh).");
  if (!(b.monthlyBillInr > 0)) errors.push("Enter your average monthly bill (\u20B9).");
  if (b.fixedDemandInr != null && !(b.fixedDemandInr >= 0 && b.fixedDemandInr < b.monthlyBillInr)) {
    errors.push("Fixed and demand charges must be less than the whole bill.");
  }
  if (b.sanctionedLoad != null && !(b.sanctionedLoad > 0)) errors.push("Sanctioned load must be more than zero, or left blank.");
  if (b.roofSqft != null && !(b.roofSqft > 0)) errors.push("Roof area must be more than zero, or left blank.");
  if (b.daytimeSharePct != null && !(b.daytimeSharePct > 0 && b.daytimeSharePct <= 100)) {
    errors.push("Daytime share must be between 1 and 100%, or left blank.");
  }
  return errors;
}
function buildReport(b, cfg, price) {
  const errors = validate(b);
  const empty = () => ({
    ok: false,
    errors,
    inputs: b,
    rate: { inrPerKwh: 0, excludesFixed: false, basis: "" },
    region: { id: b.regionId, label: "", unitsPerKwPerMonth: 0 },
    limits: [],
    limitedBy: "consumption",
    kwp: 0,
    kwpIfExportsCredited: null,
    year1GenerationKwh: 0,
    monthlyGenerationKwh: [],
    year1SavingInr: 0,
    capex: null,
    payback: null,
    irrMid: null,
    lifetimeNetSavingMid: null,
    co2TonnesPerYear: 0,
    trees: 0,
    points: [],
    opportunities: [],
    notes: [],
    assumptions: [],
    sources: [],
    price,
    configVersion: cfg.version,
    disclaimer: DISCLAIMER
  });
  if (errors.length) return empty();
  const notes = [];
  const sources = /* @__PURE__ */ new Set();
  const cite = (src) => {
    if (!src) return "";
    sources.add(src);
    return ` Source: ${src.split(":")[0]}.`;
  };
  const rules = cfg.states[b.state] ?? null;
  const region = findRegion(b.regionId);
  const yieldPerKwMonth = region.unitsPerKwPerMonth;
  const sqftPerKw = cfg.sqftPerKw?.value ?? DEFAULTS.sqftPerKw;
  const rate = avoidableRate(b);
  if (rate.inrPerKwh < 3 || rate.inrPerKwh > 25) {
    notes.push({ kind: "caution", text: `\u20B9${round(rate.inrPerKwh, 2)} per unit is unusual for a grid connection \u2014 check the units and the bill amount you entered.` });
  }
  if (!rate.excludesFixed) notes.push({ kind: "caution", text: rate.basis });
  const limits = [];
  const regime = rules?.meteringRegime?.value ?? null;
  const fullKw = b.monthlyKwh / yieldPerKwMonth;
  let kwpIfExportsCredited = null;
  if (regime === "net_metering") {
    limits.push({ key: "consumption", kw: fullKw, basis: `${b.monthlyKwh.toLocaleString("en-IN")} units a month \xF7 ${yieldPerKwMonth} units per kW (${region.label}). Under net metering, units exported by day are credited against units drawn later.` });
  } else if (b.daytimeSharePct != null) {
    const dayKw = b.monthlyKwh * (b.daytimeSharePct / 100) / yieldPerKwMonth;
    limits.push({ key: "daytime use", kw: dayKw, basis: `${b.daytimeSharePct}% of your units are used in daylight, as you told us. ${b.state}'s export rules are not configured here, so the plant is sized to what you use while it generates.` });
    kwpIfExportsCredited = roundKwp(fullKw);
  } else {
    limits.push({ key: "consumption", kw: fullKw, basis: `${b.monthlyKwh.toLocaleString("en-IN")} units a month \xF7 ${yieldPerKwMonth} units per kW (${region.label}).` });
    notes.push({ kind: "unchecked", text: `${b.state}'s export rules are not configured in this tool yet, so this size assumes the units you export are credited against your bill (net metering). If your DISCOM uses net billing or gross metering, a smaller plant sized to your daytime use may pay back better \u2014 we confirm it at feasibility.` });
  }
  const load = loadInKw(b, rules);
  if (load) {
    if (load.factorSource) sources.add(load.factorSource);
    const capPct = rules?.netMeteringCapPct?.value;
    if (capPct != null) {
      limits.push({ key: "DISCOM cap", kw: load.kw * capPct / 100, basis: `${capPct}% of ${load.label}.${cite(rules?.netMeteringCapPct?.source)}` });
      if (rules?.capBasis) sources.add(`Cap basis: ${rules.capBasis.value}. ${rules.capBasis.source}`);
    } else {
      limits.push({ key: "DISCOM cap", kw: load.kw, basis: `Capped at ${load.label} itself.` });
      notes.push({ kind: "unchecked", text: `Your DISCOM's own cap for rooftop solar is not configured in this tool, and it may be lower than your sanctioned load. We check it at feasibility.` });
    }
  } else {
    notes.push({ kind: "unchecked", text: "Sanctioned load or contract demand was not entered, so the DISCOM's limit was not checked." });
  }
  const nmMax = rules?.netMeteringMaxKwp?.value;
  if (regime === "net_metering" && nmMax != null) {
    limits.push({ key: "net-metering limit", kw: nmMax, basis: `Net metering is limited to ${nmMax} kWp in ${b.state}.${cite(rules?.netMeteringMaxKwp?.source)}` });
  }
  if (b.roofSqft != null && b.roofSqft > 0) {
    limits.push({ key: "roof", kw: b.roofSqft / sqftPerKw, basis: `${b.roofSqft.toLocaleString("en-IN")} sq.ft of shadow-free roof \xF7 ${sqftPerKw} sq.ft per kW.` });
  } else {
    notes.push({ kind: "unchecked", text: "Roof area was not entered, so the roof was not checked. The site survey confirms what it can hold." });
  }
  const binding = limits.reduce((a2, l) => l.kw < a2.kw ? l : a2, limits[0]);
  const kwp = roundKwp(binding.kw);
  const limitedBy = binding.key;
  if (limitedBy !== "daytime use") kwpIfExportsCredited = null;
  if (limitedBy === "net-metering limit") {
    notes.push({ kind: "policy", text: `Above ${nmMax} kWp a ${b.state} plant moves to net billing, gross metering or behind-the-meter, where exported units are valued differently. A larger plant is possible; whether it pays is a feasibility question.` });
  }
  if (rules) {
    const tod = rules.todIndustrialAboveKva?.value;
    const knownSmall = b.sanctionedLoad != null && b.sanctionedLoad > 0 && tod != null && b.sanctionedLoad <= tod;
    if (tod != null && b.category === "industrial" && !knownSmall) {
      cite(rules.todIndustrialAboveKva?.source);
      notes.push({ kind: "policy", text: `Industrial connections above ${tod} kVA in ${b.state} are on a time-of-day tariff, and solar is netted within each time block first. The useful size then depends on how much you use in the daytime blocks \u2014 confirm at feasibility.` });
    }
    const surplus = rules.yearEndSurplusPctOfFit?.value;
    if (regime === "net_metering" && surplus != null) {
      cite(rules.yearEndSurplusPctOfFit?.source);
      notes.push({ kind: "policy", text: `Units left unadjusted at the end of the settlement year are paid at ${surplus}% of the feed-in tariff. This report values only the units your site uses, so that payment is not counted in the saving.` });
    }
    const feeder = rules.feederLimitPct?.value;
    if (feeder != null) {
      cite(rules.feederLimitPct?.source);
      notes.push({ kind: "policy", text: `Total rooftop solar on one transformer or feeder may not exceed ${feeder}% of its rating, so a crowded feeder can limit any applicant. PSPCL publishes the headroom; we check it before quoting.` });
    }
  }
  if (kwp < 1) {
    return {
      ...empty(),
      ok: false,
      errors: ["At these numbers the plant would be under 1 kWp \u2014 too small for a rooftop connection. Check the units you entered."],
      rate,
      region: { id: region.id, label: region.label, unitsPerKwPerMonth: yieldPerKwMonth },
      limits,
      limitedBy,
      kwp
    };
  }
  const engineInput = {
    monthlyBill: b.monthlyKwh * rate.inrPerKwh,
    tariff: rate.inrPerKwh,
    roofArea: Number.MAX_SAFE_INTEGER,
    // the size is decided above; sizeSystem's own roof limit must not bind
    systemKw: kwp,
    shape: region.shape
  };
  const overrides = { unitsPerKwPerMonth: yieldPerKwMonth, sqftPerKw };
  const isDomestic = b.category === "domestic";
  const mid = price ? (price.low + price.high) / 2 : DEFAULTS.costPerKw;
  const mMid = buildModel({ ...engineInput, costPerKw: mid }, overrides);
  let capex = null;
  let payback = null;
  if (price && !isDomestic) {
    const mLow = buildModel({ ...engineInput, costPerKw: price.low }, overrides);
    const mHigh = buildModel({ ...engineInput, costPerKw: price.high }, overrides);
    capex = { low: kwp * price.low, mid: kwp * mid, high: kwp * price.high };
    payback = { low: mLow.paybackYears, high: mHigh.paybackYears };
  }
  if (isDomestic) {
    notes.push({ kind: "caution", text: "This is a home connection. Our price band is for factories and businesses, so no cost or payback is shown here \u2014 see /solar-for-home/ for home prices and the PM Surya Ghar subsidy." });
  }
  const points = mMid.rows.filter((r) => [1, 5, 10, 15, 20, 25].includes(r.year)).map((r) => ({ year: r.year, generationKwh: round(r.generationKwh), saving: round(r.grossSaving), cumulative: round(r.cumulative) }));
  const opportunities = [];
  const oa = cfg.openAccessMinKw?.value;
  if (load && oa != null && load.kw >= oa && !isDomestic) {
    opportunities.push({
      tag: "open_access",
      title: "Open-access solar may also be open to you",
      why: `Your ${load.label} is at or above the ${oa} kW threshold in the Green Energy Open Access Rules, 2022. State adoption varies.`,
      links: [{ href: "/open-access-solar/", label: "Open-access solar explained" }]
    });
  }
  if (b.runsDg) {
    opportunities.push({
      tag: "dg",
      title: "Your diesel generator",
      why: "You told us you run a DG. Solar can carry part of the daytime load the DG covers during outages, if the plant is designed to sync with it.",
      links: [{ href: "/dg-vs-solar-calculator/", label: "DG vs solar calculator" }]
    });
  }
  const a = mMid.assumptions;
  const pct = (n) => `${round(n * 100, 1)}%`;
  const assumptions = [
    { label: "Generation", value: `${yieldPerKwMonth} units per kW per month`, basis: `${region.label} planning band (${region.states}). ${region.note}` },
    { label: "Roof per kW", value: `${sqftPerKw} sq.ft`, basis: ASSUMPTION_NOTES.sqftPerKw },
    { label: "Module degradation", value: `${pct(a.degradationRate)} a year`, basis: ASSUMPTION_NOTES.degradationRate },
    { label: "Grid tariff rise", value: `${pct(a.tariffEscalation)} a year`, basis: ASSUMPTION_NOTES.tariffEscalation },
    { label: "Operations & maintenance", value: `${pct(a.omPctOfCapex)} of cost a year`, basis: ASSUMPTION_NOTES.omPctOfCapex },
    { label: "Inverter replacement", value: `Year ${a.inverterReplacementYear}, ${pct(a.inverterReplacementPctOfCapex)} of cost`, basis: ASSUMPTION_NOTES.inverterReplacementYear },
    { label: "Project life", value: `${a.projectLifeYears} years`, basis: ASSUMPTION_NOTES.projectLifeYears },
    { label: "Grid emission factor", value: `${a.co2PerUnit} kg CO\u2082 per unit`, basis: ASSUMPTION_NOTES.co2PerUnit }
  ];
  if (price && !isDomestic) {
    assumptions.push({
      label: "Installed cost",
      value: `\u20B9${price.low.toLocaleString("en-IN")}\u2013\u20B9${price.high.toLocaleString("en-IN")} per kW, excluding GST`,
      basis: `Approved budget band for turnkey C&I rooftop solar (price version ${price.version}). Payback is shown across the band.`
    });
  }
  return {
    ok: true,
    errors: [],
    inputs: b,
    rate: { ...rate, inrPerKwh: round(rate.inrPerKwh, 2) },
    region: { id: region.id, label: region.label, unitsPerKwPerMonth: yieldPerKwMonth },
    limits: limits.map((l) => ({ ...l, kw: round(l.kw, 1) })),
    limitedBy,
    kwp,
    kwpIfExportsCredited,
    year1GenerationKwh: round(mMid.year1Generation),
    monthlyGenerationKwh: mMid.monthlyGenerationKwh.map((v) => round(v)),
    year1SavingInr: round(mMid.year1Saving),
    capex,
    payback: payback && { low: payback.low == null ? null : round(payback.low, 1), high: payback.high == null ? null : round(payback.high, 1) },
    irrMid: isDomestic || !price ? null : mMid.irr,
    lifetimeNetSavingMid: isDomestic || !price ? null : round(mMid.lifetimeSaving - mMid.netCapex),
    co2TonnesPerYear: round(mMid.co2TonnesPerYear, 1),
    trees: treesEquivalent(mMid.co2TonnesPerYear),
    points,
    opportunities,
    notes,
    assumptions,
    sources: [...sources],
    price,
    configVersion: cfg.version,
    disclaimer: DISCLAIMER
  };
}
function leadFields(r, engineVersion) {
  const b = r.inputs;
  const out = {
    lead_source: "bill_to_proposal",
    report_path: "manual",
    state: b.state,
    discom: b.discom || "",
    connection_category: b.category,
    avg_monthly_kwh: b.monthlyKwh,
    avg_monthly_bill_inr: b.monthlyBillInr,
    fixed_demand_inr: b.fixedDemandInr ?? "",
    avoidable_rate_inr_kwh: r.rate.inrPerKwh,
    rate_excludes_fixed: r.rate.excludesFixed ? "yes" : "no",
    sanctioned_load: b.sanctionedLoad ?? "",
    sanctioned_load_unit: b.sanctionedLoad ? b.sanctionedLoadUnit ?? "kW" : "",
    roof_area_sqft: b.roofSqft ?? "",
    daytime_share_pct: b.daytimeSharePct ?? "",
    runs_dg: b.runsDg ? "yes" : "no",
    region: r.region.id,
    kwp: r.kwp,
    limited_by: r.limitedBy,
    kwp_if_exports_credited: r.kwpIfExportsCredited ?? "",
    year1_generation_kwh: r.year1GenerationKwh,
    annual_savings_inr_y1: r.year1SavingInr,
    capex_inr_low: r.capex ? Math.round(r.capex.low) : "",
    capex_inr_high: r.capex ? Math.round(r.capex.high) : "",
    payback_years_low: r.payback?.low ?? "",
    payback_years_high: r.payback?.high ?? "",
    co2_tonnes_per_year: r.co2TonnesPerYear,
    opportunity_tags: r.opportunities.map((o) => o.tag).join(","),
    price_version: r.price?.version ?? "",
    config_version: r.configVersion,
    engine_version: engineVersion
  };
  return out;
}
function summaryLine(r) {
  const inr = (n) => n >= 1e5 ? `\u20B9${round(n / 1e5, 1)} lakh` : `\u20B9${Math.round(n).toLocaleString("en-IN")}`;
  const parts = [
    `Bill report: ${r.kwp} kWp (limited by ${r.limitedBy})`,
    `${inr(r.year1SavingInr)}/yr saving`,
    r.payback && r.payback.low != null ? `payback ${r.payback.low}\u2013${r.payback.high ?? "25+"} yrs` : "",
    `${r.inputs.state}${r.inputs.discom ? "/" + r.inputs.discom : ""}`,
    `${r.inputs.monthlyKwh.toLocaleString("en-IN")} kWh/mo`,
    r.opportunities.length ? `tags: ${r.opportunities.map((o) => o.tag).join(", ")}` : ""
  ];
  return parts.filter(Boolean).join(" \xB7 ");
}

// src/lib/energy-desk/regions.ts
var STATE_REGION = {
  "Punjab": "north",
  "Haryana": "north",
  "Delhi NCR": "north",
  "Uttar Pradesh": "north",
  "Uttarakhand": "north",
  "Himachal Pradesh": "north",
  "Chandigarh": "north",
  "Rajasthan": "west",
  "Gujarat": "west",
  "Madhya Pradesh": "central",
  "Chhattisgarh": "central",
  "Karnataka": "south",
  "Tamil Nadu": "south",
  "Telangana": "south",
  "Andhra Pradesh": "south",
  "Kerala": "south",
  "West Bengal": "east",
  "Bihar": "east",
  "Jharkhand": "east",
  "Odisha": "east",
  "Assam": "northeast",
  "Maharashtra": null,
  "Goa": null,
  "Other state / UT": null
};
function regionForState(state) {
  return STATE_REGION[state] ?? null;
}

// src/lib/energy-desk/version.ts
var ENGINE_VERSION = "1.0.0";
var ENGINE_SOURCES = [
  "src/lib/solar/assumptions.ts",
  "src/lib/solar/finance.ts",
  "src/lib/solar/model.ts",
  "src/lib/energy-desk/config.ts",
  "src/lib/energy-desk/regions.ts",
  "src/lib/energy-desk/report.ts"
];
var ENGINE_SOURCE_SHA256 = "8ae44bc33c8f07e5ef5a8b21dde0753286332f9cce35c0aeb88cc1315243b358";
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DISCLAIMER,
  ENGINE_SOURCES,
  ENGINE_SOURCE_SHA256,
  ENGINE_VERSION,
  REGIONS,
  STATE_REGION,
  avoidableRate,
  buildReport,
  isOwnerPlaceholder,
  leadFields,
  regionForState,
  resolveConfig,
  roundKwp,
  summaryLine,
  validate
});
