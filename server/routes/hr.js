const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Candidates
router.get('/candidates', (req, res) => {
  const { status, source } = req.query;
  // Join employees so the row carries the interviewer's name. md_decision /
  // interview_decision / file fields come along with the SELECT * so the
  // pipeline UI can decide which action button to show next.
  let sql = `SELECT c.*, e.name as interviewer_name
               FROM candidates c
               LEFT JOIN employees e ON e.id = c.interviewer_id
              WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND c.status=?'; params.push(status); }
  if (source) { sql += ' AND c.source=?'; params.push(source); }
  sql += ' ORDER BY c.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.post('/candidates', (req, res) => {
  try {
    const { name, phone, email, source, position, notes, resume_file } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    // SQLite CHECK on source must match one of the allowed values, else the
    // row is rejected with a cryptic constraint error. Validate up-front so
    // HR sees a clean message ('Source must be one of...') instead of a 500.
    const allowedSources = ['facebook','naukri','linkedin','reference','other'];
    const src = source && allowedSources.includes(source) ? source : 'other';
    const r = getDb().prepare('INSERT INTO candidates (name,phone,email,source,position,notes,resume_file) VALUES (?,?,?,?,?,?,?)')
      .run(name, phone || null, email || null, src, position || null, notes || null, resume_file || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) {
    console.error('POST /hr/candidates error', err);
    res.status(500).json({ error: err.message || 'Failed to add candidate' });
  }
});

router.put('/candidates/:id', (req, res) => {
  const { name, phone, email, source, position, status, notes, resume_file } = req.body;
  getDb().prepare('UPDATE candidates SET name=?,phone=?,email=?,source=?,position=?,status=?,notes=?,resume_file=COALESCE(?,resume_file) WHERE id=?')
    .run(name, phone, email, source, position, status, notes, resume_file || null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/candidates/:id', (req, res) => {
  getDb().prepare('DELETE FROM candidates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- HIRING PIPELINE STAGE ACTIONS ----------
// mam's flow:
//  Stage 1 — Schedule first interview: HR picks interviewer (from employees) +
//            date/time + uploads resume (file URL from /upload). status moves
//            to 'interview_scheduled'.
//  Stage 2 — Mark interview done: interviewer records decision +
//            notes. status moves to 'interview_done', then 'qualified' if
//            shortlisted or 'rejected' if not.
//  Stage 3 — Schedule MD interview: HR picks date for MD round.
//            status stays 'qualified' (now means "MD round pending").
//  Stage 4 — MD decision: shortlisted → 'offer_sent' + offer_letter_file
//            uploaded; rejected → 'rejected'.
//  Stage 5 — Mark accepted / onboarded as the candidate joins.

router.post('/candidates/:id/schedule-interview', (req, res) => {
  const { interviewer_id, interview_date, resume_file, notes } = req.body;
  if (!interviewer_id) return res.status(400).json({ error: 'Pick an interviewer (employee)' });
  if (!interview_date) return res.status(400).json({ error: 'Interview date required' });
  const db = getDb();
  db.prepare(`UPDATE candidates SET
                interviewer_id = ?,
                interview_date = ?,
                resume_file    = COALESCE(?, resume_file),
                notes          = COALESCE(?, notes),
                status         = 'interview_scheduled'
              WHERE id = ?`)
    .run(+interviewer_id, interview_date, resume_file || null, notes || null, req.params.id);
  res.json({ message: 'Interview scheduled' });
});

router.post('/candidates/:id/interview-done', (req, res) => {
  const { decision, notes } = req.body;
  if (!['shortlisted','rejected','on_hold'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be shortlisted / rejected / on_hold' });
  }
  // shortlisted → 'qualified' (waiting for MD round)
  // rejected    → 'rejected'
  // on_hold     → stays 'interview_done' for HR to come back later
  const newStatus = decision === 'shortlisted' ? 'qualified'
                  : decision === 'rejected'    ? 'rejected'
                  :                              'interview_done';
  getDb().prepare(`UPDATE candidates SET
                     interview_decision = ?,
                     interview_notes    = COALESCE(?, interview_notes),
                     status             = ?
                   WHERE id = ?`)
    .run(decision, notes || null, newStatus, req.params.id);
  res.json({ message: 'Interview decision recorded' });
});

router.post('/candidates/:id/schedule-md-interview', (req, res) => {
  const { md_interview_date, notes } = req.body;
  if (!md_interview_date) return res.status(400).json({ error: 'MD interview date required' });
  // Status stays 'qualified' — md_interview_date being set marks the MD round.
  getDb().prepare(`UPDATE candidates SET
                     md_interview_date = ?,
                     notes             = COALESCE(?, notes)
                   WHERE id = ?`)
    .run(md_interview_date, notes || null, req.params.id);
  res.json({ message: 'MD interview scheduled' });
});

router.post('/candidates/:id/md-decision', (req, res) => {
  const { decision, notes, offer_letter_file,
          offered_position, offered_salary, joining_date, reporting_to } = req.body;
  if (!['shortlisted','rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be shortlisted or rejected' });
  }
  // Mam (2026-05-22): "when here shortlisted & offer send create
  // offer letter and show pdf" — no longer requires an uploaded PDF
  // upfront.  System auto-generates the offer letter from the
  // captured fields; admin can still upload a signed PDF later.
  if (decision === 'shortlisted') {
    if (!offered_position && !offer_letter_file) {
      return res.status(400).json({ error: 'Either upload an offer letter PDF, or fill the position / salary / joining date so the system can generate one' });
    }
  }
  const newStatus = decision === 'shortlisted' ? 'offer_sent' : 'rejected';
  const offerSentAt = decision === 'shortlisted' ? new Date().toISOString() : null;
  getDb().prepare(`UPDATE candidates SET
                     md_decision        = ?,
                     md_interview_notes = COALESCE(?, md_interview_notes),
                     offer_letter_file  = COALESCE(?, offer_letter_file),
                     offer_sent_at      = COALESCE(?, offer_sent_at),
                     offered_position   = COALESCE(?, offered_position),
                     offered_salary     = COALESCE(?, offered_salary),
                     joining_date       = COALESCE(?, joining_date),
                     reporting_to       = COALESCE(?, reporting_to),
                     status             = ?
                   WHERE id = ?`)
    .run(decision, notes || null, offer_letter_file || null, offerSentAt,
         offered_position || null, offered_salary != null ? +offered_salary : null,
         joining_date || null, reporting_to || null,
         newStatus, req.params.id);
  res.json({ message: decision === 'shortlisted' ? 'Offer letter ready' : 'Candidate rejected by MD' });
});

// ── GET /hr/candidates/:id ──────────────────────────────────────
// Used by the OfferLetterPrint page to render the auto-generated
// letter.  Lightweight read of all fields the template needs.
router.get('/candidates/:id', (req, res) => {
  const c = getDb().prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  res.json(c);
});

router.post('/candidates/:id/finalize', (req, res) => {
  // Mark candidate as 'accepted' (offer accepted) or 'onboarded' (joined).
  const { final_status, notes } = req.body;
  if (!['accepted','onboarded','rejected'].includes(final_status)) {
    return res.status(400).json({ error: 'final_status must be accepted / onboarded / rejected' });
  }
  getDb().prepare(`UPDATE candidates SET status = ?, notes = COALESCE(?, notes) WHERE id = ?`)
    .run(final_status, notes || null, req.params.id);
  res.json({ message: 'Status updated' });
});

router.get('/candidates/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM candidates').get();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM candidates GROUP BY status').all();
  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM candidates GROUP BY source').all();
  res.json({ total: total.count, byStatus, bySource });
});

// Employees — salary is confidential; strip it from the response unless the
// requester is an admin or on the HR team (by role name or department).
// JWT only carries { id, role, name, email }, so we look up HR role + dept
// from the DB on each request. The DPR staff-cost endpoint works independently
// via a server-side aggregate, so non-HR users never see individual figures
// even if they are site engineers.
const canSeeSalary = (userId, userRole) => {
  if (userRole === 'admin') return true;
  const db = getDb();
  const u = db.prepare('SELECT department FROM users WHERE id=?').get(userId);
  if (u?.department && String(u.department).toLowerCase().includes('hr')) return true;
  const roles = db.prepare(
    `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`
  ).all(userId);
  return roles.some(r => String(r.name || '').toLowerCase().includes('hr'));
};

router.get('/employees', (req, res) => {
  const rows = getDb().prepare(
    `SELECT e.*, u.name as linked_user_name, u.username as linked_username
     FROM employees e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.name`
  ).all();
  if (canSeeSalary(req.user.id, req.user.role)) return res.json(rows);
  // Redact salary for everyone else
  res.json(rows.map(({ salary, ...rest }) => rest));
});

router.post('/employees', (req, res) => {
  const { name, phone, email, designation, department, join_date, salary,
          aadhar_file, pan_file, qualification_file } = req.body;
  let { user_id } = req.body;
  const db = getDb();
  // Auto-link by email if user_id wasn't explicitly set
  if (!user_id && email) {
    const u = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(email);
    if (u) user_id = u.id;
  }
  // Mandatory documents for NEW employees (not enforced on bulk import or
  // legacy edits — those keep working without docs).
  if (!aadhar_file)        return res.status(400).json({ error: 'Aadhar card is required' });
  if (!pan_file)           return res.status(400).json({ error: 'PAN card is required' });
  if (!qualification_file) return res.status(400).json({ error: 'Highest qualification certificate is required' });
  const r = db.prepare(`
    INSERT INTO employees (user_id,name,phone,email,designation,department,join_date,salary,
                           aadhar_file, pan_file, qualification_file)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(user_id || null, name, phone, email, designation, department, join_date, salary,
        aadhar_file || null, pan_file || null, qualification_file || null);
  res.status(201).json({ id: r.lastInsertRowid, linked_user_id: user_id || null });
});

// Auto-link existing employees to users by matching email (case-insensitive).
// Safe to run any time — only fills rows where user_id IS NULL.
router.post('/employees/auto-link', (req, res) => {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT e.id, u.id as user_id FROM employees e
     JOIN users u ON LOWER(u.email) = LOWER(e.email)
     WHERE e.user_id IS NULL AND e.email IS NOT NULL AND e.email != ''`
  ).all();
  const upd = db.prepare('UPDATE employees SET user_id = ? WHERE id = ?');
  let linked = 0;
  for (const c of candidates) { upd.run(c.user_id, c.id); linked++; }
  res.json({ linked, scanned: candidates.length });
});

// Bulk import employees
router.post('/employees/bulk', (req, res) => {
  const { employees } = req.body;
  if (!employees || !Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: 'No employee data provided' });
  }
  const db = getDb();
  const insert = db.prepare('INSERT INTO employees (name,phone,email,designation,department,join_date,salary) VALUES (?,?,?,?,?,?,?)');
  let added = 0, errors = [];
  for (let i = 0; i < employees.length; i++) {
    const e = employees[i];
    if (!e.name || !e.name.trim()) { errors.push(`Row ${i + 1}: Name is required`); continue; }
    try {
      insert.run(e.name?.trim(), e.phone?.trim() || '', e.email?.trim() || '', e.designation?.trim() || '', e.department?.trim() || '', e.join_date || '', e.salary || 0);
      added++;
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: employees.length });
});

router.put('/employees/:id', (req, res) => {
  const { name, phone, email, designation, department, salary, status, user_id,
          aadhar_file, pan_file, qualification_file } = req.body;
  // COALESCE so passing undefined for a doc field doesn't wipe the existing
  // upload — frontend can edit other fields without re-uploading docs.
  getDb().prepare(`
    UPDATE employees
       SET name=?, phone=?, email=?, designation=?, department=?, salary=?, status=?, user_id=?,
           aadhar_file        = COALESCE(?, aadhar_file),
           pan_file           = COALESCE(?, pan_file),
           qualification_file = COALESCE(?, qualification_file)
     WHERE id=?
  `).run(name, phone, email, designation, department, salary, status, user_id || null,
        aadhar_file || null, pan_file || null, qualification_file || null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/employees/:id', (req, res) => {
  getDb().prepare('DELETE FROM employees WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Sub-Contractors
router.get('/sub-contractors', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM sub_contractors ORDER BY name').all());
});

router.post('/sub-contractors', (req, res) => {
  const { name, phone, email, specialization, rate, rate_unit, notes } = req.body;
  const r = getDb().prepare('INSERT INTO sub_contractors (name,phone,email,specialization,rate,rate_unit,notes) VALUES (?,?,?,?,?,?,?)')
    .run(name, phone, email, specialization, rate, rate_unit, notes);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/sub-contractors/:id', (req, res) => {
  const { name, phone, email, specialization, rate, rate_unit, status, notes } = req.body;
  getDb().prepare('UPDATE sub_contractors SET name=?,phone=?,email=?,specialization=?,rate=?,rate_unit=?,status=?,notes=? WHERE id=?')
    .run(name, phone, email, specialization, rate, rate_unit, status, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/sub-contractors/:id', (req, res) => {
  getDb().prepare('DELETE FROM sub_contractors WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Expenses
router.get('/expenses', (req, res) => {
  res.json(getDb().prepare(`SELECT e.*, u1.name as submitted_by_name, u2.name as approved_by_name FROM expenses e
    LEFT JOIN users u1 ON e.submitted_by=u1.id LEFT JOIN users u2 ON e.approved_by=u2.id ORDER BY e.created_at DESC`).all());
});

router.post('/expenses', (req, res) => {
  const { title, description, amount, category, expense_date } = req.body;
  const db = getDb();
  // Server-side dedup — mam: "entry one time but showing data 4 to 5
  // times". A fast double-click + flaky network was firing 2-4 POSTs
  // before the modal could close, each writing an identical row. We
  // reject any insert that exactly matches the same user's most-recent
  // submission in the last 2 minutes. Returns the existing row so the
  // client still gets a success-style response (idempotent).
  const recent = db.prepare(`
    SELECT id FROM expenses
     WHERE submitted_by = ?
       AND COALESCE(title, '') = COALESCE(?, '')
       AND COALESCE(description, '') = COALESCE(?, '')
       AND amount = ?
       AND COALESCE(category, '') = COALESCE(?, '')
       AND COALESCE(expense_date, '') = COALESCE(?, '')
       AND created_at >= datetime('now', '-2 minutes')
     ORDER BY id DESC LIMIT 1
  `).get(req.user.id, title, description, +amount || 0, category, expense_date);
  if (recent) {
    return res.status(200).json({ id: recent.id, deduped: true, message: 'Identical entry already submitted in the last 2 minutes — kept original.' });
  }
  const r = db.prepare('INSERT INTO expenses (title,description,amount,category,expense_date,submitted_by) VALUES (?,?,?,?,?,?)')
    .run(title, description, +amount || 0, category, expense_date, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/expenses/:id', (req, res) => {
  // Two flows mam uses, both go through this endpoint:
  //   (1) edit the expense details (title/description/amount/category/date)
  //   (2) change status (approve / reject / mark paid / un-mark paid)
  // Body may contain any subset; missing fields are preserved.
  const { title, description, amount, category, expense_date, status } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const next = {
    title: title !== undefined ? title : existing.title,
    description: description !== undefined ? description : existing.description,
    amount: amount !== undefined ? +amount : existing.amount,
    category: category !== undefined ? category : existing.category,
    expense_date: expense_date !== undefined ? expense_date : existing.expense_date,
    status: status !== undefined ? status : existing.status,
    approved_by: existing.approved_by,
    paid_date: existing.paid_date,
  };

  if (status !== undefined && status !== existing.status) {
    // Forward transitions stamp; reverse transitions clear so audit isn't misleading.
    if (status === 'approved') {
      next.approved_by = req.user.id;
      if (existing.status === 'paid') next.paid_date = null; // un-mark paid
    } else if (status === 'paid') {
      next.paid_date = new Date().toISOString().split('T')[0];
    } else if (status === 'pending') {
      next.approved_by = null;
      next.paid_date = null;
    } else if (status === 'rejected') {
      next.approved_by = req.user.id;
      next.paid_date = null;
    }
  }

  db.prepare(`UPDATE expenses SET title=?, description=?, amount=?, category=?, expense_date=?, status=?, approved_by=?, paid_date=? WHERE id=?`)
    .run(next.title, next.description, next.amount, next.category, next.expense_date, next.status, next.approved_by, next.paid_date, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/expenses/:id', (req, res) => {
  getDb().prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Checklists
// List checklists. Admin sees all; regular users see only the ones assigned
// to them so they don't read each other's tasks. Ordered by assignee name
// so the frontend can group the rows under each person.
router.get('/checklists', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const base = `SELECT c.*, u1.name as assigned_to_name, u2.name as created_by_name
    FROM checklists c
    LEFT JOIN users u1 ON c.assigned_to=u1.id
    LEFT JOIN users u2 ON c.created_by=u2.id`;
  const order = ` ORDER BY u1.name COLLATE NOCASE, c.frequency, c.due_time, c.created_at DESC`;
  if (isAdmin) {
    res.json(db.prepare(base + order).all());
  } else {
    res.json(db.prepare(base + ' WHERE c.assigned_to=?' + order).all(req.user.id));
  }
});

// Title is derived from the first line (80 chars) of the description since
// the UI no longer asks for it separately.
const deriveTitle = (title, description) => {
  if (title && title.trim()) return title.trim();
  const d = String(description || '').trim();
  return d.split(/\r?\n/)[0].slice(0, 80).trim() || 'Checklist';
};

// Only admins can create / edit / delete checklists. Regular users can read
// and complete (upload proof for) the ones assigned to them.
const adminGuard = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can manage checklists' });
  next();
};

router.post('/checklists', adminGuard, (req, res) => {
  const { title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date } = req.body;
  const t = deriveTitle(title, description);
  const desc = String(description || '').trim();
  if (!desc && !title) return res.status(400).json({ error: 'Description is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
  // Mam (2026-05-22): if the caller didn't supply a department, fall
  // back to the assignee's own users.department so the row is
  // automatically tagged with the right team.
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = getDb().prepare('SELECT department FROM users WHERE id=?').get(assigned_to);
      dept = u?.department || null;
    } catch (_) {}
  }
  const r = getDb().prepare(
    `INSERT INTO checklists
       (title, description, frequency, due_date, due_time, assigned_to, department,
        recurrence_start_date, recurrence_end_date, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(t, desc, frequency, due_date, due_time || null, assigned_to, dept,
        recurrence_start_date || null, recurrence_end_date || null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/checklists/:id', adminGuard, (req, res) => {
  const { status, title, description, frequency, due_date, due_time, assigned_to, department,
          recurrence_start_date, recurrence_end_date } = req.body;
  const t = deriveTitle(title, description);
  if (!assigned_to) return res.status(400).json({ error: 'Assigned To is required' });
  let dept = department && String(department).trim() ? String(department).trim() : null;
  if (!dept) {
    try {
      const u = getDb().prepare('SELECT department FROM users WHERE id=?').get(assigned_to);
      dept = u?.department || null;
    } catch (_) {}
  }
  getDb().prepare(
    `UPDATE checklists SET status=?, title=?, description=?, frequency=?, due_date=?, due_time=?,
       assigned_to=?, department=?, recurrence_start_date=?, recurrence_end_date=?
     WHERE id=?`
  ).run(status, t, description, frequency, due_date, due_time || null, assigned_to, dept,
        recurrence_start_date || null, recurrence_end_date || null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/checklists/:id', adminGuard, (req, res) => {
  getDb().prepare('DELETE FROM checklists WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Today's checklists for the logged-in user — used by the dashboard widget.
// Returns active checklists that are due today based on frequency:
//   daily       → every day
//   weekly      → same weekday as the checklist's due_date
//   monthly     → same day-of-month as the checklist's due_date
//   quarterly   → once every 3 months on the due_date's day
//   yearly      → same month-and-day as the due_date
//   once        → exact due_date match
// Each entry is joined with today's completion row (if any) so the UI knows
// whether proof has been uploaded.
router.get('/checklists/my-today', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const d = new Date(today + 'T00:00:00');
  const todayDow = d.getDay();            // 0..6
  const todayDom = d.getDate();           // 1..31
  const todayMonth = d.getMonth() + 1;    // 1..12

  const uid = req.user.id;

  // Pull checklists assigned to this user OR unassigned (applies to everyone)
  const rows = db.prepare(
    `SELECT c.*, cc.id as completion_id, cc.proof_url, cc.submitted_at, cc.notes
     FROM checklists c
     LEFT JOIN checklist_completions cc
       ON cc.checklist_id = c.id AND cc.user_id = ? AND cc.completion_date = ?
     WHERE (c.assigned_to = ? OR c.assigned_to IS NULL)
       AND (c.status IS NULL OR c.status = 'pending' OR c.status = 'active' OR c.status = '')`
  ).all(uid, today, uid);

  const out = rows.filter(c => {
    const f = String(c.frequency || '').toLowerCase();
    if (!c.due_date && f !== 'daily') return f === 'daily';
    const due = c.due_date ? new Date(c.due_date + 'T00:00:00') : null;
    if (f === 'daily') return true;
    if (f === 'weekly') return due && due.getDay() === todayDow;
    if (f === 'monthly') return due && due.getDate() === todayDom;
    if (f === 'quarterly') {
      if (!due) return false;
      const monthDiff = (todayMonth - (due.getMonth() + 1) + 12) % 3;
      return monthDiff === 0 && due.getDate() === todayDom;
    }
    if (f === 'yearly') return due && due.getMonth() + 1 === todayMonth && due.getDate() === todayDom;
    if (f === 'once') return c.due_date === today;
    return false;
  });

  res.json(out);
});

// Approval columns — mam (2026-05-16): "after need to approval".
// Idempotent ALTER TABLE.  approval_status defaults to 'pending'
// so every new completion shows up in the admin's approval queue.
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approval_status TEXT DEFAULT 'pending'`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approved_by INTEGER REFERENCES users(id)`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approved_at DATETIME`); } catch (_) {}
try { getDb().exec(`ALTER TABLE checklist_completions ADD COLUMN approval_note TEXT`); } catch (_) {}

// Mark a checklist as done for a given date (with optional proof_url
// + notes).  Mam (2026-05-22): users need to back-date submissions
// — e.g. upload Monday morning the proof for the Saturday daily
// task.  Optional body.completion_date defaults to today; admin can
// always back-date, non-admins are clamped to the task's recurrence
// window so they can't fabricate completions for days the task
// didn't even apply.
//
// Uses UPSERT so re-submitting overwrites the proof.  Resets the
// approval status to 'pending' on re-submit so the admin re-reviews.
router.post('/checklists/:id/complete', (req, res) => {
  const { proof_url, notes } = req.body;
  let date = req.body.completion_date && String(req.body.completion_date).trim()
    ? String(req.body.completion_date).trim().slice(0, 10)
    : new Date().toISOString().split('T')[0];

  const db = getDb();
  const c = db.prepare('SELECT * FROM checklists WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Checklist not found' });

  // Non-admin clamp: must be inside the recurrence window if one is set.
  if (req.user.role !== 'admin') {
    if (c.recurrence_start_date && date < c.recurrence_start_date) {
      return res.status(400).json({ error: 'Date is before this task\'s Start Date' });
    }
    if (c.recurrence_end_date && date > c.recurrence_end_date) {
      return res.status(400).json({ error: 'Date is after this task\'s End Date' });
    }
  }

  db.prepare(
    `INSERT INTO checklist_completions (checklist_id, user_id, completion_date, proof_url, notes, approval_status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(checklist_id, user_id, completion_date) DO UPDATE SET
       proof_url = excluded.proof_url,
       notes = excluded.notes,
       submitted_at = CURRENT_TIMESTAMP,
       approval_status = 'pending',
       approved_by = NULL, approved_at = NULL, approval_note = NULL`
  ).run(req.params.id, req.user.id, date, proof_url || null, notes || null);
  res.json({ message: `Checklist marked complete for ${date} — pending admin approval`, date });
});

// ── GET /hr/checklists/by-date?date=YYYY-MM-DD ──────────────────
// Mam (2026-05-16): "where i can check as per daily and previous
// check list done or not done".  Returns every checklist active
// on that date with its completion status (if any), proof URL,
// and approval status.  Admin sees all; non-admin sees only their
// own assignments.
router.get('/checklists/by-date', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const isAdmin = req.user.role === 'admin';
  const scope = isAdmin ? '' : 'AND c.assigned_to = ?';
  // Build args in the exact order placeholders appear in the SQL.
  // Was previously buggy (legacy `params = [date]` was duplicating the
  // first arg → "Too many parameter values were provided").  Mam saw
  // the error after the recurrence-window fields were added.
  const args = [date];                          // for the JOIN ON ... = ?
  if (!isAdmin) args.push(req.user.id);         // for the scope ... = ?
  args.push(date, date);                        // start ≤ ? and end ≥ ?

  const rows = db.prepare(`
    SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
           c.department, c.recurrence_start_date, c.recurrence_end_date,
           c.assigned_to, u.name as assigned_to_name,
           comp.id as completion_id,
           comp.proof_url, comp.notes, comp.submitted_at,
           comp.approval_status, comp.approved_at, comp.approval_note,
           au.name as approved_by_name
    FROM checklists c
    LEFT JOIN users u  ON c.assigned_to = u.id
    LEFT JOIN checklist_completions comp
      ON comp.checklist_id = c.id AND comp.user_id = c.assigned_to AND comp.completion_date = ?
    LEFT JOIN users au ON comp.approved_by = au.id
    WHERE 1=1 ${scope}
      AND (c.recurrence_start_date IS NULL OR c.recurrence_start_date <= ?)
      AND (c.recurrence_end_date   IS NULL OR c.recurrence_end_date   >= ?)
    ORDER BY u.name, c.department, c.description
  `).all(...args);
  res.json({ date, rows });
});

// ── GET /hr/checklists/followup?back=7&forward=7 ────────────────
// Mam (2026-05-22): "i need followup checklist where all record
// mention previous, present, future".  Returns one row per checklist
// task with a horizontal timeline of dates (back N → today → forward
// N).  Each cell carries the status for that date:
//   'done_approved' | 'done_pending' | 'done_rejected'
//   'missed'  (past + frequency-applicable + no completion)
//   'today'   (current day, no completion yet)
//   'future'  (upcoming + frequency-applicable)
//   'na'      (frequency says this task doesn't apply on that date)
router.get('/checklists/followup', (req, res) => {
  const db = getDb();
  const back = Math.min(30, Math.max(0, parseInt(req.query.back || '7', 10)));
  const forward = Math.min(30, Math.max(0, parseInt(req.query.forward || '7', 10)));
  const isAdmin = req.user.role === 'admin';

  // Build the date window (ISO YYYY-MM-DD strings, IST).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = -back; i <= forward; i += 1) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  // Pull the candidate task list (admin sees all, others only their own).
  const taskSql = isAdmin
    ? `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       ORDER BY u.name COLLATE NOCASE, c.department, c.description`
    : `SELECT c.id, c.description, c.title, c.frequency, c.due_date, c.due_time,
              c.department, c.assigned_to, u.name AS assigned_to_name,
              c.recurrence_start_date, c.recurrence_end_date
       FROM checklists c LEFT JOIN users u ON c.assigned_to = u.id
       WHERE c.assigned_to = ?
       ORDER BY c.department, c.description`;
  const tasks = isAdmin ? db.prepare(taskSql).all() : db.prepare(taskSql).all(req.user.id);

  // Pull ALL completions in the window (one query, then bucket
  // client-side by checklist_id + date).
  const compRows = db.prepare(`
    SELECT checklist_id, user_id, completion_date, proof_url,
           approval_status, submitted_at
    FROM checklist_completions
    WHERE completion_date BETWEEN ? AND ?
  `).all(fromDate, toDate);
  const compMap = {};
  for (const r of compRows) {
    compMap[`${r.checklist_id}::${r.completion_date}`] = r;
  }

  // Frequency → "does this date apply to this task?" helper.  Now
  // also respects mam's (2026-05-22) start/end recurrence window:
  // out-of-window dates ALWAYS return false so the cell renders as
  // N/A in the grid and doesn't count as "missed".
  function applies(task, dateStr) {
    if (task.recurrence_start_date && dateStr < task.recurrence_start_date) return false;
    if (task.recurrence_end_date   && dateStr > task.recurrence_end_date)   return false;
    if (!task.frequency) return true;
    const f = task.frequency.toLowerCase();
    if (f === 'daily') return true;
    if (f === 'weekly') {
      if (!task.due_date) return true;
      return new Date(task.due_date).getDay() === new Date(dateStr).getDay();
    }
    // monthly / quarterly / yearly / once — keep generous.
    return true;
  }

  const rows = tasks.map(t => {
    const cells = dates.map(d => {
      const comp = compMap[`${t.id}::${d}`];
      const isPast   = d < dates[back];
      const isToday  = d === dates[back];
      const inScope  = applies(t, d);
      let status;
      if (!inScope) status = 'na';
      else if (comp) {
        if (comp.approval_status === 'approved')      status = 'done_approved';
        else if (comp.approval_status === 'rejected') status = 'done_rejected';
        else                                          status = 'done_pending';
      } else if (isPast)  status = 'missed';
      else if (isToday)   status = 'today';
      else                status = 'future';
      return { date: d, status, proof_url: comp?.proof_url || null, submitted_at: comp?.submitted_at || null };
    });
    return {
      id: t.id,
      description: t.description || t.title,
      frequency: t.frequency,
      department: t.department,
      assigned_to: t.assigned_to,
      assigned_to_name: t.assigned_to_name,
      cells,
    };
  });

  res.json({ from: fromDate, to: toDate, dates, today_index: back, rows });
});

// ── POST /hr/checklists/completions/:id/decision (admin only) ───
// Approve or reject a checklist completion.  Body: { status, note }.
router.post('/checklists/completions/:id/decision', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { status, note } = req.body || {};
  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }
  const db = getDb();
  const r = db.prepare(`
    UPDATE checklist_completions
    SET approval_status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_note = ?
    WHERE id = ?
  `).run(status, req.user.id, note || null, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Completion not found' });
  res.json({ message: `Marked ${status}` });
});

module.exports = router;
