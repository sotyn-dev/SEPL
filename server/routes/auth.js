const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { generateToken, authMiddleware, adminOnly, getUserPermissions } = require('../middleware/auth');
const router = express.Router();

router.post('/login', (req, res) => {
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
  const user = db.prepare(
    'SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)) AND active = 1'
  ).get(identifier, identifier);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    // Log failed login attempts so admin can spot brute-force patterns.
    logAuditEvent({
      action: 'LOGIN_FAIL', entity_type: 'auth', entity_label: identifier,
      method: 'POST', path: '/api/auth/login', status_code: 401, ip, user_agent: ua,
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = generateToken(user);
  const permissions = getUserPermissions(user.id);
  const userRoles = db.prepare(`SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?`).all(user.id);
  // Successful login — record user + ip + UA for session tracking.
  logAuditEvent({
    user: { id: user.id, name: user.name, role: user.role },
    action: 'LOGIN', entity_type: 'auth', entity_id: user.id, entity_label: user.name,
    method: 'POST', path: '/api/auth/login', status_code: 200, ip, user_agent: ua,
  });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, username: user.username, role: user.role, department: user.department, phone: user.phone },
    permissions,
    userRoles: userRoles.map(r => r.name)
  });
});

router.post('/register', authMiddleware, adminOnly, (req, res) => {
  const { name, email, username, password, role, department, phone, role_ids } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, username, password, role, department, phone) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, username ? username.trim() : null, hash, role || 'user', department || null, phone || null);

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
  const user = db.prepare('SELECT id, name, email, username, role, department, phone FROM users WHERE id = ?').get(req.user.id);
  const permissions = getUserPermissions(req.user.id);
  const userRoles = db.prepare(`SELECT r.name FROM roles r JOIN user_roles ur ON r.id=ur.role_id WHERE ur.user_id=?`).all(req.user.id);
  res.json({ ...user, permissions, userRoles: userRoles.map(r => r.name) });
});

router.get('/users', authMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.department, u.phone, u.active, u.created_at,
    GROUP_CONCAT(r.name) as role_names
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    GROUP BY u.id ORDER BY u.name
  `).all();
  res.json(users);
});

// Update user (admin only)
router.put('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { name, email, username, department, phone, role, active, role_ids, password } = req.body;
  const db = getDb();

  try {
    const uname = username !== undefined ? (username ? String(username).trim() : null) : undefined;
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

  res.json({ message: 'User updated' });
});

// Self-service: change own password (any logged-in user)
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const db = getDb();
  const user = db.prepare('SELECT id, password FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ message: 'Password changed successfully' });
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
  res.json({ message: 'Password reset', user: { id: user.id, name: user.name, username: user.username, email: user.email }, new_password: newPassword });
});

// Deactivate user (admin only)
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  getDb().prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
  res.json({ message: 'User deactivated' });
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

// Set permissions for a role (bulk update)
router.put('/roles/:id/permissions', authMiddleware, adminOnly, (req, res) => {
  const { permissions } = req.body; // Array of { module, can_view, can_create, can_edit, can_delete, can_approve }
  const db = getDb();
  db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(req.params.id);
  const insert = db.prepare('INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
  for (const p of (permissions || [])) {
    insert.run(req.params.id, p.module, p.can_view ? 1 : 0, p.can_create ? 1 : 0, p.can_edit ? 1 : 0, p.can_delete ? 1 : 0, p.can_approve ? 1 : 0);
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
