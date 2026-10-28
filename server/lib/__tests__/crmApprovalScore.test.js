const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('CRM approval in Indent to Dispatch scores as done and not pending', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const scoring = require('../../routes/scoring');
  const { invalidateAll } = require('../readCache');
  const { raciUserWeekBreakdown, raciUserWeek, MODULE_DEFS } = require('../../utils/raciModules');
  t.after(() => { invalidateAll(); db.close(); });

  const CRM_USER_ID = 9005;
  // Create CRM user
  db.prepare(`INSERT INTO users (id,name,email,username,password,role,active) VALUES (?,?,?,?,?,?,1)`)
    .run(CRM_USER_ID, 'CRM Evaluator', 'crm@example.invalid', 'crm_user', 'pass', 'user');

  // Insert setting for CRM approvers
  db.prepare(`INSERT INTO indent_to_dispatch_setting_users(key,user_id) VALUES('approval.crm.users',?)`)
    .run(CRM_USER_ID);

  // Template with CRM approval KPI
  db.exec(`
    INSERT INTO score_templates(id,name) VALUES(9401,'CRM Template');
    INSERT INTO score_user_template(user_id,template_id) VALUES(${CRM_USER_ID},9401);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source) VALUES
      (9401,9401,'Weekly','CRM Approval',100,'higher_better','auto:raci_step:indent_to_dispatch:crm');
  `);

  // Indent 1: Requires CRM approval (crm_two_level), CRM approved on 2026-10-06.
  // L1, L2, Approved are still NULL (waiting for other people's approval).
  db.prepare(`INSERT INTO indents(id,indent_number,created_at,created_by,status,approval_policy,crm_status,crm_by,crm_at,l1_at,approved_at)
    VALUES(9401,'IND-CRM-1','2026-10-06 10:00:00',9001,'submitted','crm_two_level','approved',?, '2026-10-06 12:00:00', NULL, NULL)`
  ).run(CRM_USER_ID);

  // Indent 2: Standard indent (not requiring CRM, crm_status='n/a').
  db.prepare(`INSERT INTO indents(id,indent_number,created_at,created_by,status,approval_policy,crm_status,crm_by,crm_at,l1_at,approved_at)
    VALUES(9402,'IND-STD-2','2026-10-06 11:00:00',9001,'submitted','standard','n/a',NULL, NULL, NULL, NULL)`
  ).run();

  // Indent 3: Requires CRM approval, but still pending CRM approval
  db.prepare(`INSERT INTO indents(id,indent_number,created_at,created_by,status,approval_policy,crm_status,crm_by,crm_at,l1_at,approved_at)
    VALUES(9403,'IND-CRM-3','2026-10-06 13:00:00',9001,'submitted','crm_two_level','pending',NULL, NULL, NULL, NULL)`
  ).run();

  invalidateAll();

  // Test raciUserWeek for the CRM user in the week of 2026-10-05
  const weekTotals = raciUserWeek(db, CRM_USER_ID, '2026-10-05', '2026-10-10');

  // Breakdown for CRM user
  const breakdown = raciUserWeekBreakdown(db, CRM_USER_ID, '2026-10-05', '2026-10-10');
  const crmStep = breakdown.find(b => b.module === 'indent_to_dispatch' && b.step_key === 'crm');

  assert.ok(crmStep, 'CRM step must exist in user breakdown');
  // Indent 1 was approved by CRM (actual = 1).
  // Indent 3 is pending CRM approval (pending = 1).
  // Indent 2 is standard so exempt (not counted in pending).
  assert.equal(crmStep.actual, 1, 'CRM approved indent must count in actual (DONE)');
  assert.equal(crmStep.pending, 1, 'Only indents waiting on CRM should be pending');
  assert.equal(crmStep.planned, 2, 'Total planned should be 2 (1 actual + 1 pending)');

  // Verify snapshot row for Indent 1 has current_key = 'l1' (flow moved forward to L1, not stuck on CRM)
  const rows = MODULE_DEFS.indent_to_dispatch.rows(db);
  const ind1 = rows.find(r => r.id === 9401);
  assert.equal(ind1.current_key, 'l1', 'In-flight step must advance to l1 once CRM has approved');

  // Verify Indent 2 has 'crm' in exempt_steps
  const ind2 = rows.find(r => r.id === 9402);
  assert.ok(ind2.exempt_steps.includes('crm'), 'Standard indent must exempt crm step');
});
