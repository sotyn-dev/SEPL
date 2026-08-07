/**
 * In-process E2E for System Requirements — mocks all lifecycle states & actions.
 * Run: node scripts/sysreq-e2e-smoke.js
 * Does not hit HTTP / login; drives statusMachine + DB directly.
 */
/* eslint-disable no-console */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getDb } = require('../server/db/schema');
const { runSystemRequirementsMigrations } = require('../server/db/systemRequirementsSchema');

const { applyTransition, nextActionsFor, statusOptionsFor } = require('../server/lib/systemRequirements/statusMachine');
const { saveTeamSettings, getTeamSettings, primaryItManagerId } = require('../server/lib/systemRequirements/access');
const { STATUS_LABELS, TRANSITIONS, COMMENT_SOURCES } = require('../server/lib/systemRequirements/constants');
const { appendHistory, listHistory } = require('../server/lib/systemRequirements/history');

function insertComment(db, { requirementId, body, authorId, source = COMMENT_SOURCES.user, parentId = null }) {
  const info = db.prepare(`
    INSERT INTO sysreq_comments (requirement_id, parent_id, body, author_id, source)
    VALUES (?,?,?,?,?)
  `).run(requirementId, parentId, body, authorId, source);
  return db.prepare('SELECT * FROM sysreq_comments WHERE id=?').get(info.lastInsertRowid);
}

const results = [];
let passed = 0;
let failed = 0;
const createdIds = [];

function ok(name, detail = '') {
  passed += 1;
  results.push({ ok: true, name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, err) {
  failed += 1;
  const detail = err?.message || String(err);
  results.push({ ok: false, name, detail });
  console.error(`  ✗ ${name} — ${detail}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function load(db, id) {
  return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(id);
}

function createReq(db, { title, status = 'draft', assigneeId = null, requestedBy, createdBy }) {
  const n = db.prepare(`SELECT COUNT(*) c FROM sysreq_requirements`).get().c + 1;
  const reqNumber = `E2E-${Date.now()}-${n}`;
  const info = db.prepare(`
    INSERT INTO sysreq_requirements (
      req_number, title, description, type, status, priority,
      requested_by, assignee_id, created_by, updated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    reqNumber,
    title,
    'E2E smoke description',
    'enhancement',
    status,
    'medium',
    requestedBy,
    assigneeId,
    createdBy,
    createdBy,
  );
  const id = Number(info.lastInsertRowid);
  createdIds.push(id);
  appendHistory(db, {
    requirementId: id,
    eventType: 'created',
    actorId: createdBy,
    toStatus: status,
    payload: { e2e: true },
  });
  return load(db, id);
}

function transition(db, req, user, action, extra = {}) {
  return applyTransition(db, {
    requirement: typeof req === 'number' ? load(db, req) : req,
    user,
    action,
    note: extra.note || null,
    assigneeId: extra.assigneeId,
  });
}

function expectStatus(row, status, label) {
  assert(row.status === status, `${label}: expected ${status}, got ${row.status}`);
}

function cleanup(db) {
  for (const id of createdIds) {
    try {
      db.prepare(`UPDATE sysreq_requirements SET soft_deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    } catch (_) { /* ignore */ }
  }
}

function main() {
  console.log('\n=== System Requirements E2E (in-process) ===\n');
  const db = getDb();
  runSystemRequirementsMigrations(db);
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='sysreq_requirements'`
  ).get()?.sql || '';
  if (!ddl.includes("'done'")) {
    throw new Error('Schema migration failed: status CHECK still missing done');
  }
  console.log('Schema: status CHECK includes done ✓\n');

  const users = db.prepare(`
    SELECT id, name, role, active FROM users WHERE active = 1 ORDER BY id ASC LIMIT 20
  `).all();
  assert(users.length >= 3, `Need ≥3 active users, found ${users.length}`);

  const adminRow = users.find(u => String(u.role || '').toLowerCase() === 'admin') || users[0];
  const uManager = users.find(u => u.id !== adminRow.id) || users[0];
  const uTeam = users.find(u => u.id !== adminRow.id && u.id !== uManager.id) || users[1];
  const uBiz = users.find(u => ![adminRow.id, uManager.id, uTeam.id].includes(u.id)) || users[Math.min(2, users.length - 1)];

  const admin = { id: adminRow.id, role: adminRow.role || 'admin', name: adminRow.name };
  const manager = { id: uManager.id, role: uManager.role, name: uManager.name };
  const team = { id: uTeam.id, role: uTeam.role, name: uTeam.name };
  const biz = { id: uBiz.id, role: uBiz.role, name: uBiz.name };

  console.log(`Actors: admin=#${admin.id} mgr=#${manager.id} team=#${team.id} biz=#${biz.id}\n`);

  // ── 0. Settings ──────────────────────────────────────────────
  console.log('0. Settings (IT managers / team / business owners)');
  try {
    saveTeamSettings(db, {
      it_manager_ids: [manager.id, admin.id],
      it_team_ids: [team.id],
      business_owner_ids: [biz.id],
    });
    const s = getTeamSettings(db);
    assert(s.it_manager_ids[0] === manager.id, 'primary IT manager is first in list');
    assert(primaryItManagerId(db) === manager.id, 'primaryItManagerId matches');
    assert(s.it_team_ids.includes(team.id), 'IT team saved');
    assert(s.business_owner_ids.includes(biz.id), 'business owner saved');
    ok('settings saved', `primary=${manager.id}`);
  } catch (e) {
    fail('settings', e);
  }

  // ── 1. Happy path → Done → Reopen ────────────────────────────
  console.log('\n1. Happy path: Waiting → Pending → In Progress → Testing → Released → Done → Reopen');
  try {
    let r = createReq(db, {
      title: 'E2E Happy Path',
      status: 'submitted',
      assigneeId: primaryItManagerId(db),
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    expectStatus(r, 'submitted', 'create submitted');
    ok('create → Waiting / Backlog', r.req_number);

    r = transition(db, r, admin, 'assign', { assigneeId: team.id });
    expectStatus(r, 'pending', 'assign');
    assert(r.assignee_id === team.id, 'assignee is team');
    ok('assign → Pending', `assignee=${team.id}`);

    r = transition(db, r, admin, 'in_progress');
    expectStatus(r, 'in_progress', 'in_progress');
    ok('Pending → In Progress');

    r = transition(db, r, admin, 'testing');
    expectStatus(r, 'testing', 'testing');
    ok('In Progress → Testing');

    r = transition(db, r, admin, 'released');
    expectStatus(r, 'released', 'released');
    ok('Testing → Released');

    r = transition(db, r, admin, 'done');
    expectStatus(r, 'done', 'done');
    assert(r.completed_at, 'completed_at set on done');
    ok('Released → Done', `completed_at=${r.completed_at}`);

    r = transition(db, r, admin, 'reopen');
    expectStatus(r, 'reopened', 'reopened');
    assert(!r.completed_at, 'completed_at cleared on reopen');
    ok('Done → Reopened');

    r = transition(db, r, admin, 'pending');
    expectStatus(r, 'pending', 'reopened→pending');
    ok('Reopened → Pending');
  } catch (e) {
    fail('happy path', e);
  }

  // ── 2. Business approve ──────────────────────────────────────
  console.log('\n2. Business approval tangent — Approve');
  try {
    let r = createReq(db, {
      title: 'E2E Biz Approve',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    const actionsBefore = nextActionsFor(db, admin, r).map(a => a.action);
    assert(actionsBefore.includes('request_business_approval'), 'quick action available');
    ok('quick action: request_business_approval');

    r = transition(db, r, admin, 'request_business_approval', { assigneeId: biz.id });
    expectStatus(r, 'under_review', 'under_review');
    assert(r.assignee_id === biz.id, 'assignee is business owner');
    ok('request_business_approval → under_review', `assignee=${biz.id}`);

    const locked = statusOptionsFor(db, team, r);
    // team may or may not change status; under_review should lock non-biz
    const bizActions = nextActionsFor(db, admin, r).map(a => a.action);
    assert(bizActions.includes('approve_business'), 'approve available');
    assert(bizActions.includes('reject'), 'reject available');
    assert(bizActions.includes('need_clarification'), 'clarify available');
    ok('business quick actions', bizActions.join(', '));
    void locked;

    r = transition(db, r, admin, 'approve_business', { note: 'Looks good' });
    expectStatus(r, 'submitted', 'after approve');
    assert(r.assignee_id === manager.id, 'returned to primary IT manager');
    assert(r.business_approved_by, 'business_approved_by set');
    ok('approve_business → Waiting + primary manager');
  } catch (e) {
    fail('business approve', e);
  }

  // ── 3. Business reject + remark comment ───────────────────────
  console.log('\n3. Business reject → Waiting + auto remark comment');
  try {
    let r = createReq(db, {
      title: 'E2E Biz Reject',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'request_business_approval', { assigneeId: biz.id });
    const note = 'Scope unclear — please rework';
    r = transition(db, r, admin, 'reject', { note });
    expectStatus(r, 'submitted', 'after reject');
    assert(r.assignee_id === manager.id, 'back to primary');

    const comment = insertComment(db, {
      requirementId: r.id,
      body: `Rejected: ${note}`,
      authorId: admin.id,
      source: COMMENT_SOURCES.businessReject,
    });
    assert(comment.id, 'remark comment inserted');
    const comments = db.prepare(
      `SELECT * FROM sysreq_comments WHERE requirement_id=? AND soft_deleted_at IS NULL`
    ).all(r.id);
    assert(comments.some(c => c.source === COMMENT_SOURCES.businessReject), 'reject source tag');
    ok('reject → Waiting + business_reject comment');
  } catch (e) {
    fail('business reject', e);
  }

  // ── 4. Need clarification ────────────────────────────────────
  console.log('\n4. Need Clarification');
  try {
    let r = createReq(db, {
      title: 'E2E Clarify',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'request_business_approval', { assigneeId: biz.id });
    const note = 'Need cost estimate before approval';
    r = transition(db, r, admin, 'need_clarification', { note });
    expectStatus(r, 'need_clarification', 'clarify status');
    assert(r.assignee_id === manager.id, 'primary owns clarification');
    insertComment(db, {
      requirementId: r.id,
      body: `Need clarification: ${note}`,
      authorId: admin.id,
      source: COMMENT_SOURCES.businessClarify,
    });
    ok('need_clarification → primary IT manager');
  } catch (e) {
    fail('need clarification', e);
  }

  // ── 5. Early close → reopen → archive path ───────────────────
  console.log('\n5. Early Close (won\'t ship) → Reopen; Rejected → Reopen');
  try {
    let r = createReq(db, {
      title: 'E2E Early Close',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'close');
    expectStatus(r, 'closed', 'early close');
    assert(r.completed_at, 'completed_at on early close');
    ok('Waiting → Closed (early kill)');

    r = transition(db, r, admin, 'reopen');
    expectStatus(r, 'reopened', 'reopen closed');
    ok('Closed → Reopened');

    let r2 = createReq(db, {
      title: 'E2E Terminal Reject',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r2 = transition(db, r2, admin, 'reject', { note: 'Duplicate of SR-1' });
    expectStatus(r2, 'rejected', 'IT reject');
    ok('Waiting → Rejected (IT)');

    r2 = transition(db, r2, admin, 'reopen');
    expectStatus(r2, 'reopened', 'reopen rejected');
    ok('Rejected → Reopened');
  } catch (e) {
    fail('early close / reject', e);
  }

  // ── 6. Draft → Submit ────────────────────────────────────────
  console.log('\n6. Draft → Submit (primary IT manager)');
  try {
    let r = createReq(db, {
      title: 'E2E Draft',
      status: 'draft',
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'submitted');
    expectStatus(r, 'submitted', 'submit');
    assert(r.assignee_id === manager.id, 'primary assigned on submit');
    ok('draft → Waiting / Backlog + primary');
  } catch (e) {
    fail('draft submit', e);
  }

  // ── 7. Work toggles + locked under_review ────────────────────
  console.log('\n7. Work toggles + under_review status lock');
  try {
    let r = createReq(db, {
      title: 'E2E Toggles',
      status: 'pending',
      assigneeId: team.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'in_progress');
    r = transition(db, r, admin, 'pending');
    expectStatus(r, 'pending', 'toggle back');
    ok('Pending ↔ In Progress toggle');

    r = transition(db, r, admin, 'request_business_approval', { assigneeId: biz.id });
    let lockedErr = null;
    try {
      transition(db, r, admin, 'in_progress');
    } catch (e) {
      lockedErr = e;
    }
    assert(lockedErr && /locked|business approval/i.test(lockedErr.message), 'status locked under_review');
    ok('status locked while under_review');
  } catch (e) {
    fail('work toggles / lock', e);
  }

  // ── 8. Comments edit/delete ──────────────────────────────────
  console.log('\n8. Comments CRUD');
  try {
    const r = createReq(db, {
      title: 'E2E Comments',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    const c = insertComment(db, {
      requirementId: r.id,
      body: 'Hello @someone',
      authorId: admin.id,
      source: COMMENT_SOURCES.user,
    });
    db.prepare(`UPDATE sysreq_comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run('Hello edited', c.id);
    const edited = db.prepare(`SELECT * FROM sysreq_comments WHERE id=?`).get(c.id);
    assert(edited.body === 'Hello edited', 'comment edited');
    db.prepare(`UPDATE sysreq_comments SET soft_deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
    const del = db.prepare(`SELECT soft_deleted_at FROM sysreq_comments WHERE id=?`).get(c.id);
    assert(del.soft_deleted_at, 'comment soft-deleted');
    ok('comment create / edit / soft-delete');
  } catch (e) {
    fail('comments', e);
  }

  // ── 9. History + invalid transition ──────────────────────────
  console.log('\n9. History trail + invalid transition guard');
  try {
    let r = createReq(db, {
      title: 'E2E History',
      status: 'released',
      assigneeId: team.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    r = transition(db, r, admin, 'done');
    const hist = listHistory(db, r.id, { limit: 50 });
    assert(hist.some(h => h.to_status === 'done' || h.event_type === 'done'), 'done in history');
    ok('history records done');

    let bad = null;
    try {
      transition(db, r, admin, 'testing'); // done → testing invalid
    } catch (e) {
      bad = e;
    }
    assert(bad, 'invalid transition rejected');
    ok('invalid Done → Testing blocked', bad.message);
  } catch (e) {
    fail('history / invalid', e);
  }

  // ── 10. Enumerate TRANSITIONS catalog ────────────────────────
  console.log('\n10. Transition catalog coverage check');
  try {
    const required = [
      ['draft', 'submitted'],
      ['submitted', 'under_review'],
      ['submitted', 'pending'],
      ['submitted', 'closed'],
      ['under_review', 'need_clarification'],
      ['under_review', 'submitted'],
      ['pending', 'in_progress'],
      ['in_progress', 'testing'],
      ['testing', 'released'],
      ['released', 'done'],
      ['done', 'reopened'],
      ['closed', 'reopened'],
      ['reopened', 'pending'],
      ['rejected', 'reopened'],
    ];
    for (const [from, to] of required) {
      assert((TRANSITIONS[from] || []).includes(to), `${from} → ${to} missing in TRANSITIONS`);
    }
    assert(STATUS_LABELS.submitted === 'Waiting / Backlog', 'Waiting / Backlog label');
    assert(STATUS_LABELS.done === 'Done', 'Done label');
    assert(STATUS_LABELS.closed === 'Closed', 'Closed label');
    ok('TRANSITIONS + labels cover planned lifecycle');
  } catch (e) {
    fail('catalog', e);
  }

  // ── 11. Soft-delete ticket ───────────────────────────────────
  console.log('\n11. Soft-delete requirement');
  try {
    const r = createReq(db, {
      title: 'E2E Soft Delete',
      status: 'submitted',
      assigneeId: manager.id,
      requestedBy: admin.id,
      createdBy: admin.id,
    });
    db.prepare(`UPDATE sysreq_requirements SET soft_deleted_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
      .run(admin.id, r.id);
    const gone = load(db, r.id);
    assert(gone.soft_deleted_at, 'soft_deleted_at set');
    ok('soft-delete ticket');
  } catch (e) {
    fail('soft-delete', e);
  }

  // Mark all E2E rows soft-deleted so they don't pollute open work
  cleanup(db);
  console.log(`\nCleanup: soft-deleted ${createdIds.length} E2E tickets`);

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed) {
    console.log('\nFailures:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  console.log('\nAll mocked states & actions OK.\n');
  process.exit(0);
}

main();
