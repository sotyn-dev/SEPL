// SYSTEM FLOW — ERP Management system register (v2).
//
// Mam (2026-09-08): "change it fully, 2,3 photo is steps and 4 is create system".
// Rebuilt to her spreadsheet: a system is registered (UID, timestamp, name, type,
// category, frequency, HOD) and then runs through FOUR fixed steps, each tracking
// Planned / Actual / Time Delay plus its own extra column.
//
//   GET    /meta              → step template, users, distinct types/categories
//   GET    /                  → the register: systems + their four steps
//   GET    /stats             → the tiles
//   POST   /                  → create a system (seeds its four steps)
//   PATCH  /:id               → edit the system header
//   PATCH  /:id/steps/:no     → work one step (actual date, proof, score…)
//   DELETE /:id               → remove a system and its steps
//   GET    /:id/activity      → the audit trail
//
// TIME DELAY IS NEVER STORED. It is actual - planned, computed on read, because a
// stored copy goes stale the moment a planned date is recalculated upstream.

const express = require('express');
const { getDb } = require('../db/schema');
const { STEP_TEMPLATE } = require('../db/systemFlowSchema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();
router.use(authMiddleware);

const MODULE = 'system_flow';

// ── planned-date chain ───────────────────────────────────────────────
// Mam's answer: the number under each step is PLANNED DAYS.
//   step 1 planned = the day the system was registered + 1
//   step N planned = step N-1 ACTUAL + its days, falling back to step N-1's
//                    PLANNED while that step is still open, so the chain always
//                    shows a date and a slipped step pushes the ones behind it.
const addDays = (isoDate, days) => {
  if (!isoDate) return null;
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
};

const dayDiff = (a, b) => {
  if (!a || !b) return null;
  const x = new Date(`${String(a).slice(0, 10)}T00:00:00Z`).getTime();
  const y = new Date(`${String(b).slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.round((x - y) / 86400000);
};

// ── the score of the system ──────────────────────────────────────────
// Mam (2026-09-08): "this scoring is automtically from system" — and her sheet
// already says so: step 4's method is "Automatically". So it is CALCULATED, never
// typed, from the only thing the ERP actually knows about how the system was run:
// whether its steps landed on time.
//
//   score = 100 − (penalty per late day × late days across steps 1-3), floor 0
//
// It stays null until steps 1-3 are all done, because a score built on half the
// evidence would read as a real number and be acted on. The penalty is an
// app_setting so it can be retuned without a deploy.
const DEFAULT_PENALTY_PER_LATE_DAY = 5;

function penaltyPerLateDay(db) {
  try {
    const r = db.prepare("SELECT value FROM app_settings WHERE key='sysflow_score_penalty_per_day'").get();
    const n = r ? parseFloat(r.value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PENALTY_PER_LATE_DAY;
  } catch { return DEFAULT_PENALTY_PER_LATE_DAY; }
}

/**
 * Compute the system's score from its steps and store it on step 4.
 * Derived, but materialised: /stats averages it in SQL without loading every row,
 * and it is rewritten on every change, so it cannot drift.
 * Returns { score, late_days, complete } for the caller to explain on screen.
 */
function scoreSystem(db, systemId) {
  const steps = db.prepare(
    'SELECT step_no, planned_date, actual_date FROM sysflow_system_steps WHERE system_id=? ORDER BY step_no'
  ).all(systemId);

  const scored = steps.filter((s) => s.step_no <= 3);
  const complete = scored.length > 0 && scored.every((s) => s.actual_date);
  let lateDays = 0;
  for (const s of scored) {
    const d = dayDiff(s.actual_date, s.planned_date);
    if (d && d > 0) lateDays += d;
  }

  const score = complete
    ? Math.max(0, Math.round(100 - penaltyPerLateDay(db) * lateDays))
    : null;

  db.prepare('UPDATE sysflow_system_steps SET system_score = ? WHERE system_id = ? AND step_no = 4')
    .run(score, systemId);
  return { score, late_days: lateDays, complete };
}

/**
 * Recompute planned_date for every step of a system, in order.
 * Called after anything that can move the chain: creation, or an actual date.
 */
function recalcPlanned(db, systemId) {
  const sys = db.prepare('SELECT created_at FROM sysflow_systems WHERE id = ?').get(systemId);
  if (!sys) return;
  const steps = db.prepare(
    'SELECT id, step_no, planned_days, actual_date FROM sysflow_system_steps WHERE system_id = ? ORDER BY step_no'
  ).all(systemId);

  const upd = db.prepare('UPDATE sysflow_system_steps SET planned_date = ? WHERE id = ?');
  // The register date in IST — the sheet's Timestamp is the day the row was made.
  let base = new Date(new Date(sys.created_at + 'Z').getTime() + 330 * 60000)
    .toISOString().slice(0, 10);

  for (const s of steps) {
    const planned = addDays(base, s.planned_days);
    upd.run(planned, s.id);
    // The next step waits on what actually happened; until then, on the plan.
    base = s.actual_date ? String(s.actual_date).slice(0, 10) : planned;
  }
}

// Shape one system + its steps for the screen, with Time Delay computed.
function decorate(sys, steps) {
  const out = steps.map((s) => ({
    ...s,
    time_delay_days: dayDiff(s.actual_date, s.planned_date),
  }));
  const done = out.filter((s) => s.actual_date).length;
  const lastDelay = out.filter((s) => s.time_delay_days !== null).map((s) => s.time_delay_days);
  return {
    ...sys,
    steps: out,
    steps_done: done,
    completed: done === out.length && out.length > 0,
    // The score lives on step 4 — it is the sheet's "Score of system", calculated
    // from the lateness of steps 1-3 (see scoreSystem), never typed in.
    system_score: (out.find((s) => s.step_no === 4) || {}).system_score ?? null,
    score_late_days: out.filter((s) => s.step_no <= 3 && s.time_delay_days > 0)
      .reduce((a, s) => a + s.time_delay_days, 0),
    score_ready: out.filter((s) => s.step_no <= 3).every((s) => !!s.actual_date),
    total_delay_days: lastDelay.length ? lastDelay.reduce((a, b) => a + b, 0) : null,
  };
}

const log = (db, systemId, stepNo, userId, action, oldV, newV) => {
  try {
    db.prepare(`INSERT INTO sysflow_system_activity (system_id, step_no, user_id, action, old_value, new_value)
                VALUES (?,?,?,?,?,?)`)
      .run(systemId, stepNo, userId || null, action,
           oldV === undefined || oldV === null ? null : String(oldV).slice(0, 500),
           newV === undefined || newV === null ? null : String(newV).slice(0, 500));
  } catch (e) { console.error('[system-flow] activity log failed:', e.message); }
};

const str = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const isoDate = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

// ── GET /meta ────────────────────────────────────────────────────────
router.get('/meta', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  res.json({
    steps: STEP_TEMPLATE,
    users: db.prepare("SELECT id, name FROM users WHERE active=1 ORDER BY name").all(),
    types: db.prepare("SELECT DISTINCT type v FROM sysflow_systems WHERE type IS NOT NULL AND type<>'' ORDER BY 1").all().map((r) => r.v),
    categories: db.prepare("SELECT DISTINCT system_category v FROM sysflow_systems WHERE system_category IS NOT NULL AND system_category<>'' ORDER BY 1").all().map((r) => r.v),
    frequencies: db.prepare("SELECT DISTINCT frequency v FROM sysflow_systems WHERE frequency IS NOT NULL AND frequency<>'' ORDER BY 1").all().map((r) => r.v),
  });
});

// ── GET / — the register ─────────────────────────────────────────────
// Bounded like every other list in this ERP: a return-everything query is what
// freezes a synchronous server (hang audit 2026-08-21).
router.get('/', requirePermission(MODULE, 'view'), (req, res) => {
  const { q, status, hod_id, category } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = ['s.active = 1'];
  const params = [];
  if (q) {
    where.push('(s.system_name LIKE ? OR s.uid LIKE ? OR s.type LIKE ? OR s.system_category LIKE ? OR s.hod_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (hod_id) { where.push('s.hod_id = ?'); params.push(hod_id); }
  if (category) { where.push('s.system_category = ?'); params.push(category); }
  const clause = `WHERE ${where.join(' AND ')}`;

  const db = getDb();
  const systems = db.prepare(`
    SELECT s.id, s.uid, s.system_name, s.type, s.system_category, s.frequency,
           s.hod_id, s.hod_name, s.remarks, s.created_at, s.updated_at,
           u.name AS hod_user_name, c.name AS created_by_name
      FROM sysflow_systems s
      LEFT JOIN users u ON u.id = s.hod_id
      LEFT JOIN users c ON c.id = s.created_by
     ${clause}
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) c FROM sysflow_systems s ${clause}`).get(...params).c;

  // One query for every step on this page, not one per system (N+1).
  const ids = systems.map((s) => s.id);
  const stepsBySystem = {};
  if (ids.length) {
    const rows = db.prepare(`
      SELECT st.*, u.name AS owner_name
        FROM sysflow_system_steps st
        LEFT JOIN users u ON u.id = st.owner_id
       WHERE st.system_id IN (${ids.map(() => '?').join(',')})
       ORDER BY st.system_id, st.step_no
    `).all(...ids);
    for (const r of rows) (stepsBySystem[r.system_id] ||= []).push(r);
  }

  let rows = systems.map((s) => decorate(s, stepsBySystem[s.id] || []));
  // "status" is derived, so it filters after decoration rather than in SQL.
  if (status === 'completed') rows = rows.filter((r) => r.completed);
  else if (status === 'open') rows = rows.filter((r) => !r.completed);
  else if (status === 'delayed') rows = rows.filter((r) => r.steps.some((s) => s.time_delay_days > 0));
  else if (status === 'overdue') {
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    rows = rows.filter((r) => r.steps.some((s) => !s.actual_date && s.planned_date && s.planned_date < today));
  }

  res.json({ rows, total, limit, offset });
});

// ── GET /stats — the tiles ───────────────────────────────────────────
router.get('/stats', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;

  const total = g('SELECT COUNT(*) c FROM sysflow_systems WHERE active=1');
  const completed = g(`
    SELECT COUNT(*) c FROM sysflow_systems s WHERE s.active=1
      AND NOT EXISTS (SELECT 1 FROM sysflow_system_steps st
                       WHERE st.system_id=s.id AND st.actual_date IS NULL)
      AND EXISTS (SELECT 1 FROM sysflow_system_steps st WHERE st.system_id=s.id)`);
  const overdue = g(`
    SELECT COUNT(DISTINCT st.system_id) c FROM sysflow_system_steps st
      JOIN sysflow_systems s ON s.id=st.system_id AND s.active=1
     WHERE st.actual_date IS NULL AND st.planned_date IS NOT NULL AND st.planned_date < ?`, today);
  const dueThisWeek = g(`
    SELECT COUNT(*) c FROM sysflow_system_steps st
      JOIN sysflow_systems s ON s.id=st.system_id AND s.active=1
     WHERE st.actual_date IS NULL AND st.planned_date BETWEEN ? AND date(?, '+7 days')`, today, today);

  const delay = db.prepare(`
    SELECT AVG(julianday(actual_date) - julianday(planned_date)) d
      FROM sysflow_system_steps st JOIN sysflow_systems s ON s.id=st.system_id AND s.active=1
     WHERE st.actual_date IS NOT NULL AND st.planned_date IS NOT NULL`).get().d;
  const score = db.prepare(`
    SELECT AVG(system_score) s FROM sysflow_system_steps st
      JOIN sysflow_systems sy ON sy.id=st.system_id AND sy.active=1
     WHERE st.step_no=4 AND st.system_score IS NOT NULL`).get().s;
  const stepsDone = g('SELECT COUNT(*) c FROM sysflow_system_steps WHERE actual_date IS NOT NULL');
  const stepsAll = g('SELECT COUNT(*) c FROM sysflow_system_steps');

  res.json({
    total, completed, overdue, due_this_week: dueThisWeek,
    in_progress: total - completed,
    avg_delay_days: delay === null ? null : Math.round(delay * 10) / 10,
    avg_score: score === null ? null : Math.round(score * 10) / 10,
    steps_done: stepsDone, steps_total: stepsAll,
    completion_pct: stepsAll ? Math.round((stepsDone / stepsAll) * 1000) / 10 : 0,
  });
});

// ── POST / — register a system, seeding its four steps ───────────────
router.post('/', requirePermission(MODULE, 'create'), (req, res) => {
  const name = str(req.body.system_name, 200);
  if (!name) return res.status(400).json({ error: 'System name is required' });

  const db = getDb();
  const hodId = req.body.hod_id ? parseInt(req.body.hod_id, 10) : null;
  if (hodId && !db.prepare('SELECT 1 FROM users WHERE id=?').get(hodId)) {
    return res.status(400).json({ error: 'That HOD does not exist' });
  }

  try {
    const out = db.transaction(() => {
      const uid = nextSequence(db, 'sysflow_systems', 'uid', 'SYS-', { startFrom: 0, pad: 4 });
      const r = db.prepare(`
        INSERT INTO sysflow_systems
          (uid, system_name, type, system_category, frequency, hod_id, hod_name, remarks, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(uid, name, str(req.body.type, 120), str(req.body.system_category, 120),
             str(req.body.frequency, 120), hodId, str(req.body.hod_name, 160),
             str(req.body.remarks, 2000), req.user?.id || null);
      const id = r.lastInsertRowid;

      const ins = db.prepare(`
        INSERT INTO sysflow_system_steps
          (system_id, step_no, step_name, owner_label, method, planned_days)
        VALUES (?,?,?,?,?,?)
      `);
      for (const s of STEP_TEMPLATE) {
        ins.run(id, s.step_no, s.step_name, s.owner_label, s.method, s.planned_days);
      }
      recalcPlanned(db, id);
      scoreSystem(db, id);
      log(db, id, null, req.user?.id, 'CREATE', null, `${uid} · ${name}`);
      return { id, uid };
    })();
    res.status(201).json(out);
  } catch (e) {
    console.error('[system-flow] create failed:', e.message);
    res.status(500).json({ error: 'Could not create the system' });
  }
});

// ── PATCH /:id — the system header ───────────────────────────────────
router.patch('/:id', requirePermission(MODULE, 'edit'), (req, res) => {
  const db = getDb();
  const sys = db.prepare('SELECT * FROM sysflow_systems WHERE id=?').get(req.params.id);
  if (!sys) return res.status(404).json({ error: 'System not found' });

  const sets = [], params = [];
  const put = (col, val) => { sets.push(`${col} = ?`); params.push(val); };
  if (req.body.system_name !== undefined) {
    const n = str(req.body.system_name, 200);
    if (!n) return res.status(400).json({ error: 'System name cannot be empty' });
    put('system_name', n);
  }
  if (req.body.type !== undefined) put('type', str(req.body.type, 120));
  if (req.body.system_category !== undefined) put('system_category', str(req.body.system_category, 120));
  if (req.body.frequency !== undefined) put('frequency', str(req.body.frequency, 120));
  if (req.body.hod_name !== undefined) put('hod_name', str(req.body.hod_name, 160));
  if (req.body.remarks !== undefined) put('remarks', str(req.body.remarks, 2000));
  if (req.body.hod_id !== undefined) {
    const id = req.body.hod_id ? parseInt(req.body.hod_id, 10) : null;
    if (id && !db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) {
      return res.status(400).json({ error: 'That HOD does not exist' });
    }
    put('hod_id', id);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  params.push(req.user?.id || null);
  db.prepare(`UPDATE sysflow_systems SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  log(db, sys.id, null, req.user?.id, 'EDIT', sys.system_name, str(req.body.system_name, 200) || sys.system_name);
  res.json({ message: 'Updated' });
});

// ── PATCH /:id/steps/:no — work one step ─────────────────────────────
router.patch('/:id/steps/:no', requirePermission(MODULE, 'edit'), (req, res) => {
  const db = getDb();
  const stepNo = parseInt(req.params.no, 10);
  const step = db.prepare('SELECT * FROM sysflow_system_steps WHERE system_id=? AND step_no=?')
    .get(req.params.id, stepNo);
  if (!step) return res.status(404).json({ error: 'Step not found' });

  const sets = [], params = [];
  const put = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

  if (req.body.actual_date !== undefined) {
    const d = req.body.actual_date ? isoDate(req.body.actual_date) : null;
    if (req.body.actual_date && !d) return res.status(400).json({ error: 'Actual date must be a real date' });

    // THE STEPS ARE SEQUENTIAL. Mam (2026-09-08): "create algin is when create
    // step done, when align done after than roll out". A step cannot be completed
    // before the one in front of it, and an earlier step cannot be un-completed
    // while a later one is done — either would leave the planned-date chain
    // describing an order of work that never happened (it also produced the
    // nonsense negative delay seen in testing).
    const siblings = db.prepare(
      'SELECT step_no, step_name, actual_date FROM sysflow_system_steps WHERE system_id=? ORDER BY step_no'
    ).all(step.system_id);

    if (d) {
      const prev = siblings.find((s) => s.step_no === stepNo - 1);
      if (prev && !prev.actual_date) {
        return res.status(409).json({
          error: `Finish step ${prev.step_no} (${prev.step_name}) first — the steps run in order`,
        });
      }
    } else {
      const next = siblings.find((s) => s.step_no === stepNo + 1 && s.actual_date);
      if (next) {
        return res.status(409).json({
          error: `Step ${next.step_no} (${next.step_name}) is already done — clear that one first`,
        });
      }
    }
    put('actual_date', d);
  }
  if (req.body.owner_id !== undefined) {
    const id = req.body.owner_id ? parseInt(req.body.owner_id, 10) : null;
    if (id && !db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) {
      return res.status(400).json({ error: 'That user does not exist' });
    }
    put('owner_id', id);
  }
  if (req.body.planned_days !== undefined) {
    const n = parseInt(req.body.planned_days, 10);
    if (Number.isNaN(n) || n < 0 || n > 3650) return res.status(400).json({ error: 'Planned days must be between 0 and 3650' });
    put('planned_days', n);
  }
  if (req.body.proof_url !== undefined) put('proof_url', str(req.body.proof_url, 500));
  if (req.body.person_name !== undefined) put('person_name', str(req.body.person_name, 160));
  if (req.body.pc_name !== undefined) put('pc_name', str(req.body.pc_name, 160));
  if (req.body.remarks !== undefined) put('remarks', str(req.body.remarks, 2000));
  // The score is NOT accepted from the caller. Mam (2026-09-08): "this scoring is
  // automtically from system" — it is derived from the steps by scoreSystem(), so
  // a posted value is refused rather than silently ignored.
  if (req.body.system_score !== undefined) {
    return res.status(400).json({ error: 'The score of the system is calculated automatically — it cannot be set by hand' });
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  params.push(req.user?.id || null);

  try {
    db.transaction(() => {
      db.prepare(`UPDATE sysflow_system_steps SET ${sets.join(', ')} WHERE id = ?`).run(...params, step.id);
      // An actual date (or a changed target) moves every step behind this one.
      if (req.body.actual_date !== undefined || req.body.planned_days !== undefined) {
        recalcPlanned(db, step.system_id);
      }
      // Any change to a date changes the lateness the score is built from.
      scoreSystem(db, step.system_id);
      if (req.body.actual_date !== undefined) {
        log(db, step.system_id, stepNo, req.user?.id, 'STEP_DONE', step.actual_date, req.body.actual_date || null);
      }
    })();
    res.json({ message: 'Updated' });
  } catch (e) {
    console.error('[system-flow] step update failed:', e.message);
    res.status(500).json({ error: 'Could not update the step' });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────
router.delete('/:id', requirePermission(MODULE, 'delete'), (req, res) => {
  const db = getDb();
  const sys = db.prepare('SELECT * FROM sysflow_systems WHERE id=?').get(req.params.id);
  if (!sys) return res.status(404).json({ error: 'System not found' });
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM sysflow_system_steps WHERE system_id=?').run(sys.id);
      db.prepare('DELETE FROM sysflow_systems WHERE id=?').run(sys.id);
      log(db, sys.id, null, req.user?.id, 'DELETE', `${sys.uid} · ${sys.system_name}`, null);
    })();
    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error('[system-flow] delete failed:', e.message);
    res.status(500).json({ error: 'Could not delete the system' });
  }
});

// ── POST /bulk — register many systems from a sheet ──────────────────
//
// Mam (2026-09-08): "bulk upload". Her register is a spreadsheet, so the sheet
// itself is the input: an .xlsx or .csv with the photo-4 columns, or the same
// pasted as text. Two-step like every other importer here — commit:false reports
// what WOULD happen and writes nothing.
//
// UID and Timestamp are NOT read from the file: the ERP issues them, so a
// re-uploaded sheet can never overwrite an existing system's identity.
const BULK_MAX_ROWS = 500;

// Header -> column. Matched loosely (case, spaces and punctuation ignored) because
// a real sheet says "HOD'S NAME", "Hod Name" and "hod" in different weeks.
const BULK_HEADERS = {
  systemname: 'system_name', system: 'system_name', name: 'system_name',
  type: 'type',
  systemcategory: 'system_category', category: 'system_category',
  frequency: 'frequency', freq: 'frequency',
  hodsname: 'hod_name', hodname: 'hod_name', hod: 'hod_name',
  remarks: 'remarks', remark: 'remarks',
};
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');

router.post('/bulk', requirePermission(MODULE, 'create'), (req, res) => {
  const commit = req.body?.commit === true;
  let buf;
  try {
    if (typeof req.body?.file_b64 === 'string' && req.body.file_b64) {
      buf = Buffer.from(req.body.file_b64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'That file is larger than 8 MB' });
    } else if (typeof req.body?.text === 'string' && req.body.text.trim()) {
      buf = Buffer.from(req.body.text, 'utf8');
    } else {
      return res.status(400).json({ error: 'Choose a file, or paste the rows first' });
    }
  } catch {
    return res.status(400).json({ error: 'Could not read that file' });
  }

  let rows;
  try {
    const XLSX = require('xlsx');
    // Reads .xlsx, .xls AND .csv from the same buffer.
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return res.status(400).json({ error: 'That file has no sheet in it' });
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  } catch (e) {
    console.error('[system-flow] bulk parse failed:', e.message);
    return res.status(400).json({ error: 'Could not read that as a spreadsheet or CSV' });
  }

  // The header row is the first one that names a system column — sheets often
  // carry a title or a blank line above the real headers.
  let head = -1, map = null;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const m = {};
    (rows[r] || []).forEach((h, i) => {
      const col = BULK_HEADERS[normHeader(h)];
      if (col && m[col] === undefined) m[col] = i;
    });
    if (m.system_name !== undefined) { head = r; map = m; break; }
  }
  if (head < 0) {
    return res.status(400).json({
      error: 'No "System Name" column found. The sheet needs a header row with System Name, and optionally Type, System Category, Frequency and HOD\'s Name.',
    });
  }

  const db = getDb();
  const existing = new Set(
    db.prepare('SELECT LOWER(system_name) n FROM sysflow_systems WHERE active=1').all().map((r) => r.n)
  );
  const users = db.prepare('SELECT id, name FROM users WHERE active=1').all();
  const userByName = new Map(users.map((u) => [u.name.toLowerCase().trim(), u.id]));

  const seen = new Set();
  const parsed = [];
  for (let r = head + 1; r < rows.length; r++) {
    const raw = rows[r] || [];
    const pick = (col, max) => (map[col] === undefined ? null : str(raw[map[col]], max));
    const name = pick('system_name', 200);
    if (!name) continue;                       // blank line, or a spacer row

    const key = name.toLowerCase();
    const row = {
      system_name: name,
      type: pick('type', 120),
      system_category: pick('system_category', 120),
      frequency: pick('frequency', 120),
      hod_name: pick('hod_name', 160),
      remarks: pick('remarks', 2000),
      duplicate: existing.has(key) ? 'already registered'
        : seen.has(key) ? 'repeated in this file' : null,
    };
    // If the HOD matches an ERP user by name, link it — otherwise keep the text.
    row.hod_id = row.hod_name ? (userByName.get(row.hod_name.toLowerCase()) || null) : null;
    if (!row.duplicate) seen.add(key);
    parsed.push(row);
  }

  const importable = parsed.filter((r) => !r.duplicate);
  const summary = {
    found: parsed.length,
    importable: importable.length,
    duplicates: parsed.filter((r) => r.duplicate).length,
  };

  if (!commit) return res.json({ ...summary, committed: false, rows: parsed.slice(0, 200) });
  if (!importable.length) return res.json({ ...summary, committed: true, inserted: 0 });
  if (importable.length > BULK_MAX_ROWS) {
    return res.status(413).json({ error: `That sheet holds ${importable.length} new systems — upload at most ${BULK_MAX_ROWS} at a time` });
  }

  try {
    const insSys = db.prepare(`
      INSERT INTO sysflow_systems
        (uid, system_name, type, system_category, frequency, hod_id, hod_name, remarks, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const insStep = db.prepare(`
      INSERT INTO sysflow_system_steps
        (system_id, step_no, step_name, owner_label, method, planned_days)
      VALUES (?,?,?,?,?,?)
    `);
    const run = db.transaction((list) => {
      for (const r of list) {
        const uid = nextSequence(db, 'sysflow_systems', 'uid', 'SYS-', { startFrom: 0, pad: 4 });
        const out = insSys.run(uid, r.system_name, r.type, r.system_category, r.frequency,
                               r.hod_id, r.hod_name, r.remarks, req.user?.id || null);
        const id = out.lastInsertRowid;
        for (const s of STEP_TEMPLATE) insStep.run(id, s.step_no, s.step_name, s.owner_label, s.method, s.planned_days);
        recalcPlanned(db, id);
        scoreSystem(db, id);
        log(db, id, null, req.user?.id, 'BULK_CREATE', null, `${uid} · ${r.system_name}`);
      }
    });
    run(importable);
    console.log(`[system-flow] bulk upload by ${req.user?.name || req.user?.id}: ${importable.length} system(s)`);
    res.json({ ...summary, committed: true, inserted: importable.length });
  } catch (e) {
    console.error('[system-flow] bulk insert failed:', e.message);
    res.status(500).json({ error: 'Could not save the systems' });
  }
});

// ── GET /:id/activity ────────────────────────────────────────────────
router.get('/:id/activity', requirePermission(MODULE, 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT a.*, u.name AS user_name
      FROM sysflow_system_activity a
      LEFT JOIN users u ON u.id = a.user_id
     WHERE a.system_id = ?
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 200
  `).all(req.params.id));
});

module.exports = router;
