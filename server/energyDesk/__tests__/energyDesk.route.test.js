// Energy Desk routes, against the real routers, a real Express server and a
// scratch SQLite database.
//
//   node --test server/energyDesk/__tests__/energyDesk.route.test.js
//
// The config fixture is the website's own published /energy-desk/config.json
// (built by the website repo), so these tests read exactly what production
// will fetch. Nothing here touches the live database or the network: the
// config is loaded from the fixture, and ENERGY_DESK_SHEETS_URL is unset so
// the no-JS path's Sheet copy is skipped.
//
// Isolation follows routes/__tests__/websiteLead.route.test.js: the rate
// limiters live in closures created when a router is required, so each test
// gets fresh routers with the module cache busted. The database is shared.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const WORKDIR = mkdtempSync(join(tmpdir(), 'erp-energy-desk-'));
process.env.ERP_DB_PATH = join(WORKDIR, 'scratch.db');
process.env.ENERGY_DESK_ENABLED = '1';
delete process.env.ENERGY_DESK_SHEETS_URL;
delete process.env.WEBSITE_WEBHOOK_SECRET;

const express = require('express');
const { initializeDatabase, getDb } = require('../../db/schema');
const config = require('../config');

const SITE = 'https://www.securedengineers.com';
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'config.json'), 'utf8'));
const RELOAD = ['../router', '../store', '../../routes/webhooks', '../../lib/rateLimit'].map((m) => require.resolve(m));

async function freshServer() {
  for (const m of RELOAD) delete require.cache[m];
  const app = express();
  app.use('/api/public/energy-desk', require('../router'));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/webhooks', require('../../routes/webhooks'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', origin = SITE, json, form, headers = {} } = {}) =>
    fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(origin ? { Origin: origin } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
    });
  return { call, close: () => server.close() };
}
const withServer = async (fn) => { const s = await freshServer(); try { return await fn(s); } finally { s.close(); } };

const factory = (over = {}) => ({
  state: 'Punjab', regionId: 'north', discom: 'PSPCL', category: 'industrial',
  monthlyKwh: 30000, monthlyBillInr: 300000, fixedDemandInr: 45000,
  sanctionedLoad: 400, sanctionedLoadUnit: 'kVA', roofSqft: null, daytimeSharePct: null, runsDg: false,
  ...over,
});
let n = 0;
const ref = () => `SEPL-20261005-ED${String(++n).padStart(6, '0')}`;
const reportRows = (leadRef) => getDb().prepare('SELECT * FROM ed_energy_reports WHERE lead_ref = ?').all(leadRef);

before(() => {
  initializeDatabase();
  require('../../routes/influencers'); // creates the table sales_funnel's FK needs (see websiteLead.route.test.js)
  config.loadForTests(FIXTURE);
});
after(() => rmSync(WORKDIR, { recursive: true, force: true }));

// ── health and the switch ─────────────────────────────────────────────────
test('health reports enabled, the engine and the config version', () => withServer(async ({ call }) => {
  const res = await call('/api/public/energy-desk/health');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.enabled, true);
  assert.equal(j.engine_version, '1.0.0');
  assert.equal(j.config_version, FIXTURE.version);
  assert.equal(j.price_version, FIXTURE.capex.price.version);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
}));

test('switched off: health says so, and the write routes refuse', () => withServer(async ({ call }) => {
  process.env.ENERGY_DESK_ENABLED = '';
  try {
    assert.equal((await (await call('/api/public/energy-desk/health')).json()).enabled, false);
    assert.equal((await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: ref(), inputs: factory() } })).status, 503);
    assert.equal((await call('/api/public/energy-desk/fallback', { method: 'POST', form: { name: 'A', phone: '9876543210', consent: 'yes' } })).status, 503);
  } finally {
    process.env.ENERGY_DESK_ENABLED = '1';
  }
}));

test('CORS: the website origin gets headers, a look-alike does not', () => withServer(async ({ call }) => {
  const ok = await call('/api/public/energy-desk/reports', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  const evil = await call('/api/public/energy-desk/reports', { method: 'OPTIONS', origin: 'https://evil-securedengineers.com', headers: { 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
}));

// ── POST /reports ─────────────────────────────────────────────────────────
test('a report from another origin, or none, is refused', () => withServer(async ({ call }) => {
  assert.equal((await call('/api/public/energy-desk/reports', { method: 'POST', origin: 'https://evil.example', json: { lead_ref: ref(), inputs: factory() } })).status, 403);
  assert.equal((await call('/api/public/energy-desk/reports', { method: 'POST', origin: null, json: { lead_ref: ref(), inputs: factory() } })).status, 403);
}));

test('an oversized or malformed body is refused with its own status, not a 500', () => withServer(async ({ call }) => {
  const big = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: ref(), inputs: { pad: 'x'.repeat(40000) } } });
  assert.equal(big.status, 413);
  const bad = await call('/api/public/energy-desk/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, json: undefined });
  assert.notEqual(bad.status, 500);
}));

test('a report needs the website reference', () => withServer(async ({ call }) => {
  const res = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: 'not-a-ref', inputs: factory() } });
  assert.equal(res.status, 400);
}));

test('numbers that make no report are refused with the reasons', () => withServer(async ({ call }) => {
  const res = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: ref(), inputs: factory({ monthlyKwh: 0 }) } });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).errors.length > 0);
}));

test('a report is recomputed here and stored once per lead', () => withServer(async ({ call }) => {
  const r = ref();
  const first = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: r, inputs: factory() } });
  assert.equal(first.status, 201);
  const j = await first.json();
  assert.equal(j.kwp, 250);
  assert.equal(j.limited_by, 'consumption');
  const again = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: r, inputs: factory() } });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).report_id, j.report_id);
  const rows = reportRows(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine_version, '1.0.0');
  assert.equal(rows[0].config_version, FIXTURE.version);
  assert.equal(JSON.parse(rows[0].sizing_json).kwp, 250);
  assert.equal(JSON.parse(rows[0].finance_json).price.version, FIXTURE.capex.price.version);
}));

test('inputs are rebuilt from a fixed list: unknown keys and oversized strings do not reach the database', () => withServer(async ({ call }) => {
  const r = ref();
  const res = await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: r, inputs: { ...factory(), discom: 'X'.repeat(500), evil: '<script>' } } });
  assert.equal(res.status, 201);
  const stored = JSON.parse(reportRows(r)[0].confirmed_json);
  assert.equal(stored.discom.length, 40);
  assert.equal('evil' in stored, false);
}));

test('a report links to the website lead it belongs to', () => withServer(async ({ call }) => {
  const r = ref();
  const lead = await call('/api/webhooks/website-lead', { method: 'POST', json: { name: 'Link Test', phone: '9876543210', lead_id: r, formId: 'lead.solar.bill-report' } });
  assert.equal(lead.status, 201);
  const funnel = getDb().prepare('SELECT id FROM sales_funnel WHERE remarks LIKE ?').get(`%Website ref: ${r}%`);
  await call('/api/public/energy-desk/reports', { method: 'POST', json: { lead_ref: r, inputs: factory() } });
  assert.equal(reportRows(r)[0].funnel_id, funnel.id);
}));

// ── the website-lead webhook, taught the report's fields ──────────────────
test('a bill-report lead carries the report in its remarks, its value and its full payload', () => withServer(async ({ call }) => {
  const r = ref();
  const engine = config.engine;
  const report = engine.buildReport(factory(), config.getConfig().resolved, config.getConfig().price);
  const body = {
    name: 'Report Lead', phone: '9876543210', company: 'Test Forgings', lead_id: r,
    formId: 'lead.solar.bill-report', service: 'Solar EPC — bill report',
    ...engine.leadFields(report, engine.ENGINE_VERSION), message: engine.summaryLine(report),
    secret: 'must-not-be-stored',
  };
  const res = await call('/api/webhooks/website-lead', { method: 'POST', json: body });
  assert.equal(res.status, 201);
  const row = getDb().prepare('SELECT id, remarks, estimated_value FROM sales_funnel WHERE remarks LIKE ?').get(`%Website ref: ${r}%`);
  assert.match(row.remarks, /\[Website Enquiry: Solar savings report/);
  assert.match(row.remarks, /\[Energy Desk: solar savings report\]/);
  assert.match(row.remarks, /• Plant: 250 kWp, limited by consumption/);
  assert.match(row.remarks, /capex ₹60,00,000–₹80,00,000 excl\. GST/);
  assert.equal(row.estimated_value, 6000000, 'the floor of the capex band');
  const meta = getDb().prepare('SELECT * FROM website_lead_meta WHERE funnel_id = ?').get(row.id);
  assert.equal(meta.lead_source, 'bill_to_proposal');
  assert.equal(meta.lead_ref, r);
  const payload = JSON.parse(meta.payload_json);
  assert.equal(payload.kwp, 250);
  assert.equal('secret' in payload, false, 'a credential-bearing field is never stored');
}));

test('an ordinary website lead is unchanged by all this', () => withServer(async ({ call }) => {
  const r = ref();
  const res = await call('/api/webhooks/website-lead', { method: 'POST', json: { name: 'Plain Lead', phone: '9876543210', lead_id: r, service: 'Fire Fighting' } });
  assert.equal(res.status, 201);
  const row = getDb().prepare('SELECT remarks FROM sales_funnel WHERE remarks LIKE ?').get(`%Website ref: ${r}%`);
  assert.match(row.remarks, /\[Website Enquiry: Request a Free Quote\]/);
  assert.doesNotMatch(row.remarks, /Energy Desk/);
}));

// ── POST /fallback — no JavaScript ────────────────────────────────────────
const nojs = (over = {}) => ({
  form_id: 'lead.solar.bill-report.nojs', name: 'No Script', phone: '9876543210', email: '', company: 'Plain Form Ltd',
  state: 'Punjab', avg_monthly_kwh: '30,000', avg_monthly_bill_inr: '3,00,000', sanctioned_load: '400 kVA', consent: 'yes', ...over,
});

test('no-JS: the lead is recorded with a report computed here, and the visitor goes to /thank-you/', () => withServer(async ({ call }) => {
  const res = await call('/api/public/energy-desk/fallback', { method: 'POST', form: nojs() });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.match(loc, /^https:\/\/www\.securedengineers\.com\/thank-you\/\?ref=SEPL\d+$/);
  const leadNo = decodeURIComponent(loc.split('ref=')[1]);
  const row = getDb().prepare('SELECT remarks FROM sales_funnel WHERE lead_no = ?').get(leadNo);
  assert.match(row.remarks, /\[Energy Desk: solar savings report\]/);
  assert.match(row.remarks, /Plant: \d+ kWp/);
  const leadRef = row.remarks.match(/Website ref: (SEPL-\d{8}-[A-F0-9]{8})/)[1];
  assert.equal(reportRows(leadRef).length, 1, 'the computed report is stored too');
}));

test('no-JS: the honeypot gets a thank-you and no lead', () => withServer(async ({ call }) => {
  const before = getDb().prepare('SELECT COUNT(*) c FROM sales_funnel').get().c;
  const res = await call('/api/public/energy-desk/fallback', { method: 'POST', form: nojs({ b_validate: 'http://spam.example' }) });
  assert.equal(res.status, 303);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM sales_funnel').get().c, before);
}));

test('no-JS: missing consent or phone is sent back with a message, and a foreign origin is refused', () => withServer(async ({ call }) => {
  assert.equal((await call('/api/public/energy-desk/fallback', { method: 'POST', form: nojs({ consent: '' }) })).status, 400);
  assert.equal((await call('/api/public/energy-desk/fallback', { method: 'POST', form: nojs({ phone: '' }) })).status, 400);
  assert.equal((await call('/api/public/energy-desk/fallback', { method: 'POST', origin: 'https://evil.example', form: nojs() })).status, 403);
}));

test('no-JS: numbers that make no report still make a lead, with what was typed', () => withServer(async ({ call }) => {
  const res = await call('/api/public/energy-desk/fallback', { method: 'POST', form: nojs({ state: 'Maharashtra', avg_monthly_kwh: 'about 5000' }) });
  assert.equal(res.status, 303);
  const leadNo = decodeURIComponent(res.headers.get('location').split('ref=')[1]);
  const row = getDb().prepare('SELECT remarks FROM sales_funnel WHERE lead_no = ?').get(leadNo);
  assert.match(row.remarks, /without JavaScript/);
}));

// ── config ────────────────────────────────────────────────────────────────
test('config: a malformed copy is rejected and the last good one kept', () => {
  const good = config.getConfig().version;
  assert.throws(() => config.loadForTests({ version: 'nope' }), /config rejected/);
  assert.throws(() => config.loadForTests({ ...FIXTURE, capex: { price: { low: 0 } } }), /capex\.price/);
  config.loadForTests(FIXTURE);
  assert.equal(config.getConfig().version, good);
});

test('config: a price past its review date is not quoted', () => {
  const expired = JSON.parse(JSON.stringify(FIXTURE));
  expired.capex.price.reviewBy = '2020-01-01';
  try {
    assert.equal(config.loadForTests(expired).price, null);
  } finally {
    config.loadForTests(FIXTURE);
  }
});
