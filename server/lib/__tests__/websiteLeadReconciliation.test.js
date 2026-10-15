const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildPlan, digestPlan, applyPlan } = require('../../scripts/reconcileWebsiteLeadFields');

test('repair is explicit, audited, idempotent and refuses a stale reviewed plan', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE sales_funnel (id INTEGER PRIMARY KEY, lead_no TEXT, state TEXT, district TEXT, category TEXT, source TEXT, updated_at TEXT);
      CREATE TABLE website_lead_meta (funnel_id INTEGER, payload_json TEXT);
      CREATE TABLE sales_funnel_audit (lead_id INTEGER, stage TEXT, action TEXT, actor_name TEXT, notes TEXT);
      INSERT INTO sales_funnel VALUES (1,'fixture',NULL,NULL,'MEP design / BOQ / tender support','Website',NULL);
      INSERT INTO website_lead_meta VALUES (1,'{"state":"Punjab","city":"Ludhiana"}');`);
    const plan = buildPlan(db);
    assert.equal(db.prepare('SELECT state FROM sales_funnel').get().state, null, 'dry run must not mutate');
    assert.deepEqual(plan.changes[0].after, { state: 'Punjab', category: 'MEP' });
    assert.throws(() => applyPlan(db, 'wrong'), /Plan changed/);
    db.prepare("UPDATE sales_funnel SET state='Haryana'").run();
    assert.throws(() => applyPlan(db, digestPlan(plan)), /Plan changed/);
    assert.equal(applyPlan(db, digestPlan(buildPlan(db))), 1);
    assert.equal(db.prepare('SELECT state FROM sales_funnel').get().state, 'Haryana');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sales_funnel_audit').get().c, 1);
    assert.equal(buildPlan(db).changes.length, 0);
  } finally { db.close(); }
});
