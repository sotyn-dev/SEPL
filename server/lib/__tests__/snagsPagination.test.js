const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT, site_engineer_id INTEGER, supervisor_id INTEGER, supervisor TEXT, po_id INTEGER);
  CREATE TABLE snags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snag_no TEXT UNIQUE,
    site_id INTEGER,
    site_name TEXT,
    location TEXT,
    description TEXT,
    photo_url TEXT,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open',
    assigned_to INTEGER,
    assigned_to_name TEXT,
    raised_by INTEGER,
    target_date TEXT,
    proof_url TEXT,
    proof_notes TEXT,
    proof_submitted_at TEXT,
    proof_submitted_by INTEGER,
    approved_by INTEGER,
    approved_at TEXT,
    reject_reason TEXT,
    rejected_at TEXT,
    raised_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO users VALUES (1, 'Admin User'), (2, 'Site Engineer 1'), (3, 'Worker 1');
  INSERT INTO sites VALUES (10, 'Site Alpha', 2, NULL, NULL, NULL), (20, 'Site Beta', 2, NULL, NULL, NULL);

  INSERT INTO snags (id, snag_no, site_id, site_name, location, description, priority, status, assigned_to, raised_by, target_date, raised_at) VALUES
  (1, 'SNAG-2026-0001', 10, 'Site Alpha', 'Floor 1', 'Loose cable termination', 'high', 'open', 3, 1, '2026-09-25', datetime('now', '-4 days')),
  (2, 'SNAG-2026-0002', 10, 'Site Alpha', 'Floor 2', 'Pipe clamp loose', 'medium', 'submitted', 3, 1, '2026-09-25', datetime('now', '-2 days')),
  (3, 'SNAG-2026-0003', 10, 'Site Alpha', 'Floor 3', 'Paint touchup needed', 'low', 'approved', 3, 1, '2026-09-20', datetime('now', '-5 days')),
  (4, 'SNAG-2026-0004', 20, 'Site Beta', 'Yard', 'Earthing missing', 'critical', 'open', 3, 1, '2026-09-26', datetime('now', '-1 days')),
  (5, 'SNAG-2026-0005', 20, 'Site Beta', 'Pump room', 'Seepage observed', 'high', 'rejected', 3, 1, '2026-09-27', datetime('now', '-4 days'));
`);

// Test stats calculation query
const statsSql = `
  SELECT
    COUNT(*) as total,
    COALESCE(SUM(CASE WHEN s.status='open' THEN 1 ELSE 0 END), 0) as open,
    COALESCE(SUM(CASE WHEN s.status='submitted' THEN 1 ELSE 0 END), 0) as submitted,
    COALESCE(SUM(CASE WHEN s.status='approved' THEN 1 ELSE 0 END), 0) as approved,
    COALESCE(SUM(CASE WHEN s.status='rejected' THEN 1 ELSE 0 END), 0) as rejected,
    COALESCE(SUM(CASE WHEN s.priority='critical' AND s.status != 'approved' THEN 1 ELSE 0 END), 0) as critical,
    COALESCE(SUM(CASE WHEN s.status != 'approved' AND (julianday('now') - julianday(s.raised_at)) * 24 >= 72 THEN 1 ELSE 0 END), 0) as overdue
  FROM snags s
  WHERE 1=1
`;
const stats = db.prepare(statsSql).get();
assert.equal(stats.total, 5);
assert.equal(stats.open, 2);
assert.equal(stats.submitted, 1);
assert.equal(stats.approved, 1);
assert.equal(stats.rejected, 1);
assert.equal(stats.critical, 1);
// Snag 1 (-4 days, open) and Snag 5 (-4 days, rejected) are > 72h overdue. Snag 3 is approved, so not overdue.
assert.equal(stats.overdue, 2);

// Test pagination query
const limit = 2;
const offset = 0;
const pagedRows = db.prepare(`SELECT * FROM snags ORDER BY id ASC LIMIT ? OFFSET ?`).all(limit, offset);
assert.equal(pagedRows.length, 2);
assert.equal(pagedRows[0].id, 1);
assert.equal(pagedRows[1].id, 2);

const page2Rows = db.prepare(`SELECT * FROM snags ORDER BY id ASC LIMIT ? OFFSET ?`).all(limit, 2);
assert.equal(page2Rows.length, 2);
assert.equal(page2Rows[0].id, 3);
assert.equal(page2Rows[1].id, 4);

db.close();
console.log('Snags pagination & stats test passed successfully!');
