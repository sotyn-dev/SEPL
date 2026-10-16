const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const dir = mkdtempSync(join(tmpdir(), 'erp-reporting-'));
process.env.ERP_DB_PATH = join(dir, 'scratch.db');
process.env.JWT_SECRET = 'local-test-only-not-a-production-credential';
const express = require('express');
const { initializeDatabase, getDb } = require('../../db/schema');
const { CONFIRMED_TESTS } = require('../../lib/websiteLeadReporting');
const { istToday } = require('../../lib/istDate');
let server, base, headers;

before(async () => {
  initializeDatabase();
  require('../influencers');
  const db = getDb();
  db.prepare("INSERT INTO users (name,email,password,role) VALUES ('Local reviewer','fixture@example.invalid','not-a-password','admin')").run();
  const user = db.prepare("SELECT * FROM users WHERE email='fixture@example.invalid'").get();
  headers = { Authorization: `Bearer ${require('../../middleware/auth').generateToken(user)}` };
  const insert = db.prepare(`INSERT INTO sales_funnel (lead_no, client_name, source, remarks, category,
    assigned_sc, current_stage, won_amount, closing_date, tentative_amount)
    VALUES (?, ?, ?, ?, 'MEP', 'Nancy', ?, ?, ?, ?)`);
  // A genuine testing-services company, a legacy NULL source and a near match
  // must all remain visible. Only the two exact, confirmed pairs are excluded.
  const rows = [
    ['REAL1', 'Testing Services Ltd', 'Website', '', 'contract_signed', 500, istToday(), 500],
    ['REAL2', 'Legacy', null, '', 'lead_capture', 0, null, 0],
    ['REAL3', 'Same reference, different CRM row', 'Website', `Website ref: ${CONFIRMED_TESTS[0].reference}`, 'lost', 0, null, 0],
    ...CONFIRMED_TESTS.map(t => [t.leadNo, 'Controlled enquiry', 'Website', `Website ref: ${t.reference}`, 'contract_signed', 100000, istToday(), 100000]),
  ];
  for (const row of rows) {
    const result = insert.run(...row);
    db.prepare("INSERT INTO lead_followups (lead_id,followup_date,done) VALUES (?,?,0)").run(result.lastInsertRowid, istToday());
    db.prepare("INSERT INTO lead_followups (lead_id,followup_date,done) VALUES (?,'2020-01-01',0)").run(result.lastInsertRowid);
  }
  const app = express();
  app.use('/api/sales-funnel', require('../salesfunnel'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/sales-funnel`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  getDb().close();
  rmSync(dir, { recursive: true, force: true });
});

test('dashboard consistently excludes verified tests without deleting audit records', async () => {
  const response = await fetch(`${base}/dashboard`, { headers });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.excludedTestCount, 2);
  assert.equal(report.total, 3);
  assert.equal(report.thisMonth, 3);
  assert.deepEqual(report.won, { c: 1, amount: 500 });
  assert.equal(report.lost.c, 1);
  assert.equal(report.byStage.reduce((n, s) => n + s.count, 0), 3);
  assert.equal(report.byCategory[0].count, 3);
  assert.equal(report.bySC[0].count, 3);
  assert.equal(report.recent.length, 3);
  assert.equal(report.todayFollowups, 3);
  assert.equal(report.overdueFollowups, 3);
  assert.equal(report.closingByFortnight.reduce((n, b) => n + b.amount, 0), 500);
  const all = await (await fetch(base, { headers })).json();
  assert.equal(all.length, 5, 'test records must still exist in All Leads');
  const controlled = all.find(row => row.lead_no === CONFIRMED_TESTS[0].leadNo);
  assert.equal((await fetch(`${base}/${controlled.id}`, { headers })).status, 200);
});
test('reporting still requires authentication', async () => {
  assert.equal((await fetch(`${base}/dashboard`)).status, 401);
});
