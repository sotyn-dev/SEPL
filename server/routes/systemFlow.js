// SYSTEM FLOW & ERP IMPLEMENTATION CONTROL (mam 2026-09-01)
// Manages the ERP build itself: what system step → who → when → status →
// why delayed → what is blocking → how many steps affected → who must solve.
//
// Everything derived (overdue, waiting, downstream impact, severity,
// bottleneck rank, escalation level) is COMPUTED here at read time from
// status + dates + the dependency chain — users never mark a bottleneck
// by hand, and there is no cron to drift out of sync.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('../lib/istDate');

router.use(authMiddleware);

const MODULE = 'system_flow';
const STATUSES = ['not_started','in_progress','testing','waiting','blocked','completed','cancelled'];
const OPEN = (s) => s !== 'completed' && s !== 'cancelled';

const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

function escThresholds(db) {
  const get = (k, dflt) => {
    const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k);
    const n = parseInt(r?.value, 10);
    return Number.isFinite(n) ? n : dflt;
  };
  return { l1: get('sysflow_esc_l1_days', 1), l2: get('sysflow_esc_l2_days', 3), l3: get('sysflow_esc_l3_days', 7) };
}

// ── The engine: load all flows, enrich with derived fields ─────────────
function loadEnriched(db) {
  const rows = db.prepare(`
    SELECT f.*,
      p.name  AS process_name,
      sm.name AS step_name,
      ru.name AS responsible_name,
      du.name AS developer_name,
      dep.status  AS dep_status,
      dep.flow_no AS dep_flow_no,
      deps.name   AS dep_step_name
    FROM sysflow_flows f
    JOIN sysflow_processes p   ON p.id = f.process_id
    JOIN sysflow_step_master sm ON sm.id = f.step_id
    JOIN users ru ON ru.id = f.responsible_id
    JOIN users du ON du.id = f.developer_id
    LEFT JOIN sysflow_flows dep ON dep.id = f.depends_on_id
    LEFT JOIN sysflow_step_master deps ON deps.id = dep.step_id
    ORDER BY p.sort_order, f.system_name, f.seq, f.id
  `).all();

  const today = istToday();
  const byId = new Map(rows.map(r => [r.id, r]));
  const children = new Map(); // depends_on_id -> [child rows]
  for (const r of rows) {
    if (r.depends_on_id) {
      if (!children.has(r.depends_on_id)) children.set(r.depends_on_id, []);
      children.get(r.depends_on_id).push(r);
    }
  }

  // downstream impact = incomplete steps in the dependency subtree below me
  const downstreamCache = new Map();
  function downstream(id, seen = new Set()) {
    if (downstreamCache.has(id)) return downstreamCache.get(id);
    if (seen.has(id)) return 0; // circular guard (creation also prevents this)
    seen.add(id);
    let n = 0;
    for (const c of (children.get(id) || [])) {
      if (OPEN(c.status)) n += 1 + downstream(c.id, seen);
    }
    downstreamCache.set(id, n);
    return n;
  }

  const PRIO_W = { low: 0, medium: 1, high: 2, critical: 4 };
  for (const r of rows) {
    // RULE 1 — overdue + delay days
    r.is_overdue = OPEN(r.status) && r.target_date < today ? 1 : 0;
    r.delay_days = r.status === 'completed'
      ? Math.max(0, daysBetween(r.target_date, r.actual_completion_date || r.target_date))
      : (r.is_overdue ? daysBetween(r.target_date, today) : 0);

    // RULE 2 — blocked days
    r.blocked_days = r.status === 'blocked' && r.blocked_since
      ? Math.max(0, daysBetween(r.blocked_since.slice(0, 10), today)) : 0;

    // RULE 3 — waiting on an incomplete dependency
    const dep = r.depends_on_id ? byId.get(r.depends_on_id) : null;
    r.dep_incomplete = dep && OPEN(dep.status) ? 1 : 0;
    r.derived_waiting = r.dep_incomplete && ['not_started','waiting'].includes(r.status) ? 1 : 0;
    r.waiting_for = r.derived_waiting && dep ? dep.step_name || '' : null;

    // RULE 4 — downstream impact
    r.downstream_impact = downstream(r.id);

    // Severity — delay-banded, upgraded by downstream impact (transparent)
    const worst = Math.max(r.delay_days, r.blocked_days);
    let sev = worst > 7 ? 4 : worst >= 4 ? 3 : worst >= 2 ? 2 : worst >= 1 ? 1 : 0;
    if ((r.status === 'blocked' || r.is_overdue) && r.downstream_impact >= 3) sev = 4;
    else if ((r.status === 'blocked' || r.is_overdue) && r.downstream_impact >= 1) sev = Math.min(4, sev + 1);
    if (r.status === 'blocked' && sev === 0) sev = 1;
    r.severity = ['none','low','medium','high','critical'][sev];
    r.severity_rank = sev;

    // Transparent bottleneck score: shown with its parts, never a bare number
    r.score_parts = {
      delay: r.delay_days * 2,
      blocked: r.blocked_days * 2,
      downstream: r.downstream_impact * 3,
      priority: PRIO_W[r.priority] || 0,
    };
    r.bottleneck_score = Object.values(r.score_parts).reduce((a, b) => a + b, 0);

    // Escalation level from configured thresholds
    r.escalation_level = 0;
    if ((r.is_overdue || r.status === 'blocked') && OPEN(r.status)) {
      const t = escThresholds(db);
      r.escalation_level = worst >= t.l3 ? 3 : worst >= t.l2 ? 2 : worst >= t.l1 ? 1 : 0;
    }
  }

  // RULE 25 — primary bottleneck: a stuck step whose OWN dependency is
  // satisfied (actionable). Steps stuck only because an ancestor is stuck
  // are downstream-impacted, never the primary.
  for (const r of rows) {
    const stuck = OPEN(r.status) && (r.status === 'blocked' || r.is_overdue);
    r.is_primary_bottleneck = stuck && !r.dep_incomplete ? 1 : 0;
  }
  // stuck_ancestor: some step UP the dependency chain is blocked/overdue —
  // distinguishes "waiting because of a real bottleneck" (shown in the
  // Bottleneck Center as downstream-impacted) from normal healthy sequencing.
  for (const r of rows) {
    let cur = r.depends_on_id ? byId.get(r.depends_on_id) : null, hops = 0;
    r.stuck_ancestor = 0;
    while (cur && hops++ < 500) {
      if (OPEN(cur.status) && (cur.status === 'blocked' || cur.is_overdue)) { r.stuck_ancestor = 1; break; }
      cur = cur.depends_on_id ? byId.get(cur.depends_on_id) : null;
    }
  }
  return rows;
}

// ── Live pending count from the ACTUAL ERP module (mam 2026-09-01:
//    "actual erp steps to that we can link and know how much pending").
//    Keyed by step-master name; every query is try/catch so a missing
//    table on some deployment can never break the flow pages.
const ERP_PENDING = {
  'Indent':           { sql: "SELECT COUNT(*) c FROM indents WHERE status IN ('submitted','pending')", label: 'indents awaiting approval' },
  'Purchase Order':   { sql: "SELECT COUNT(*) c FROM vendor_pos WHERE COALESCE(status,'') NOT IN ('received','closed','cancelled','rejected')", label: 'open POs' },
  'Material Receipt': { sql: "SELECT COUNT(*) c FROM vendor_pos WHERE status='sent'", label: 'POs awaiting receipt' },
  'Purchase Bill':    { sql: "SELECT COUNT(*) c FROM tally_bills WHERE COALESCE(status,'') NOT IN ('paid','closed','rejected')", label: 'bills open' },
  'Inventory':        { sql: "SELECT COUNT(*) c FROM item_master WHERE approval_status='pending'", label: 'items awaiting approval' },
  'DPR':              { sql: "SELECT COUNT(*) c FROM dpr WHERE COALESCE(approval_status,'pending')='pending'", label: 'DPRs awaiting approval' },
  'Billing':          { sql: "SELECT COUNT(*) c FROM sales_bills WHERE COALESCE(approval_status,'pending')='pending'", label: 'bills awaiting approval' },
  'Payment':          { sql: "SELECT COUNT(*) c FROM payment_requests WHERE COALESCE(status,'pending') IN ('pending','submitted')", label: 'payment requests pending' },
  'Sales Order':      { sql: "SELECT COUNT(*) c FROM business_book WHERE COALESCE(status,'') NOT IN ('closed','completed','cancelled')", label: 'open orders' },
  'Customer Master':  { sql: 'SELECT COUNT(*) c FROM customers', label: 'customers in master' },
  'Vendor Master':    { sql: 'SELECT COUNT(*) c FROM vendors', label: 'vendors in master' },
  'User Master':      { sql: 'SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1', label: 'active users' },
  'Login & User Management': { sql: 'SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1', label: 'active users' },
  'Project Management': { sql: "SELECT COUNT(*) c FROM pms_tasks WHERE COALESCE(status,'') NOT IN ('completed','approved','cancelled')", label: 'PMS tasks open' },
  'Attendance':       { sql: 'SELECT COUNT(*) c FROM attendance WHERE date=?', args: () => [istToday()], label: 'marked today' },
  'HR':               { sql: "SELECT COUNT(*) c FROM employees WHERE COALESCE(status,'active')='active'", label: 'active employees' },
};
function erpPending(db, stepName) {
  const q = ERP_PENDING[stepName];
  if (!q) return null;
  try {
    const args = q.args ? q.args() : [];
    const r = db.prepare(q.sql).get(...args);
    return { count: r?.c ?? 0, label: q.label };
  } catch { return null; }
}

function logActivity(db, flowId, userId, action, oldV, newV, reason) {
  db.prepare(`INSERT INTO sysflow_activity (flow_id, user_id, action, old_value, new_value, reason)
              VALUES (?,?,?,?,?,?)`)
    .run(flowId, userId, action, oldV == null ? null : String(oldV), newV == null ? null : String(newV), reason || null);
}

// circular-dependency guard: walking up from depId must never reach flowId
function wouldCycle(db, flowId, depId) {
  let cur = depId, hops = 0;
  const up = db.prepare('SELECT depends_on_id FROM sysflow_flows WHERE id=?');
  while (cur != null && hops++ < 500) {
    if (cur === flowId) return true;
    cur = up.get(cur)?.depends_on_id ?? null;
  }
  return false;
}

// ── Meta (dropdown sources) ────────────────────────────────────────────
router.get('/meta', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  res.json({
    processes: db.prepare('SELECT * FROM sysflow_processes WHERE active=1 ORDER BY sort_order, name').all(),
    steps: db.prepare('SELECT * FROM sysflow_step_master WHERE active=1 ORDER BY name').all(),
    users: db.prepare("SELECT id, name FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 AND username NOT LIKE '%DISABLED%' ORDER BY name").all(),
    statuses: STATUSES,
    escalation: escThresholds(db),
  });
});

// ── System Step Master CRUD (admin/manager) ────────────────────────────
router.get('/steps', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM sysflow_flows f WHERE f.step_id=s.id) AS used_count
    FROM sysflow_step_master s ORDER BY s.active DESC, s.name`).all());
});
router.post('/steps', requirePermission(MODULE, 'edit'), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Step name required' });
  try {
    const r = getDb().prepare('INSERT INTO sysflow_step_master (name, created_by) VALUES (?,?)').run(name, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch { res.status(409).json({ error: 'Step already exists' }); }
});
router.put('/steps/:id', requirePermission(MODULE, 'edit'), (req, res) => {
  const db = getDb();
  const step = db.prepare('SELECT * FROM sysflow_step_master WHERE id=?').get(+req.params.id);
  if (!step) return res.status(404).json({ error: 'Not found' });
  const name = req.body?.name != null ? String(req.body.name).trim() : step.name;
  const active = req.body?.active != null ? (req.body.active ? 1 : 0) : step.active;
  const erpPath = req.body?.erp_path !== undefined
    ? (String(req.body.erp_path).trim() || null) : step.erp_path;
  if (!name) return res.status(400).json({ error: 'Step name required' });
  if (erpPath && !erpPath.startsWith('/')) return res.status(400).json({ error: 'ERP link must be an in-app path starting with /' });
  try {
    db.prepare('UPDATE sysflow_step_master SET name=?, active=?, erp_path=? WHERE id=?').run(name, active, erpPath, step.id);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Step name already exists' }); }
});

// ── Process master ─────────────────────────────────────────────────────
router.post('/processes', requirePermission(MODULE, 'edit'), (req, res) => {
  const name = String(req.body?.name || '').trim().toUpperCase();
  if (!name) return res.status(400).json({ error: 'Process name required' });
  try {
    const r = getDb().prepare('INSERT INTO sysflow_processes (name, sort_order, created_by) VALUES (?,?,?)')
      .run(name, +req.body?.sort_order || 99, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch { res.status(409).json({ error: 'Process already exists' }); }
});

// ── Flows: list (all filters + search) ─────────────────────────────────
router.get('/flows', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  let rows = loadEnriched(db);
  const q = req.query;
  const like = (s, needle) => String(s || '').toLowerCase().includes(needle);
  if (q.process) rows = rows.filter(r => r.process_id === +q.process);
  if (q.system) rows = rows.filter(r => like(r.system_name, String(q.system).toLowerCase()));
  if (q.step) rows = rows.filter(r => r.step_id === +q.step);
  if (q.person) rows = rows.filter(r => r.responsible_id === +q.person);
  if (q.developer) rows = rows.filter(r => r.developer_id === +q.developer);
  if (q.status) rows = rows.filter(r => r.status === q.status);
  if (q.priority) rows = rows.filter(r => r.priority === q.priority);
  if (q.overdue === '1') rows = rows.filter(r => r.is_overdue);
  if (q.blocked === '1') rows = rows.filter(r => r.status === 'blocked');
  if (q.from) rows = rows.filter(r => r.target_date >= q.from);
  if (q.to) rows = rows.filter(r => r.target_date <= q.to);
  if (q.q) {
    const n = String(q.q).toLowerCase();
    rows = rows.filter(r =>
      like(r.flow_no, n) || like(r.process_name, n) || like(r.system_name, n) ||
      like(r.step_name, n) || like(r.responsible_name, n) || like(r.developer_name, n) ||
      like(r.status, n) || like(r.remarks, n));
  }
  res.json(rows);
});

// ── Flow detail + activity + downstream list ───────────────────────────
router.get('/flows/:id', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  const rows = loadEnriched(db);
  const flow = rows.find(r => r.id === +req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  flow.next_steps = rows.filter(r => r.depends_on_id === flow.id)
    .map(r => ({ id: r.id, flow_no: r.flow_no, step_name: r.step_name, status: r.status }));
  flow.activity = db.prepare(`
    SELECT a.*, u.name AS user_name FROM sysflow_activity a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.flow_id=? ORDER BY a.id DESC`).all(flow.id);
  // Link to the ACTUAL ERP module + its live pending count
  const sm = db.prepare('SELECT erp_path FROM sysflow_step_master WHERE id=?').get(flow.step_id);
  flow.erp_path = sm?.erp_path || null;
  flow.erp_pending = erpPending(db, flow.step_name);
  res.json(flow);
});

// ── Create flow ────────────────────────────────────────────────────────
router.post('/flows', requirePermission(MODULE, 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const need = ['process_id','system_name','step_id','seq','responsible_id','developer_id','start_date','target_date'];
  for (const f of need) if (b[f] == null || b[f] === '') return res.status(400).json({ error: `${f.replace(/_/g,' ')} is required` });

  const step = db.prepare('SELECT * FROM sysflow_step_master WHERE id=?').get(+b.step_id);
  if (!step) return res.status(400).json({ error: 'Unknown system step' });
  if (!step.active) return res.status(400).json({ error: 'This system step is deactivated — pick an active one' });
  if (!db.prepare('SELECT 1 FROM sysflow_processes WHERE id=?').get(+b.process_id)) return res.status(400).json({ error: 'Unknown process' });
  if (String(b.target_date) < String(b.start_date)) return res.status(400).json({ error: 'Target date cannot be before start date' });
  for (const uf of ['responsible_id','developer_id'])
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(+b[uf])) return res.status(400).json({ error: `Unknown user for ${uf.replace('_id','')}` });
  if (b.depends_on_id && !db.prepare('SELECT 1 FROM sysflow_flows WHERE id=?').get(+b.depends_on_id))
    return res.status(400).json({ error: 'Dependency flow not found' });
  if (b.priority && !['low','medium','high','critical'].includes(b.priority)) return res.status(400).json({ error: 'Bad priority' });

  const flowNo = nextSequence(db, 'sysflow_flows', 'flow_no', 'ERP-FLOW-', { pad: 4 });
  const r = db.prepare(`
    INSERT INTO sysflow_flows (flow_no, process_id, system_name, step_id, seq, depends_on_id,
      responsible_id, developer_id, start_date, target_date, priority, remarks, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(flowNo, +b.process_id, String(b.system_name).trim(), +b.step_id, +b.seq || 1,
      b.depends_on_id ? +b.depends_on_id : null, +b.responsible_id, +b.developer_id,
      b.start_date, b.target_date, b.priority || 'medium', b.remarks || null, req.user.id, req.user.id);
  logActivity(db, r.lastInsertRowid, req.user.id, 'created', null, `${flowNo} · ${step.name}`);
  logActivity(db, r.lastInsertRowid, req.user.id, 'assigned', null,
    db.prepare('SELECT name FROM users WHERE id=?').get(+b.responsible_id)?.name || '');
  res.status(201).json({ id: r.lastInsertRowid, flow_no: flowNo });
});

// ── Edit flow (fields; status has its own endpoint) ────────────────────
router.put('/flows/:id', requirePermission(MODULE, 'edit'), (req, res) => {
  const db = getDb();
  const flow = db.prepare('SELECT * FROM sysflow_flows WHERE id=?').get(+req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  if (b.step_id && +b.step_id !== flow.step_id) {
    const step = db.prepare('SELECT * FROM sysflow_step_master WHERE id=?').get(+b.step_id);
    if (!step) return res.status(400).json({ error: 'Unknown system step' });
    // (deactivated steps stay valid on EXISTING records; only new picks blocked client-side)
  }
  const start = b.start_date || flow.start_date;
  const target = b.target_date || flow.target_date;
  if (String(target) < String(start)) return res.status(400).json({ error: 'Target date cannot be before start date' });

  if (b.depends_on_id !== undefined && b.depends_on_id !== flow.depends_on_id) {
    if (b.depends_on_id != null && b.depends_on_id !== '') {
      const depId = +b.depends_on_id;
      if (depId === flow.id) return res.status(400).json({ error: 'A step cannot depend on itself' });
      if (!db.prepare('SELECT 1 FROM sysflow_flows WHERE id=?').get(depId)) return res.status(400).json({ error: 'Dependency flow not found' });
      if (wouldCycle(db, flow.id, depId)) return res.status(400).json({ error: 'That dependency would create a circular chain' });
    }
  }

  const fields = ['process_id','system_name','step_id','seq','depends_on_id','responsible_id',
    'developer_id','start_date','target_date','priority','required_action','remarks','progress'];
  const label = { responsible_id: 'reassigned', developer_id: 'developer_changed', target_date: 'due_date_changed',
    priority: 'priority_changed', depends_on_id: 'dependency_changed' };
  const updates = [];
  const vals = [];
  for (const f of fields) {
    if (b[f] === undefined) continue;
    let v = b[f] === '' ? null : b[f];
    if (['process_id','step_id','seq','depends_on_id','responsible_id','developer_id','progress'].includes(f) && v != null) v = +v;
    if (String(v) === String(flow[f])) continue;
    updates.push(`${f}=?`); vals.push(v);
    logActivity(db, flow.id, req.user.id, label[f] || `${f}_changed`, flow[f], v, b.reason);
  }
  if (!updates.length) return res.json({ ok: true, unchanged: true });
  vals.push(req.user.id, flow.id);
  db.prepare(`UPDATE sysflow_flows SET ${updates.join(',')}, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// ── Status update — My Tasks path: owner/developer may update their OWN
//    step with only view permission; anyone else needs edit permission ──
router.put('/flows/:id/status', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  const flow = db.prepare(`
    SELECT f.*, dep.status AS dep_status FROM sysflow_flows f
    LEFT JOIN sysflow_flows dep ON dep.id = f.depends_on_id
    WHERE f.id=?`).get(+req.params.id);
  if (!flow) return res.status(404).json({ error: 'Not found' });

  const isOwn = req.user.id === flow.responsible_id || req.user.id === flow.developer_id;
  const isAdmin = req.user.role === 'admin';
  const canEdit = isAdmin || !!db.prepare(`
    SELECT 1 FROM role_permissions rp JOIN user_roles ur ON rp.role_id=ur.role_id
    WHERE ur.user_id=? AND rp.module=? AND rp.can_edit=1`).get(req.user.id, MODULE);
  if (!isOwn && !canEdit) return res.status(403).json({ error: "Not your task — you can only update steps assigned to you" });

  const b = req.body || {};
  const status = b.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'blocked' && !String(b.blocked_reason || '').trim())
    return res.status(400).json({ error: 'Blocked status requires a blocked reason' });

  // Dependency gate: cannot complete while the dependency is incomplete,
  // unless an approver overrides (logged).
  if (status === 'completed' && flow.depends_on_id && OPEN(flow.dep_status || 'not_started')) {
    const canApprove = isAdmin || !!db.prepare(`
      SELECT 1 FROM role_permissions rp JOIN user_roles ur ON rp.role_id=ur.role_id
      WHERE ur.user_id=? AND rp.module=? AND rp.can_approve=1`).get(req.user.id, MODULE);
    if (!b.override) return res.status(409).json({ error: 'Dependency step is not completed yet', need_override: true, can_override: canApprove });
    if (!canApprove) return res.status(403).json({ error: 'Only an approver can override an incomplete dependency' });
    logActivity(db, flow.id, req.user.id, 'dependency_overridden', flow.dep_status, 'completed-with-override', b.reason || b.remarks);
  }

  let completion = null;
  if (status === 'completed') {
    completion = b.actual_completion_date || istToday();
    if (String(completion) < String(flow.start_date)) return res.status(400).json({ error: 'Completion date cannot be before start date' });
  }
  const blockedSince = status === 'blocked' ? (flow.status === 'blocked' ? flow.blocked_since : new Date().toISOString()) : null;

  db.prepare(`UPDATE sysflow_flows SET status=?, blocked_reason=?, blocked_since=?,
      actual_completion_date=?, progress=?, remarks=COALESCE(?, remarks),
      required_action=COALESCE(?, required_action),
      updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, status === 'blocked' ? String(b.blocked_reason).trim() : null, blockedSince,
      completion, status === 'completed' ? 100 : (b.progress != null ? +b.progress : flow.progress),
      b.remarks || null, b.required_action || null, req.user.id, flow.id);

  const action = status === 'blocked' ? 'blocked'
    : flow.status === 'blocked' && status !== 'blocked' ? 'unblocked'
    : status === 'completed' ? 'completed'
    : flow.status === 'completed' && status !== 'completed' ? 'reopened'
    : 'status_changed';
  logActivity(db, flow.id, req.user.id, action, flow.status, status, b.blocked_reason || b.reason);
  res.json({ ok: true });
});

// ── Dashboard: KPIs + per-process chains + WHY IS THE FLOW STOPPED ────
router.get('/dashboard', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  const rows = loadEnriched(db);
  const today = istToday();
  const week = new Date(new Date(today) .getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const active = rows.filter(r => r.status !== 'cancelled');
  const completed = active.filter(r => r.status === 'completed');
  const overdue = active.filter(r => r.is_overdue);
  const kpis = {
    total: active.length,
    completed: completed.length,
    in_progress: active.filter(r => ['in_progress','testing'].includes(r.status)).length,
    blocked: active.filter(r => r.status === 'blocked').length,
    overdue: overdue.length,
    due_this_week: active.filter(r => OPEN(r.status) && r.target_date >= today && r.target_date <= week).length,
    completion_pct: active.length ? Math.round(completed.length / active.length * 1000) / 10 : 0,
    avg_delay: overdue.length ? Math.round(overdue.reduce((a, r) => a + r.delay_days, 0) / overdue.length * 10) / 10 : 0,
  };

  // Per-process chain + first blocking point ("why is the flow stopped")
  const processes = [];
  const byProc = new Map();
  for (const r of rows.filter(r => r.status !== 'cancelled')) {
    if (!byProc.has(r.process_id)) { byProc.set(r.process_id, []); }
    byProc.get(r.process_id).push(r);
  }
  for (const [pid, list] of byProc) {
    // order by dependency chain where possible, else seq
    const stopped = list.filter(r => r.is_primary_bottleneck)
      .sort((a, b) => b.bottleneck_score - a.bottleneck_score)[0] || null;
    processes.push({
      process_id: pid,
      process_name: list[0].process_name,
      steps: list.map(r => ({
        id: r.id, flow_no: r.flow_no, step_name: r.step_name, system_name: r.system_name,
        owner: r.responsible_name, status: r.status, is_overdue: r.is_overdue,
        delay_days: r.delay_days, derived_waiting: r.derived_waiting, severity: r.severity,
        is_primary_bottleneck: r.is_primary_bottleneck, seq: r.seq,
      })),
      stopped_at: stopped && {
        id: stopped.id, flow_no: stopped.flow_no, step_name: stopped.step_name,
        owner: stopped.responsible_name, reason: stopped.blocked_reason ||
          (stopped.is_overdue ? `Overdue by ${stopped.delay_days} day(s)` : ''),
        downstream_impact: stopped.downstream_impact,
        required_action: stopped.required_action ||
          (stopped.status === 'blocked' ? 'Resolve the blocker' : 'Complete the overdue step'),
        delay_days: stopped.delay_days, blocked_days: stopped.blocked_days, severity: stopped.severity,
      },
    });
  }
  res.json({ kpis, processes });
});

// ── Bottleneck Center (ranked) ─────────────────────────────────────────
router.get('/bottlenecks', requirePermission(MODULE, 'view'), (req, res) => {
  const rows = loadEnriched(getDb())
    .filter(r => OPEN(r.status) && (r.status === 'blocked' || r.is_overdue || (r.derived_waiting && r.stuck_ancestor)));
  rows.sort((a, b) =>
    (b.is_primary_bottleneck - a.is_primary_bottleneck) ||
    (b.severity_rank - a.severity_rank) ||
    (b.downstream_impact - a.downstream_impact) ||
    (b.delay_days - a.delay_days) ||
    (b.blocked_days - a.blocked_days));
  res.json(rows.map((r, i) => ({ rank: i + 1, ...r })));
});

// ── Person performance ─────────────────────────────────────────────────
router.get('/performance', requirePermission(MODULE, 'view'), (req, res) => {
  const rows = loadEnriched(getDb()).filter(r => r.status !== 'cancelled');
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.responsible_id)) by.set(r.responsible_id, { person_id: r.responsible_id, person: r.responsible_name,
      total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0, overdue: 0, delay_sum: 0, delay_n: 0, bottlenecks: 0 });
    const p = by.get(r.responsible_id);
    p.total++;
    if (r.status === 'completed') p.completed++;
    else if (['in_progress','testing'].includes(r.status)) p.in_progress++;
    else p.pending++;
    if (r.status === 'blocked') p.blocked++;
    if (r.is_overdue) { p.overdue++; p.delay_sum += r.delay_days; p.delay_n++; }
    if (r.is_primary_bottleneck) p.bottlenecks++;
  }
  const out = [...by.values()].map(p => ({
    ...p,
    completion_pct: p.total ? Math.round(p.completed / p.total * 100) : 0,
    avg_delay: p.delay_n ? Math.round(p.delay_sum / p.delay_n * 10) / 10 : 0,
  })).sort((a, b) => b.bottlenecks - a.bottlenecks || b.overdue - a.overdue || a.person.localeCompare(b.person));
  res.json(out);
});

// ── Escalations (computed from configurable thresholds) ────────────────
router.get('/escalations', requirePermission(MODULE, 'view'), (req, res) => {
  const rows = loadEnriched(getDb())
    .filter(r => r.escalation_level > 0)
    .sort((a, b) => b.escalation_level - a.escalation_level || b.bottleneck_score - a.bottleneck_score);
  const LEVELS = { 1: 'Level 1 — Owner', 2: 'Level 2 — Department/System Head', 3: 'Level 3 — Management' };
  res.json(rows.map(r => ({ ...r, escalation_label: LEVELS[r.escalation_level] })));
});

// ── Weekly management report ───────────────────────────────────────────
router.get('/weekly-report', requirePermission(MODULE, 'view'), (req, res) => {
  const rows = loadEnriched(getDb()).filter(r => r.status !== 'cancelled');
  const today = istToday();
  const weekAgo = new Date(new Date(today).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const completed = rows.filter(r => r.status === 'completed');
  const overdue = rows.filter(r => r.is_overdue);
  const bySystem = new Map();
  for (const r of overdue) {
    bySystem.set(r.system_name, (bySystem.get(r.system_name) || 0) + r.delay_days);
  }
  res.json({
    total: rows.length,
    completed_this_week: completed.filter(r => (r.actual_completion_date || '') >= weekAgo).length,
    new_this_week: rows.filter(r => (r.created_at || '').slice(0, 10) >= weekAgo).length,
    pending: rows.filter(r => OPEN(r.status)).length,
    blocked: rows.filter(r => r.status === 'blocked').length,
    overdue: overdue.length,
    completion_pct: rows.length ? Math.round(completed.length / rows.length * 1000) / 10 : 0,
    avg_delay: overdue.length ? Math.round(overdue.reduce((a, r) => a + r.delay_days, 0) / overdue.length * 10) / 10 : 0,
    top_bottlenecks: rows.filter(r => r.is_primary_bottleneck)
      .sort((a, b) => b.bottleneck_score - a.bottleneck_score).slice(0, 5),
    top_delayed_persons: (() => {
      const m = new Map();
      for (const r of overdue) m.set(r.responsible_name, (m.get(r.responsible_name) || 0) + r.delay_days);
      return [...m.entries()].map(([person, delay]) => ({ person, delay })).sort((a, b) => b.delay - a.delay).slice(0, 5);
    })(),
    systems_highest_delay: [...bySystem.entries()].map(([system, delay]) => ({ system, delay }))
      .sort((a, b) => b.delay - a.delay).slice(0, 5),
    systems_completed_this_week: [...new Set(completed.filter(r => (r.actual_completion_date || '') >= weekAgo).map(r => r.system_name))],
  });
});

module.exports = router;
