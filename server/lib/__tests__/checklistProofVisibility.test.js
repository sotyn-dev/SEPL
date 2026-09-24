const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`CREATE TABLE checklists(id INTEGER PRIMARY KEY, assigned_to INTEGER);
CREATE TABLE checklist_completions(id INTEGER PRIMARY KEY, checklist_id INTEGER, user_id INTEGER, completion_date TEXT, proof_url TEXT, submitted_at TEXT);
INSERT INTO checklists VALUES(160, 2);
INSERT INTO checklist_completions VALUES(1,160,1,'2026-09-18','/proof/admin.jpg','2026-09-18 10:00:00');`);
const row = db.prepare(`SELECT c.id, comp.id completion_id, comp.proof_url, comp.user_id
 FROM checklists c LEFT JOIN checklist_completions comp ON comp.id=(
   SELECT cc.id FROM checklist_completions cc
    WHERE cc.checklist_id=c.id AND cc.completion_date=?
    ORDER BY cc.submitted_at DESC, cc.id DESC LIMIT 1)
 WHERE c.id=?`).get('2026-09-18', 160);
assert.equal(row.completion_id, 1, 'proof uploaded by an admin must appear for the assigned employee');
assert.equal(row.proof_url, '/proof/admin.jpg');
db.exec(`INSERT INTO checklist_completions VALUES(2,160,2,'2026-09-18','/proof/employee.jpg','2026-09-18 11:00:00')`);
const latest = db.prepare(`SELECT comp.id, comp.proof_url FROM checklists c LEFT JOIN checklist_completions comp ON comp.id=(
 SELECT cc.id FROM checklist_completions cc WHERE cc.checklist_id=c.id AND cc.completion_date=? ORDER BY cc.submitted_at DESC,cc.id DESC LIMIT 1) WHERE c.id=?`).get('2026-09-18',160);
assert.equal(latest.id, 2);
assert.equal(latest.proof_url, '/proof/employee.jpg');
db.close();
console.log('Checklist proof visibility checks passed');
