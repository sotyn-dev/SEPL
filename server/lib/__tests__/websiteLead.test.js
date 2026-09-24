const assert = require('node:assert/strict');
const { isAllowedWebsiteOrigin, websiteRefOf, parseEstimatedValue, websiteOrigins } = require('../websiteLead');

// ── Origin: the website's own pages are admitted, nobody else ──────────────
const env = {};   // no override → the built-in securedengineers.com origins
assert.equal(isAllowedWebsiteOrigin('https://www.securedengineers.com', env), true);
assert.equal(isAllowedWebsiteOrigin('https://securedengineers.com', env), true);
assert.equal(isAllowedWebsiteOrigin('https://www.securedengineers.com/', env), true, 'trailing slash is the same origin');

// A look-alike domain must not pass on a suffix match, and nor must plain http.
assert.equal(isAllowedWebsiteOrigin('https://evil-securedengineers.com', env), false);
assert.equal(isAllowedWebsiteOrigin('https://securedengineers.com.attacker.dev', env), false);
assert.equal(isAllowedWebsiteOrigin('http://www.securedengineers.com', env), false);
// No Origin at all is not a website caller: such a request needs the secret.
for (const v of ['', null, undefined]) assert.equal(isAllowedWebsiteOrigin(v, env), false);

// Staging or a rename is a config change, not a code change.
assert.deepEqual(websiteOrigins({ WEBSITE_LEAD_ORIGINS: 'https://staging.example.com , https://www.example.com/' }),
  ['https://staging.example.com', 'https://www.example.com']);
assert.equal(isAllowedWebsiteOrigin('https://staging.example.com', { WEBSITE_LEAD_ORIGINS: 'https://staging.example.com' }), true);

// ── The website's reference, used to make a repeat idempotent ──────────────
assert.equal(websiteRefOf({ lead_id: 'SEPL-20260922-D233D5C2' }), 'SEPL-20260922-D233D5C2');
assert.equal(websiteRefOf({ leadId: 'sepl-20260922-d233d5c2' }), 'SEPL-20260922-D233D5C2', 'case is normalised');
assert.equal(websiteRefOf({ lead_id: '  SEPL-20260923-AEB15BB8  ' }), 'SEPL-20260923-AEB15BB8');
// Anything that is not our reference shape is ignored rather than trusted:
// it decides whether a lead is inserted, so a wildcard here would drop leads.
for (const bad of [{}, { lead_id: '' }, { lead_id: 'SEPL-%' }, { lead_id: "SEPL-20260922-' OR 1=1 --" },
  { lead_id: 'SEPL-2026-XY' }, { lead_id: 382 }, { lead_id: 'DROP TABLE sales_funnel' }]) {
  assert.equal(websiteRefOf(bad), null, `must reject ${JSON.stringify(bad)}`);
}

// ── Value bands are read at their floor, never their ceiling ───────────────
const L = 100000, CR = 10000000;
assert.equal(parseEstimatedValue('₹50 lakh – ₹1 crore'), 50 * L, 'the band floor, not ₹1 crore');
assert.equal(parseEstimatedValue('₹1 crore – ₹5 crore'), 1 * CR);
assert.equal(parseEstimatedValue('Above ₹5 crore'), 5 * CR);
assert.equal(parseEstimatedValue('Below ₹50 lakh'), 50 * L, 'no floor to read, so the stated cap');
assert.equal(parseEstimatedValue('Budget not finalised'), 0, 'never guess a number for an undecided budget');

// Older and free-text shapes still work.
assert.equal(parseEstimatedValue('₹5 Crore - ₹10 Crore'), 5 * CR);
assert.equal(parseEstimatedValue('2.5 cr'), 25000000);
assert.equal(parseEstimatedValue('75 lac'), 75 * L);
assert.equal(parseEstimatedValue('5000000'), 5000000);
assert.equal(parseEstimatedValue(1500000), 1500000);
for (const v of ['', null, undefined, 'not sure', -5, '-5']) assert.equal(parseEstimatedValue(v), 0);

console.log('Website lead checks passed: origin allowlist (look-alikes refused), reference shape, band floors');
