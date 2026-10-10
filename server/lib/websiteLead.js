// Pure helpers for the website-lead webhook (routes/webhooks.js).
//
// Kept here, with no database or Express in sight, so they can be tested on
// their own: server/lib/__tests__/websiteLead.test.js.

// Origins allowed to post a lead straight from a visitor's browser.
// A static site cannot hold a secret — whatever its JavaScript carries is
// readable by every visitor — so our own site is recognised by Origin, the
// way routes/publicSotynLead.js already treats the sotyn.ai forms.
const DEFAULT_WEBSITE_ORIGINS = 'https://www.securedengineers.com,https://securedengineers.com';

function websiteOrigins(env = process.env) {
  return String(env.WEBSITE_LEAD_ORIGINS || DEFAULT_WEBSITE_ORIGINS)
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

// Exact origin match, scheme included. No suffix matching: "evil-securedengineers.com"
// must never pass, and an Origin header is only ever set by a browser.
function isAllowedWebsiteOrigin(origin, env = process.env) {
  if (!origin) return false;
  return websiteOrigins(env).includes(String(origin).trim().replace(/\/$/, ''));
}

// The reference the website generated for this submission (SEPL-YYYYMMDD-XXXXXXXX).
// It is the same across the site's retries, which is what makes the insert
// idempotent, and it is the reference the visitor is shown on /thank-you/.
function websiteRefOf(body) {
  const raw = body && (body.lead_id || body.leadId || body.lead_ref || body.reference);
  const s = String(raw || '').trim();
  return /^SEPL-\d{8}-[A-Z0-9]{4,16}$/i.test(s) ? s.toUpperCase() : null;
}

// Rupees from a band label or a plain number.
//
// The website sends a band ("₹50 lakh – ₹1 crore"), so take the FIRST amount in
// the text, which is the band's floor. Scanning for "crore" before "lakh"
// regardless of position — what this did until 23 Sep 2026 — read that band as
// ₹1 crore, the ceiling, and made a ₹50 lakh enquiry look twice its size.
function parseEstimatedValue(raw) {
  if (raw === 0) return 0;
  if (!raw) return 0;
  if (typeof raw === 'number') return raw >= 0 ? Math.round(raw) : 0;
  const str = String(raw).toLowerCase().trim();
  const m = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(cr|crore|lakh|lac|l\b)/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * (/^c/.test(m[2]) ? 10000000 : 100000));
  }
  // Keep the sign while stripping currency and spacing, so "-5" stays negative
  // and is rejected below rather than becoming ₹5.
  const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
  return !isNaN(num) && num > 0 ? Math.round(num) : 0;
}

// ── Energy Desk: the solar savings report's fields ─────────────────────────
//
// /solar-savings-report/ on the website sends its report as top-level fields
// (lead_source = bill_to_proposal), because getField() reads nothing nested.
// These two helpers turn them into what Sales reads in the lead: remark lines,
// and an estimated value at the FLOOR of the capex band — the same convention
// parseEstimatedValue() uses for a band. Every value comes from the public
// internet, so each is parsed or length-capped here, never trusted as-is.

const numOrNull = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const short = (v, max = 60) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

function isEnergyDeskReport(b) {
  return Boolean(b && b.lead_source === 'bill_to_proposal');
}

function energyDeskRemarks(b) {
  if (!isEnergyDeskReport(b)) return [];
  const lines = ['[Energy Desk: solar savings report]'];
  const kwp = numOrNull(b.kwp);
  const wider = numOrNull(b.kwp_if_exports_credited);
  if (kwp !== null) {
    lines.push(`• Plant: ${kwp} kWp, limited by ${short(b.limited_by, 30) || '—'}` +
      (wider !== null ? ` (up to ${wider} kWp if exports are credited)` : ''));
  }
  const kwh = numOrNull(b.avg_monthly_kwh);
  const bill = numOrNull(b.avg_monthly_bill_inr);
  const fixed = numOrNull(b.fixed_demand_inr);
  const rate = numOrNull(b.avoidable_rate_inr_kwh);
  if (kwh !== null && bill !== null) {
    lines.push(`• Bill: ${Math.round(kwh).toLocaleString('en-IN')} kWh and ${inr(bill)} a month` +
      (fixed !== null ? `, of which ${inr(fixed)} fixed/demand` : '') +
      (rate !== null ? ` · avoidable ₹${rate}/kWh${b.rate_excludes_fixed === 'no' ? ' (still includes fixed charges)' : ''}` : ''));
  }
  const load = numOrNull(b.sanctioned_load);
  lines.push(`• Connection: ${[short(b.state, 40), short(b.discom, 40)].filter(Boolean).join(' / ') || '—'}` +
    ` · ${short(b.connection_category, 20) || '—'}` +
    (load !== null ? ` · ${load} ${b.sanctioned_load_unit === 'kVA' ? 'kVA' : 'kW'}` : ''));
  const saving = numOrNull(b.annual_savings_inr_y1);
  const pLow = numOrNull(b.payback_years_low);
  const pHigh = numOrNull(b.payback_years_high);
  const cLow = numOrNull(b.capex_inr_low);
  const cHigh = numOrNull(b.capex_inr_high);
  const money = [
    saving !== null ? `year-1 saving ${inr(saving)}` : '',
    pLow !== null ? `payback ${pLow}–${pHigh !== null ? pHigh : '25+'} yrs` : '',
    cLow !== null && cHigh !== null ? `capex ${inr(cLow)}–${inr(cHigh)} excl. GST` : '',
  ].filter(Boolean);
  if (money.length) lines.push('• ' + money.join(' · '));
  const site = [
    numOrNull(b.roof_area_sqft) !== null ? `roof ${numOrNull(b.roof_area_sqft)} sq.ft` : '',
    numOrNull(b.daytime_share_pct) !== null ? `daytime use ${numOrNull(b.daytime_share_pct)}%` : '',
    b.runs_dg === 'yes' ? 'runs a DG' : '',
  ].filter(Boolean);
  if (site.length) lines.push('• Site: ' + site.join(' · '));
  if (b.opportunity_tags) lines.push(`• Also worth raising: ${short(b.opportunity_tags, 80)}`);
  lines.push(`• Versions: engine ${short(b.engine_version, 12) || '?'} · config ${short(b.config_version, 12) || '?'} · price ${short(b.price_version, 12) || '—'}`);
  return lines;
}

// The capex band's floor, in rupees — or 0 when the report carried no band
// (a home connection, or no price published).
function energyDeskEstimatedValue(b) {
  if (!isEnergyDeskReport(b)) return 0;
  const low = numOrNull(b.capex_inr_low);
  return low !== null && low > 0 ? Math.round(low) : 0;
}

module.exports = {
  websiteOrigins, isAllowedWebsiteOrigin, websiteRefOf, parseEstimatedValue, DEFAULT_WEBSITE_ORIGINS,
  isEnergyDeskReport, energyDeskRemarks, energyDeskEstimatedValue,
};
