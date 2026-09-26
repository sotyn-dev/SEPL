// Synthetic, in-memory database only. Used by regression tests and local demo.
const path = require('node:path');
const fs = require('node:fs');
function fixture() {
  process.env.ERP_DB_PATH = ':memory:';
  const originalWrite = fs.writeFileSync;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  let db;
  try {
    // Fresh-install recovery files are irrelevant to an in-memory test.
    fs.writeFileSync = (file, ...args) => path.basename(String(file)) === 'RECOVERY.txt' ? undefined : originalWrite(file, ...args);
    console.log = console.warn = console.error = () => {};
    const schema = require('../../../db/schema');
    schema.initializeDatabase();
    db = schema.getDb();
  } finally {
    fs.writeFileSync = originalWrite;
    console.log = originalLog; console.warn = originalWarn; console.error = originalError;
  }
  const stub = (name, exports) => { const p = require.resolve(name); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../../../lib/emailRules', { fireEmailEvent: () => {} });
  let today = '2026-09-28';
  const dates = require('../../../lib/istDate');
  stub('../../../lib/istDate', { ...dates, istToday: () => today });
  const permissions = { procurement: { can_view: 1, can_create: 1, can_edit: 0, can_approve: 0 } };
  const auth = (req, res, next) => {
    const id = Number(req.headers['x-demo-user'] || String(req.headers.authorization || '').split('-').pop()) || 9001;
    req.user = db.prepare('SELECT id,name,role,approval_role,email FROM users WHERE id=?').get(id);
    if (!req.user) return res.status(401).json({ error: 'Unknown dummy user' });
    next();
  };
  stub('../../../middleware/auth', { authMiddleware: auth, requirePermission: () => auth, adminOnly: auth, getUserPermissions: () => permissions });
  const users = [
    [9001, 'Naveen (Demo reviewer)', 'naveen-demo', 'user', 'l1'],
    [9002, 'Site Engineer A (Demo raiser)', 'engineer-demo', 'user', null],
    [9003, 'Other Engineer (Demo)', 'other-demo', 'user', null],
    [9004, 'Admin (Demo)', 'admin-demo', 'admin', null],
  ];
  db.prepare("INSERT INTO item_master(id,item_code,item_name,uom,type,current_price) VALUES (90001,'DEMO-DRILL','Demo drill','nos','RGP',2500)").run();
  for (const [id, name, username, role, approval] of users) db.prepare(`INSERT INTO users (id,name,email,username,password,role,active,approval_role) VALUES (?,?,?,?,?,?,1,?)`)
    .run(id, name, `${username}@example.invalid`, username, 'LOCAL_DEMO_NO_REAL_PASSWORD', role, approval);
  db.prepare("DELETE FROM indent_to_dispatch_setting_users WHERE key='approval.l1.users'").run();
  db.prepare("INSERT INTO indent_to_dispatch_setting_users(key,user_id) VALUES ('approval.l1.users',9001)").run();
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('indent_emergency_date',?)").run(today);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/procurement', require('../../../routes/procurement'));
  app.use('/api/indent-fms', require('../../../routes/indentfms'));
  app.use('/api/dashboards', require('../../../routes/dashboards'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return { app, db, users, permissions, auth, setToday: date => { today = date; db.prepare("UPDATE app_settings SET value=? WHERE key='indent_emergency_date'").run(date); } };
}
module.exports = { fixture };
