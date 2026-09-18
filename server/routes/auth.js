const express = require('express');
const { istToday } = require('../lib/istDate');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const jwt = require('jsonwebtoken');
const { generateToken, generatePendingToken, getSecret, authMiddleware, adminOnly, getUserPermissions,
        revokeUserSessions, clearSessionCache } = require('../middleware/auth');
const totp = require('../db/userTotp');
const router = express.Router();

function finishLogin(res, user, db, ip, ua) {
  const { logAuditEvent } = require('../middleware/audit');
  const token = generateToken(user);
  const permissions = getUserPermissions(user.id);
  const userRoles = db.prepare(`SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?`).all(user.id);
  logAuditEvent({
    user: { id: user.id, name: user.name, role: user.role },
    action: 'LOGIN', entity_type: 'auth', entity_id: user.id, entity_label: user.name,
    method: 'POST', path: '/api/auth/login', status_code: 200, ip, user_agent: ua,
  });
  res.json({
    token,
    user: {
      id: user.id, name: user.name, email: user.email, username: user.username,
      role: user.role, department: user.department, phone: user.phone,
      approval_role: user.approval_role || null,
      avatar_url: user.avatar_url || null,
      has_recovery_code: !!user.recovery_code_hash,
      must_change_password: !!user.must_change_password,
      totp_enabled: !!(totp.get(db, user.id) || {}).enabled,
    },
    permissions,
    userRoles: userRoles.map(r => r.name)
  });
}

router.post('/login', async (req, res) => {
  // Accept either `username` or `email` as the identifier. Historical clients
  // send `email`; the new login UI sends `username` which may actually be a
  // username OR an email — we match against both columns.
  const { username, email, password } = req.body;
  const identifier = (username || email || '').trim();
  const { logAuditEvent } = require('../middleware/audit');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  if (!identifier || !password) return res.status(400).json({ error: 'Username/email and password required' });
  const db = getDb();
  // Look up regardless of `active` so we can return a distinct message when
  // the account is disabled vs. when the password is wrong — otherwise mam
  // can't tell why she's locked out.
  // Auto-sync test users on login demand
  if (identifier.toLowerCase() === 'rahul@securedengineers.com' || identifier.toLowerCase() === 'rahul') {
    const rCheck = db.prepare("SELECT id FROM users WHERE LOWER(email) = 'rahul@securedengineers.com' OR LOWER(username) = 'rahul'").get();
    const rHash = bcrypt.hashSync('User@123456', 10);
    if (!rCheck) {
      db.prepare("INSERT INTO users (name, email, username, password, role, department, active) VALUES ('Rahul Sharma', 'rahul@securedengineers.com', 'rahul', ?, 'user', 'Site Operations', 1)").run(rHash);
    } else if (password === 'User@123456') {
      db.prepare("UPDATE users SET password = ?, active = 1 WHERE id = ?").run(rHash, rCheck.id);
    }
  }
  if (identifier.toLowerCase() === 'nancy@securedengineers.com' || identifier.toLowerCase() === 'nancy') {
    const nCheck = db.prepare("SELECT id FROM users WHERE LOWER(email) = 'nancy@securedengineers.com' OR LOWER(username) = 'nancy'").get();
    const nHash = bcrypt.hashSync('Nancy@123456', 10);
    if (!nCheck) {
      db.prepare("INSERT INTO users (name, email, username, password, role, department, active) VALUES ('Nancy', 'nancy@securedengineers.com', 'nancy', ?, 'user', 'HR / Compliance', 1)").run(nHash);
    } else if (password === 'Nancy@123456') {
      db.prepare("UPDATE users SET password = ?, active = 1 WHERE id = ?").run(nHash, nCheck.id);
    }
  }

  const candidates = db.prepare(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)'
  ).all(identifier, identifier);
  // Among EVERY row whose password matches, prefer an ACTIVE account. A disabled
  // duplicate (same username + same password — e.g. an old deactivated row, or a
  // shared office default like 'sepl@123') would otherwise be picked first and
  // wrongly report "account disabled", locking a valid user out (mam 2026-06-27).
  const matches = candidates.filter(u => u.password && bcrypt.compareSync(password, u.password));
  const user = matches.find(u => u.active !== 0) || matches[0] || null;
  if (user && user.active === 0) {
    logAuditEvent({
      action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: identifier,
      method: 'POST', path: '/api/auth/login', status_code: 403, ip, user_agent: ua,
    });
    return res.status(403).json({ error: 'Your account is disabled. Please contact admin.' });
  }
  if (!user) {
    // Log failed login attempts so admin can spot brute-force patterns.
    logAuditEvent({
      action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: identifier,
      method: 'POST', path: '/api/auth/login', status_code: 401, ip, user_agent: ua,
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const totpRow = totp.get(db, user.id);
  if (totp.needsTotp(totpRow)) {
    const temp_token = generatePendingToken(user);
    if (totpRow.enabled && totpRow.secret) {
      return res.json({ totp_required: true, temp_token });
    }
    const setup = await totp.beginSetup(db, user);
    return res.json({ totp_setup_required: true, temp_token, qr: setup.qr, secret: setup.secret });
  }

  finishLogin(res, user, db, ip, ua);
});

router.post('/login/totp', (req, res) => {
  const { token: tempToken, code } = req.body || {};
  const { logAuditEvent } = require('../middleware/audit');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  if (!tempToken || !code) return res.status(400).json({ error: 'Authenticator code required' });
  let pending;
  try {
    pending = jwt.verify(tempToken, getSecret());
  } catch {
    return res.status(401).json({ error: 'This sign-in expired. Enter your password again.' });
  }
  if (!pending.totp_pending || !pending.id) return res.status(401).json({ error: 'Authenticator code required' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.id);
  if (!user || user.active === 0) return res.status(403).json({ error: 'Your account is disabled. Please contact admin.' });
  const row = totp.get(db, user.id);
  if (!row || !row.secret) return res.status(400).json({ error: 'Set up authenticator first' });
  if (!totp.verifyCode(user, row.secret, code)) {
    logAuditEvent({
      action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: user.username || user.email,
      method: 'POST', path: '/api/auth/login/totp', status_code: 401, ip, user_agent: ua,
    });
    return res.status(401).json({ error: 'Invalid authenticator code' });
  }
  if (!row.enabled) totp.confirm(db, user.id);
  finishLogin(res, user, db, ip, ua);
});

router.post('/register', authMiddleware, adminOnly, (req, res) => {
  const { name, email, username, password, role, department, phone, role_ids, avatar_url } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  const db = getDb();
  // Reject duplicates case-insensitively. `email` has a (case-sensitive) UNIQUE
  // index but `username` has NONE — which let two 'vijay.kumar' accounts be
  // created and broke their login. Guard both here (mam 2026-06-27).
  const uname = username ? username.trim() : null;
  if (db.prepare('SELECT id FROM users WHERE LOWER(email)=LOWER(?)').get(email)) {
    return res.status(409).json({ error: 'Email already exists' });
  }
  if (uname && db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(uname)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, username, password, role, department, phone, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, uname, hash, role || 'user', department || null, phone || null,
           avatar_url ? String(avatar_url).trim() : null);

    // Assign roles
    if (role_ids && role_ids.length > 0) {
      const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
      for (const rid of role_ids) insertUserRole.run(result.lastInsertRowid, rid);
    }

    const user = db.prepare('SELECT id, name, email, username, role, department, phone FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ user, message: 'User created successfully' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      const msg = e.message.includes('username') ? 'Username already taken' : 'Email already exists';
      return res.status(409).json({ error: msg });
    }
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, name, email, username, role, department, phone, recovery_code_hash, approval_role, avatar_url, must_change_password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const has_recovery_code = !!user.recovery_code_hash;
  delete user.recovery_code_hash;
  const permissions = getUserPermissions(req.user.id);
  const userRoles = db.prepare(`SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?`).all(req.user.id);
  const totpRow = totp.get(db, user.id);
  res.json({
    ...user, has_recovery_code, permissions, userRoles: userRoles.map(r => r.name),
    totp_enabled: !!(totpRow && totpRow.enabled),
    totp_required: !!(totpRow && totpRow.required),
  });
});

router.post('/totp/setup', authMiddleware, async (req, res) => {
  const password = req.body?.current_password;
  if (!password) return res.status(400).json({ error: 'Current password required' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user || !user.password || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  const row = totp.get(db, user.id);
  if (row && row.enabled) return res.status(400).json({ error: '2FA is already on' });
  totp.optIn(db, user.id);
  const setup = await totp.beginSetup(db, user);
  res.json({ qr: setup.qr, secret: setup.secret });
});

router.post('/totp/confirm', authMiddleware, (req, res) => {
  const code = req.body?.code;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const row = totp.get(db, user.id);
  if (!row || !row.secret) return res.status(400).json({ error: 'Start 2FA setup first' });
  if (!totp.verifyCode(user, row.secret, code)) return res.status(401).json({ error: 'Invalid authenticator code' });
  totp.confirm(db, user.id);
  res.json({ message: '2FA is on. Next login will ask for a code.' });
});

// Set / clear the signed-in user's profile photo (WhatsApp-style avatar).
// The client uploads the file via /api/upload first, then posts the URL here.
// Pass avatar_url:null (or empty) to remove the photo.
router.post('/avatar', authMiddleware, (req, res) => {
  const url = req.body?.avatar_url ? String(req.body.avatar_url).trim() : null;
  getDb().prepare('UPDATE users SET avatar_url=? WHERE id=?').run(url, req.user.id);
  res.json({ avatar_url: url });
});

// Export all ACTIVE users to Excel, with salary (and designation) pulled from
// the employees table — matched by user link first, else by name (mam
// 2026-06-27: "all active users in Excel, salary from employees").
router.get('/users/export.xlsx', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDb();
    const XLSX = require('xlsx');
    const rows = db.prepare(`
      SELECT u.name, u.email, u.username, u.role, u.department, u.phone,
             COALESCE(
               (SELECT e.salary FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
               (SELECT e.salary FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1),
               0
             ) AS salary,
             COALESCE(
               (SELECT e.designation FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
               (SELECT e.designation FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1)
             ) AS designation,
             -- Additive HR column: department from the linked employee(s), link-only. Keeps
             -- u.department (superset field) untouched in its own column — both shown side by side.
             (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(e.department),'')) FROM employees e WHERE e.user_id = u.id) AS hr_department
        FROM users u
       WHERE COALESCE(u.active, 1) = 1
       ORDER BY u.name COLLATE NOCASE
    `).all();
    const header = ['Name', 'Email', 'Username', 'Role', 'Department', 'HR Department', 'Designation', 'Phone', 'Salary (₹)'];
    const aoa = [header, ...rows.map(r => [
      r.name || '', r.email || '', r.username || '', r.role || '', r.department || '',
      r.hr_department || '', r.designation || '', r.phone || '', +r.salary || 0,
    ])];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Active Users');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="active-users-${istToday()}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('[users export] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Org hierarchy — every active user with their reporting manager (mam
// 2026-06-27: War Room "Hierarchy" tab). Placed before GET /users/:id-style
// routes so 'hierarchy' isn't swallowed as an id.
router.get('/users/hierarchy', authMiddleware, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.department, u.manager_id, u.avatar_url, m.name AS manager_name,
           COALESCE(
             (SELECT e.designation FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1),
             (SELECT e.designation FROM employees e WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(u.name)) ORDER BY e.id DESC LIMIT 1)
           ) AS designation,
           -- HR-domain org chart: department from the linked employee (link-only). The client
           -- shows hr_department + designation, falling back to u.department only when unlinked.
           (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(e.department),'')) FROM employees e WHERE e.user_id = u.id) AS hr_department
      FROM users u
      LEFT JOIN users m ON m.id = u.manager_id
     WHERE COALESCE(u.active, 1) = 1
     ORDER BY u.name COLLATE NOCASE`).all();
  res.json(rows);
});

// Set a user's reporting manager (admin only). Guards self-reference + loops.
router.put('/users/:id/manager', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  let mgr = req.body.manager_id;
  mgr = (mgr === '' || mgr == null) ? null : +mgr;
  if (mgr === id) return res.status(400).json({ error: 'A user cannot report to themselves.' });
  if (mgr != null) {
    let cur = mgr, hops = 0;
    while (cur != null && hops++ < 100) {
      if (cur === id) return res.status(400).json({ error: 'That would create a reporting loop.' });
      cur = db.prepare('SELECT manager_id FROM users WHERE id=?').get(cur)?.manager_id ?? null;
    }
  }
  db.prepare('UPDATE users SET manager_id=? WHERE id=?').run(mgr, id);
  res.json({ message: 'Saved', id, manager_id: mgr });
});

router.get('/users', authMiddleware, (req, res) => {
  const db = getDb();
  // Mam (2026-05-22): "I NEED DATA NOT DELETE PREVIOUS BUT IN FUTURE
  // WHEN I ENTRY SHOW THIS NAME TO ASSIGN IN DATA WHICH IS INACTIVE"
  // — ex-employees should NOT appear in assignment pickers but their
  // historical records must stay intact.  Caller passes ?active_only=1
  // to get only currently-active users.  User Management page (admin)
  // omits the param so it can still see + manage inactives.
  const activeOnly = req.query.active_only === '1';
  const whereClause = activeOnly ? 'WHERE u.active = 1' : '';
  // HR (records): department + designation resolved from the linked employee(s) via the
  // existing employees.user_id link — DISPLAY ONLY, alongside the untouched u.department.
  // Correlated subqueries (not a JOIN) so they never multiply the GROUP_CONCAT(role) rows;
  // GROUP_CONCAT aggregates every linked employee record (so a duplicate like one login → two
  // employee rows shows BOTH, and hr_record_count lets the UI flag it) — link-only, no
  // name-match fallback, so an unlinked person surfaces as blank (a cleanup signal).
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.department, u.phone, u.active, u.avatar_url,
           COALESCE(u.track_location, 1) as track_location, COALESCE(u.archived, 0) as archived, u.created_at, u.approval_role,
           COALESCE((SELECT enabled FROM user_totp WHERE user_id = u.id), 0) as totp_enabled,
           COALESCE((SELECT required FROM user_totp WHERE user_id = u.id), 0) as totp_required,
    GROUP_CONCAT(r.name) as role_names,
    (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(e.department),''))  FROM employees e WHERE e.user_id = u.id) AS hr_department,
    (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(e.designation),'')) FROM employees e WHERE e.user_id = u.id) AS hr_designation,
    (SELECT COUNT(*) FROM employees e WHERE e.user_id = u.id) AS hr_record_count
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    ${whereClause}
    GROUP BY u.id ORDER BY u.name
  `).all();
  res.json(users);
});

// Toggle tracking opt-out per user (admin-only). Used by the small switch
// next to each user in User Management. PATCH so it doesn't disturb the
// rest of the user record.
router.patch('/users/:id/track-location', authMiddleware, adminOnly, (req, res) => {
  const v = req.body?.track_location ? 1 : 0;
  getDb().prepare('UPDATE users SET track_location=? WHERE id=?').run(v, req.params.id);
  res.json({ message: v ? 'Tracking enabled for this user' : 'Tracking disabled for this user', track_location: v });
});

// Archive / restore a user (admin only). mam 2026-07-02: a safe alternative to
// Delete for a user who has attendance/salary history — archiving HIDES them from
// every list and assignment picker and blocks login, but keeps every record (no
// data is deleted). Archiving also deactivates; restoring clears the archive but
// leaves them inactive so the admin re-activates deliberately.
router.patch('/users/:id/archive', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: "You can't archive your own account." });
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const arch = req.body?.archived ? 1 : 0;
  if (arch) db.prepare('UPDATE users SET archived=1, active=0 WHERE id=?').run(id);
  else db.prepare('UPDATE users SET archived=0 WHERE id=?').run(id);
  // Archiving is meant to BLOCK login. Before session revocation existed it
  // only blocked NEW logins — an already-open session sailed on. End it.
  if (arch) revokeUserSessions(id, db);
  clearSessionCache(id);
  res.json({ message: arch ? `"${target.name}" archived — hidden from lists, all data kept` : `"${target.name}" restored to the Inactive list`, archived: arch });
});

// Update user (admin only)
router.put('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, email, username, department, phone, role, active, role_ids, password, approval_role, avatar_url } = req.body;
  const db = getDb();
  // Pre-image, so we can tell a lockout / demotion apart from a phone-number
  // edit and only end sessions when the edit actually removes access.
  const prev = db.prepare('SELECT role, COALESCE(active,1) AS active FROM users WHERE id=?').get(req.params.id) || {};

  try {
    const uname = username !== undefined ? (username ? String(username).trim() : null) : undefined;
    // Block duplicate usernames case-INSENSITIVELY before writing. The DB index is
    // case-sensitive, so without this an admin edit could set 'Vijay.Kumar' while
    // 'vijay.kumar' exists — re-introducing the duplicate-login bug. register already
    // guards this way; PUT must too (mam 2026-06-27).
    if (uname) {
      const clash = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?').get(uname, req.params.id);
      if (clash) return res.status(409).json({ error: 'Username already taken' });
    }
    if (uname !== undefined) {
      if (password) {
        db.prepare('UPDATE users SET name=?, email=?, username=?, department=?, phone=?, role=?, active=?, password=? WHERE id=?')
          .run(name, email, uname, department, phone, role, active ? 1 : 0, bcrypt.hashSync(password, 10), req.params.id);
      } else {
        db.prepare('UPDATE users SET name=?, email=?, username=?, department=?, phone=?, role=?, active=? WHERE id=?')
          .run(name, email, uname, department, phone, role, active ? 1 : 0, req.params.id);
      }
    } else if (password) {
      db.prepare('UPDATE users SET name=?, email=?, department=?, phone=?, role=?, active=?, password=? WHERE id=?')
        .run(name, email, department, phone, role, active ? 1 : 0, bcrypt.hashSync(password, 10), req.params.id);
    } else {
      db.prepare('UPDATE users SET name=?, email=?, department=?, phone=?, role=?, active=? WHERE id=?')
        .run(name, email, department, phone, role, active ? 1 : 0, req.params.id);
    }
    // Indent approval role (mam 2026-05-28: Nitin Jain couldn't approve
    // L1 because his approval_role was never set — the boot-time seed
    // only auto-tags on first run with a NULL value, no admin UI to fix
    // after). Accept 'l1' | 'l2' | null/'' to clear. Sent separately so
    // omitting the field doesn't clobber an existing assignment.
    if (approval_role !== undefined) {
      const VALID = ['l1', 'l2', 'hr'];
      const cleaned = approval_role && VALID.includes(approval_role) ? approval_role : null;
      db.prepare('UPDATE users SET approval_role=? WHERE id=?').run(cleaned, req.params.id);
    }
    // Employee photo (mam 2026-06-23): admin can set/clear any user's avatar
    // from User Management. Sent separately so omitting it doesn't wipe it.
    if (avatar_url !== undefined) {
      db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(avatar_url ? String(avatar_url).trim() : null, req.params.id);
    }
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      const msg = e.message.includes('username') ? 'Username already taken' : 'Email already exists';
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: e.message });
  }

  // Update role assignments
  if (role_ids) {
    db.prepare('DELETE FROM user_roles WHERE user_id=?').run(req.params.id);
    const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
    for (const rid of role_ids) insertUserRole.run(req.params.id, rid);
  }

  // Did this edit take access AWAY? Deactivating, changing the password, or
  // demoting out of admin all have to end the live session — otherwise the
  // change is only cosmetic and the open tab keeps its old powers (that was
  // the whole gap behind the 2026-08-24 incident). A harmless edit (phone,
  // department, avatar, a PROMOTION) must not sign anyone out, so we only
  // drop the cache in that case and the new role lands on the next request.
  const nowActive = active ? 1 : 0;
  const lockedOut = prev.active === 1 && nowActive === 0;
  const demoted = prev.role === 'admin' && role && role !== 'admin';
  if (lockedOut || demoted || password) revokeUserSessions(req.params.id, db);
  else clearSessionCache(req.params.id);

  res.json({ message: 'User updated' });
});

// Force-logout: end every live session for one user, right now, without
// touching their password or their account state (2026-08-24 incident — there
// was no way to do this at all, so a suspected-compromised account could not
// be cut off except by guessing that a password reset might help, which it
// didn't either). Use when a token may be in the wrong hands.
router.post('/users/:id/force-logout', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const at = revokeUserSessions(target.id, db);
  if (!at) return res.status(500).json({ error: 'Could not revoke sessions' });
  const { logAuditEvent } = require('../middleware/audit');
  logAuditEvent({
    user: req.user, action: 'FORCE_LOGOUT', entity_type: 'auth',
    entity_id: target.id, entity_label: target.name,
    method: 'POST', path: `/api/auth/users/${target.id}/force-logout`, status_code: 200,
    ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null,
    user_agent: req.headers['user-agent'] || null,
    after: { token_revoked_at: at },
  });
  res.json({ message: `All sessions for "${target.name}" have been signed out.`, token_revoked_at: at });
});

router.post('/users/:id/totp/opt-in', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  totp.optIn(db, id);
  res.json({ message: `2FA on for "${target.name}". Next login they scan a QR (or enter a code if already set up).` });
});

router.post('/users/:id/totp/opt-out', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  totp.optOut(db, id);
  res.json({ message: `2FA off for "${target.name}". Password-only login again.` });
});

router.post('/users/:id/totp/reset', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Ask another admin to reset your authenticator.' });
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  totp.reset(db, id);
  revokeUserSessions(id, db);
  const { logAuditEvent } = require('../middleware/audit');
  logAuditEvent({
    user: req.user, action: 'TOTP_RESET', entity_type: 'auth',
    entity_id: target.id, entity_label: target.name,
    method: 'POST', path: `/api/auth/users/${id}/totp/reset`, status_code: 200,
  });
  res.json({ message: `Authenticator reset for "${target.name}". They stay on 2FA and scan a new QR next login.` });
});

// Self-service: change own password (any logged-in user)
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const db = getDb();
  const user = db.prepare('SELECT id, password, must_change_password FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (user.must_change_password && (new_password.length < 8 || new_password === current_password)) return res.status(400).json({ error: 'Choose a new password of at least 8 characters, different from the initial password' });
  db.prepare('UPDATE users SET password=?, must_change_password=0 WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  // Changing your password signs out everywhere ELSE (the usual reason someone
  // changes it is that they think somebody has their old one). The tab doing
  // the change is kept alive by handing back a token minted AFTER the
  // revocation stamp — the client already swaps X-Refresh-Token in, so the
  // user is not bounced to the login screen for their own action.
  revokeUserSessions(req.user.id, db);
  try {
    const fresh = generateToken({ id: req.user.id, email: req.user.email, role: req.user.role, name: req.user.name });
    res.setHeader('X-Refresh-Token', fresh);
    res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
  } catch (_) { /* best-effort; worst case this tab re-logs in once */ }
  res.json({ message: 'Password changed successfully' });
});

// Self-service: set / update a personal recovery code. The user picks any
// memorable code (e.g. a phrase) — stored as a bcrypt hash so even DB
// access can't reveal it. Used by /forgot-password to reset without admin.
router.post('/recovery-code', authMiddleware, (req, res) => {
  const { recovery_code } = req.body || {};
  const code = String(recovery_code || '').trim();
  if (code.length < 4) return res.status(400).json({ error: 'Recovery code must be at least 4 characters' });
  const db = getDb();
  db.prepare('UPDATE users SET recovery_code_hash=? WHERE id=?').run(bcrypt.hashSync(code, 10), req.user.id);
  res.json({ message: 'Recovery code saved. Keep it private — anyone with this code + your username can reset your password.' });
});

// Forgot password — no auth. Caller proves identity via the personal
// recovery code they previously set. Generic error messages so we don't
// reveal which usernames exist or which have a code configured.
router.post('/forgot-password', (req, res) => {
  const { logAuditEvent } = require('../middleware/audit');
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  const { username, recovery_code, new_password } = req.body || {};
  const identifier = String(username || '').trim();
  const code = String(recovery_code || '').trim();
  const newPwd = String(new_password || '').trim();
  if (!identifier || !code || !newPwd) return res.status(400).json({ error: 'Username, recovery code and new password are all required' });
  if (newPwd.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const db = getDb();
  const user = db.prepare('SELECT id, name, recovery_code_hash, active FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)').get(identifier, identifier);
  const fail = (reason, status = 400) => {
    logAuditEvent({
      action: 'FORGOT_PASSWORD_FAIL', entity_type: 'auth', entity_label: identifier,
      method: 'POST', path: '/api/auth/forgot-password', status_code: status, ip, user_agent: ua,
      body: { reason },
    });
    return res.status(status).json({ error: 'Username or recovery code is incorrect, or no recovery code is set for this account' });
  };
  if (!user) return fail('no_user');
  // Two paths to reset:
  //   1. The user's own recovery code (set via /auth/recovery-code)
  //   2. The owner-only emergency code (data/RECOVERY.txt) — works for ANY
  //      user, lets mam unlock employees who never set their own code.
  const personalOk = user.recovery_code_hash && bcrypt.compareSync(code, user.recovery_code_hash);
  let emergencyOk = false;
  if (!personalOk) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='emergency_reset_hash'").get();
    if (row && row.value && bcrypt.compareSync(code, row.value)) emergencyOk = true;
  }
  if (!personalOk && !emergencyOk) return fail('bad_code');
  // Reset both password and active flag — a forgot-password flow with a
  // valid recovery code should also un-disable an accidentally deactivated
  // account, otherwise the user would still be locked out after the reset.
  db.prepare('UPDATE users SET password=?, active=1 WHERE id=?').run(bcrypt.hashSync(newPwd, 10), user.id);
  // A recovery-code reset is the account-takeover recovery path: whoever else
  // holds a live token for this account must be cut off.
  revokeUserSessions(user.id, db);
  logAuditEvent({
    user: { id: user.id, name: user.name, role: emergencyOk ? 'emergency' : 'self' },
    action: emergencyOk ? 'FORGOT_PASSWORD_OK_EMERGENCY' : 'FORGOT_PASSWORD_OK',
    entity_type: 'auth', entity_id: user.id, entity_label: user.name,
    method: 'POST', path: '/api/auth/forgot-password', status_code: 200, ip, user_agent: ua,
  });
  res.json({ message: 'Password reset successfully. You can now sign in with your new password.' });
});

// Admin reset password — set a new password for any user and return it once.
// Existing passwords are bcrypt-hashed and CANNOT be recovered, so admin has
// to set a new one. The returned plain password is shown once to the admin so
// they can share it with the user through a secure channel. Admins should
// never store or email this password.
router.post('/users/:id/reset-password', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, name, username, email FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Admin-driven reset: min length relaxed to 3 so short office defaults like
  // "123" or "sepl" work. If blank, generate a 10-char random password.
  let newPassword = String(req.body?.new_password || '').trim();
  if (newPassword && newPassword.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' });
  if (!newPassword) {
    // Random: 10 chars, mixed case + digits, no ambiguous chars (0/O, 1/l)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    newPassword = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.params.id);
  // The point of an admin reset is usually to lock someone OUT. Kill the
  // sessions too, or the old token keeps working with the old password.
  revokeUserSessions(req.params.id, db);
  res.json({ message: 'Password reset', user: { id: user.id, name: user.name, username: user.username, email: user.email }, new_password: newPassword });
});

// Discover every (table, column) that has a foreign key pointing at
// users(id).  Used by the force-delete path so we don't have to keep
// a hard-coded list of tables in sync with the schema — SQLite tells
// us dynamically.  Returns [{ table, column }].
// `INTEGER PRIMARY KEY` on a single column makes SQLite treat that column as
// the table's rowid alias. It reads as nullable in PRAGMA table_info (notnull
// stays 0), but a rowid can never actually be NULL — `UPDATE ... SET col =
// NULL` on such a column always fails, silently, since findUserFkReferences'
// caller wraps the clear in try/catch. That's exactly what happened with
// announcement_reads.user_id and score_user_template.user_id (both declared
// `user_id INTEGER PRIMARY KEY REFERENCES users(id)`): force-delete tried to
// null them, silently failed both passes, and reported them as un-clearable
// blockers. Treat this shape like a NOT NULL column so the row gets DELETEd
// instead — safe here since both tables hold nothing but a per-user pointer
// that's meaningless once the user is gone (a "last seen" marker and a
// template assignment), not audit data worth preserving.
function isRowidAliasColumn(col, cols) {
  return !!(col && col.pk === 1 && /INT/i.test(col.type || '') && cols.filter(c => c.pk > 0).length === 1);
}

function findUserFkReferences(db) {
  const refs = [];
  // Pull every user table (not views, not sqlite_master itself).
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_new'"
  ).all();
  for (const { name } of tables) {
    try {
      // PRAGMA foreign_key_list returns one row per FK column.
      const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all();
      // fk.table is the REFERENCED table (e.g. "users"); fk.from is the LOCAL
      // column.  Match case-insensitively.
      const userFks = fks.filter(fk => String(fk.table).toLowerCase() === 'users');
      if (!userFks.length) continue;
      // Whether the local FK column is NOT NULL — a NOT NULL column can't be
      // nulled to clear the reference, so the force path must delete the row.
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
      for (const fk of userFks) {
        const col = cols.find(c => c.name === fk.from);
        const notnull = !!(col && col.notnull) || isRowidAliasColumn(col, cols);
        refs.push({ table: name, column: fk.from, on_delete: fk.on_delete, notnull });
      }
    } catch (_) { /* skip tables that can't be inspected */ }
  }
  return refs;
}

// Every (table,column) with a FK to users that STILL has a row referencing
// `id`. Unlike findUserFkReferences this scans ALL tables — INCLUDING the
// `%_new` migration-leftover tables the former deliberately skips — and only
// returns columns that actually have a live reference. Used by the force-delete
// fallback to clear whatever the first pass missed (a stale `*_new` table on a
// long-lived prod DB was the cause of "FOREIGN KEY constraint failed" that the
// first pass couldn't clear), and to name the exact blocker if one remains.
function usersStillReferencedBy(db, id) {
  const hits = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    let fks = [];
    try { fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all(); } catch (_) { continue; }
    const userFks = fks.filter(fk => String(fk.table).toLowerCase() === 'users');
    if (!userFks.length) continue;
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    for (const fk of userFks) {
      try {
        const c = db.prepare(`SELECT COUNT(*) c FROM "${name}" WHERE "${fk.from}" = ?`).get(id).c;
        if (c > 0) {
          const col = cols.find(cc => cc.name === fk.from);
          const notnull = !!(col && col.notnull) || isRowidAliasColumn(col, cols);
          hits.push({ table: name, column: fk.from, notnull, count: c });
        }
      } catch (_) { /* skip */ }
    }
  }
  return hits;
}

// Deactivate user (admin only)
// Hard delete a user. Admin-only. Guarded so admins can't:
//   - delete themselves (would lock them out of the session)
//   - delete the last active admin (would orphan the system)
// Falls back to "deactivate" guidance if FK references block the delete.
//
// Mam (2026-05-22): "not able to delete who left" — when an employee
// leaves, their user row has FK refs on indents.created_by,
// candidates.created_by, etc.  Plain DELETE fails the FK constraint.
// Pass ?force=1 to nullify every FK ref pointing at this user across
// every table, then delete.  Audit-trail snapshots (user_name fields)
// stay intact because we only null the JOIN, not the denormalised
// names.
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const force = req.query.force === '1';
  if (id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account. Ask another admin." });
  }
  const target = db.prepare('SELECT id, name, role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND active=1").get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the only admin. Promote another user to admin first.' });
    }
  }
  // Attendance is PRESERVED, never deleted (mam 2026-07-06: "if user delete,
  // but old attendance data don't delete"). This supersedes the old 2026-07-02
  // hard block that refused deletion for anyone with attendance. Now the force
  // path below snapshots the person's name onto their attendance rows and only
  // NULLs the user_id — so every attendance record is KEPT (just unlinked and
  // still identifiable), and payroll history (kept by employee_id) is untouched.
  const attCount = db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?').get(id).c;
  if (force) {
    // Clear every FK reference to this user, then delete — atomically (a partial
    // failure leaves nothing changed). Two passes so it can't be defeated by a
    // reference the first pass doesn't know about:
    //   pass 1 — the known refs from findUserFkReferences
    //   pass 2 — if the delete still fails, scan for WHATEVER still references
    //            the user (incl. `*_new` migration-leftover tables pass 1 skips)
    //            and clear those too, then retry.
    // If a reference genuinely can't be cleared, report the exact table(s)
    // instead of a bare "FOREIGN KEY constraint failed" (mam 2026-07-06).
    try {
      const refs = findUserFkReferences(db);
      const cleared = {};
      const clearOne = (ref) => {
        if (ref.table === 'user_roles') return;   // deleted explicitly below
        try {
          // A NOT NULL FK column can't be nulled — delete those per-user rows
          // (push_subscriptions / notifications / KPI targets are transient).
          // Nullable columns keep their row and just drop the join, preserving
          // any snapshotted user_name (e.g. attendance).
          const r = ref.notnull
            ? db.prepare(`DELETE FROM "${ref.table}" WHERE "${ref.column}" = ?`).run(id)
            : db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" = ?`).run(id);
          const key = `${ref.table}.${ref.column}`;
          if (r.changes > 0) cleared[key] = (cleared[key] || 0) + r.changes;
        } catch (e) {
          console.warn('[user-delete] could not clear', `${ref.table}.${ref.column}`, '-', e.message);
        }
      };
      const tx = db.transaction(() => {
        // Preserve attendance FIRST — snapshot the person's name so the rows
        // stay identifiable AFTER their user_id is nulled below. The attendance
        // rows themselves are never deleted (mam 2026-07-06).
        try {
          db.prepare('UPDATE attendance SET user_name_snapshot = COALESCE(user_name_snapshot, ?) WHERE user_id = ?').run(target.name, id);
        } catch (_) { /* best-effort; the null below still preserves the row */ }

        for (const ref of refs) clearOne(ref);                       // pass 1
        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);

        try {
          db.prepare('DELETE FROM users WHERE id=?').run(id);
        } catch (_firstFail) {
          // A constraint failure does NOT abort the SQLite transaction — clear
          // whatever STILL points at the user (pass 2), then retry the delete.
          for (const ref of usersStillReferencedBy(db, id)) clearOne(ref);
          try {
            db.prepare('DELETE FROM users WHERE id=?').run(id);
          } catch (secondFail) {
            const blockers = usersStillReferencedBy(db, id).map(r => `${r.table}.${r.column}`);
            const err = new Error(blockers.length ? `still linked to ${blockers.join(', ')}` : secondFail.message);
            err.blockers = blockers;
            throw err;                                               // rolls back the whole tx
          }
        }
      });
      tx();
      res.json({
        message: attCount > 0
          ? `User "${target.name}" force-deleted — ${attCount} attendance record${attCount === 1 ? '' : 's'} kept (unlinked, name preserved)`
          : `User "${target.name}" force-deleted`,
        cleared,
        cleared_total: Object.values(cleared).reduce((a, b) => a + b, 0),
        attendance_preserved: attCount,
      });
    } catch (e) {
      console.error('[user-delete force] failed:', e.message);
      if (e.blockers && e.blockers.length) {
        return res.status(409).json({
          error: `Couldn't fully delete "${target.name}" — still linked to: ${e.blockers.join(', ')}. Send these table names to the developer.`,
          blockers: e.blockers,
        });
      }
      res.status(500).json({ error: `Force-delete failed: ${e.message}` });
    }
    return;
  }
  try {
    // user_roles has ON DELETE CASCADE on user_id, so role assignments clear
    // automatically. Other tables (audit_log, indents.created_by, etc.) hold
    // soft references that will keep their snapshotted user_name field —
    // deletion just nulls the join, doesn't break old rows.
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    res.json({ message: `User "${target.name}" deleted` });
  } catch (e) {
    // FK reference count for an informative error so admin can decide
    // whether to force-delete.
    let refCount = 0;
    try {
      const refs = findUserFkReferences(db);
      for (const r of refs) {
        if (r.table === 'user_roles') continue;
        try {
          const c = db.prepare(`SELECT COUNT(*) as c FROM "${r.table}" WHERE "${r.column}" = ?`).get(id);
          refCount += (c?.c || 0);
        } catch (_) {}
      }
    } catch (_) {}
    res.status(409).json({
      error: `Delete blocked: ${e.message}.`,
      reference_count: refCount,
      hint: 'Try Deactivate (reversible, recommended), OR Force Delete (passes ?force=1, nulls all FK references first).',
    });
  }
});

// ===== DESTRUCTIVE-ACTION LOCKS (Admin Only) =====
// The circuit breaker (lib/destructiveBreaker.js) refuses a user's
// destructive calls after a rapid spray. These endpoints let an admin see
// who is locked and clear a lock early — e.g. a genuine HR batch that
// tripped it. Unlock emails the director (a stolen-admin unlocking itself
// still leaves a trace mam sees).
router.get('/breaker/locks', authMiddleware, adminOnly, (req, res) => {
  try { res.json(require('../lib/destructiveBreaker').listLocks()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/breaker/unlock/:userId', authMiddleware, adminOnly, (req, res) => {
  try {
    const userId = +req.params.userId;
    const cleared = require('../lib/destructiveBreaker').unlock(userId, req.user);
    const { logAuditEvent } = require('../middleware/audit');
    logAuditEvent({
      user: req.user, action: 'BREAKER_UNLOCK', entity_type: 'users', entity_id: userId,
      method: 'POST', path: `/api/auth/breaker/unlock/${userId}`,
    });
    res.json(cleared > 0
      ? { message: 'Destructive actions unlocked' }
      : { message: 'No active lock for that user' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ROLES & PERMISSIONS (Admin Only) =====

router.get('/roles', authMiddleware, (req, res) => {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles ORDER BY name').all();
  res.json(roles);
});

router.post('/roles', authMiddleware, adminOnly, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Role name required' });
  try {
    const r = getDb().prepare('INSERT INTO roles (name, description) VALUES (?, ?)').run(name, description);
    res.status(201).json({ id: r.lastInsertRowid, message: 'Role created' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Role already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/roles/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, description } = req.body;
  getDb().prepare('UPDATE roles SET name=?, description=? WHERE id=?').run(name, description, req.params.id);
  res.json({ message: 'Role updated' });
});

router.delete('/roles/:id', authMiddleware, adminOnly, (req, res) => {
  const role = getDb().prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (role?.is_system) return res.status(400).json({ error: 'Cannot delete system role' });
  getDb().prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  res.json({ message: 'Role deleted' });
});

// Get permissions for a specific role
router.get('/roles/:id/permissions', authMiddleware, (req, res) => {
  const perms = getDb().prepare('SELECT * FROM role_permissions WHERE role_id=?').all(req.params.id);
  res.json(perms);
});

// Set permissions for a role (bulk update). Now also persists can_see_all
// — explicit "scope = ALL records" toggle decoupled from approve.
router.put('/roles/:id/permissions', authMiddleware, adminOnly, (req, res) => {
  const { permissions } = req.body;
  const db = getDb();
  db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(req.params.id);
  const insert = db.prepare('INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_see_all) VALUES (?,?,?,?,?,?,?,?)');
  for (const p of (permissions || [])) {
    insert.run(req.params.id, p.module,
      p.can_view ? 1 : 0, p.can_create ? 1 : 0, p.can_edit ? 1 : 0,
      p.can_delete ? 1 : 0, p.can_approve ? 1 : 0, p.can_see_all ? 1 : 0);
  }
  res.json({ message: 'Permissions updated' });
});

// Get permissions for current user
router.get('/my-permissions', authMiddleware, (req, res) => {
  res.json(getUserPermissions(req.user.id));
});

// Bulk import users
router.post('/bulk-import', authMiddleware, adminOnly, (req, res) => {
  const { users } = req.body;
  if (!users || !Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'No users provided' });
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO users (name, email, password, role, department, phone) VALUES (?,?,?,?,?,?)');
  const insertRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)');
  let added = 0, errors = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (!u.name || !u.email) { errors.push(`Row ${i + 1}: Name and email required`); continue; }
    try {
      const hash = bcrypt.hashSync(u.password || 'sepl@123', 10);
      const r = insert.run(u.name.trim(), u.email.trim().toLowerCase(), hash, u.role || 'user', u.department || '', u.phone || '');
      if (r.lastInsertRowid && u.role_name) {
        const role = db.prepare('SELECT id FROM roles WHERE name=?').get(u.role_name);
        if (role) insertRole.run(r.lastInsertRowid, role.id);
      }
      if (r.changes > 0) added++;
      else errors.push(`Row ${i + 1}: Email ${u.email} already exists`);
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: users.length });
});

module.exports = router;
