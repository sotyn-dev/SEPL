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

module.exports = { websiteOrigins, isAllowedWebsiteOrigin, websiteRefOf, parseEstimatedValue, DEFAULT_WEBSITE_ORIGINS };
