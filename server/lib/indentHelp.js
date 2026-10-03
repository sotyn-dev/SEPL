// This workflow belongs only to Procurement. It never writes support_tickets.
const STAGES = ['Indent approval', 'Store issue', 'Vendor rates', 'Vendor PO', 'Payment', 'Purchase bill', 'Tally bill', 'Dispatch', 'Receiving', 'Other'];
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS indent_help (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indent_id INTEGER NOT NULL REFERENCES indents(id),
    raised_by INTEGER NOT NULL REFERENCES users(id),
    assigned_to INTEGER NOT NULL REFERENCES users(id),
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    stage TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
    request_id TEXT NOT NULL,
    completion_note TEXT,
    completed_by INTEGER REFERENCES users(id),
    completed_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(raised_by, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_indent_help_indent ON indent_help(indent_id);
  CREATE INDEX IF NOT EXISTS idx_indent_help_assigned ON indent_help(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_indent_help_raised ON indent_help(raised_by);`);
}
function canAccess(db, id) {
  return !!db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND COALESCE(u.active,1)=1
    AND (u.role='admin' OR EXISTS (SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id=ur.role_id
      WHERE ur.user_id=u.id AND rp.module='procurement' AND rp.can_view=1))`).get(id);
}
module.exports = { initialize, canAccess, STAGES };
