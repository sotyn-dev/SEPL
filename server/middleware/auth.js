const jwt = require('jsonwebtoken');
const { getDb } = require('../db/schema');
const SECRET = process.env.JWT_SECRET || 'erp-secret-key-change-in-production';

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Permission check middleware factory
function requirePermission(module, action) {
  return (req, res, next) => {
    // Admin role always has full access
    if (req.user.role === 'admin') return next();

    const db = getDb();
    // Get user's role permissions
    const perms = db.prepare(`
      SELECT rp.* FROM role_permissions rp
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = ?
    `).get(req.user.id, module);

    if (!perms) {
      return res.status(403).json({ error: `No access to ${module}` });
    }

    const actionMap = {
      view: 'can_view',
      create: 'can_create',
      edit: 'can_edit',
      delete: 'can_delete',
      approve: 'can_approve',
    };

    const field = actionMap[action];
    if (!field || !perms[field]) {
      return res.status(403).json({ error: `No ${action} permission for ${module}` });
    }

    next();
  };
}

// Get all permissions for a user (used by frontend)
function getUserPermissions(userId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

  if (user?.role === 'admin') {
    // Admin gets everything
    const modules = [
      'dashboard','leads','quotations','orders','business_book','item_master','vendors','customers','procurement',
      'cashflow','collections','payment_required','attendance','indent_fms','dpr',
      'installation','billing','complaints','hr','employees','expenses','checklists','users','delegations','pms_tasks'
    ];
    const perms = {};
    for (const m of modules) {
      perms[m] = { can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_approve: 1 };
    }
    return perms;
  }

  const rows = db.prepare(`
    SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete, rp.can_approve
    FROM role_permissions rp
    JOIN user_roles ur ON rp.role_id = ur.role_id
    WHERE ur.user_id = ?
  `).all(userId);

  const perms = {};
  for (const r of rows) {
    if (!perms[r.module]) {
      perms[r.module] = { can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0 };
    }
    // Merge permissions (if user has multiple roles, take highest privilege)
    perms[r.module].can_view = perms[r.module].can_view || r.can_view;
    perms[r.module].can_create = perms[r.module].can_create || r.can_create;
    perms[r.module].can_edit = perms[r.module].can_edit || r.can_edit;
    perms[r.module].can_delete = perms[r.module].can_delete || r.can_delete;
    perms[r.module].can_approve = perms[r.module].can_approve || r.can_approve;
  }
  return perms;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    SECRET,
    { expiresIn: '24h' }
  );
}

module.exports = { authMiddleware, adminOnly, requirePermission, getUserPermissions, generateToken, SECRET };
