const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initialize, sites, indentsForSite, receivingApprovers, canApproveReceiving } = require('../dispatchReceiving');
const db = new Database(':memory:');
db.exec(`CREATE TABLE business_book(id INTEGER, project_name TEXT, company_name TEXT, client_name TEXT);
  CREATE TABLE sites(id INTEGER PRIMARY KEY, name TEXT, business_book_id INTEGER);
  CREATE TABLE order_planning(id INTEGER, business_book_id INTEGER);
  CREATE TABLE indents(id INTEGER PRIMARY KEY, planning_id INTEGER, site_name TEXT, indent_number TEXT);
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, role TEXT, active INTEGER);
  INSERT INTO business_book VALUES (1,'Site A',NULL,NULL),(2,' site a ',NULL,NULL),(3,'Site B',NULL,NULL),
    (4,'','CONSERN PHARMA','Seema'),(5,NULL,NULL,'Only Client'),(6,'','','');
  INSERT INTO sites VALUES (1,'Site A',1),(2,'Coral Papers',NULL);
  INSERT INTO order_planning VALUES (1,1),(2,2),(3,3),(4,4);
  INSERT INTO indents VALUES (1,1,'Site A','IND-1'),(2,2,'site a','IND-2'),
    (3,3,'Site A','IND-3'),(4,NULL,' Site A ','IND-4'),(5,4,'x','IND-5');
  INSERT INTO users VALUES (1,'Ajmer','engineer',1),(2,'Lovely Sharma','crm',1),(3,'Lovely Old','crm',0),(9,'Boss','admin',1);`);
initialize(db); initialize(db);

// Every lead by project → company → client, plus DPR sites; one entry per name.
assert.deepEqual(sites(db).map(s => s.label), ['CONSERN PHARMA', 'Coral Papers', 'Only Client', 'Site A', 'Site B']);
assert.deepEqual(indentsForSite(db,'SITE A').map(i => i.id), [4,2,1]);
assert.deepEqual(indentsForSite(db,'Site B').map(i => i.id), [3]);
assert.deepEqual(indentsForSite(db,'consern pharma').map(i => i.id), [5]);   // company-only lead
assert.deepEqual(indentsForSite(db,'missing'), []);

// Lovely approves; an inactive Lovely does not; admin can stand in.
assert.deepEqual(receivingApprovers(db).map(u => u.id), [2]);
assert.equal(canApproveReceiving(db, { id: 2, role: 'crm' }), true);
assert.equal(canApproveReceiving(db, { id: 3, role: 'crm' }), false);
assert.equal(canApproveReceiving(db, { id: 1, role: 'engineer' }), false);
assert.equal(canApproveReceiving(db, { id: 9, role: 'admin' }), true);

// Indent No. is typed by hand, so a row needs the text but not an indent link.
assert.throws(() => db.prepare('INSERT INTO dispatch_receiving (site_name) VALUES (?)').run('Site A'));
db.prepare(`INSERT INTO dispatch_receiving (site_name,indent_id,indent_number,bill_number,receiving_url,created_by)
  VALUES (?,?,?,?,?,?)`).run('Site A',null,'MANUAL-7','B-1','/uploads/proof.pdf',1);
assert.deepEqual({ ...db.prepare('SELECT indent_id,indent_number,bill_number,status,approved_by FROM dispatch_receiving').get() },
  { indent_id: null, indent_number: 'MANUAL-7', bill_number: 'B-1', status: 'pending', approved_by: null });
db.close();

// A table from the first version (indent_id NOT NULL, no text column, no
// approval columns) keeps every row, gains the indent number, and starts pending.
const old = new Database(':memory:');
old.exec(`CREATE TABLE indents(id INTEGER PRIMARY KEY, planning_id INTEGER, site_name TEXT, indent_number TEXT);
  CREATE TABLE users(id INTEGER PRIMARY KEY);
  INSERT INTO indents VALUES (9,NULL,'Site A','IND-9'); INSERT INTO users VALUES (1);
  CREATE TABLE dispatch_receiving (id INTEGER PRIMARY KEY AUTOINCREMENT, site_name TEXT NOT NULL,
    indent_id INTEGER NOT NULL REFERENCES indents(id), bill_number TEXT NOT NULL, receiving_url TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  INSERT INTO dispatch_receiving (site_name,indent_id,bill_number,receiving_url,created_by,created_at)
    VALUES ('Site A',9,'B-9','/uploads/p.pdf',1,'2026-09-10 05:00:00');`);
initialize(old); initialize(old);
assert.deepEqual(old.prepare('SELECT id,site_name,indent_id,indent_number,bill_number,receiving_url,created_by,created_at,status FROM dispatch_receiving').all().map(r => ({ ...r })),
  [{ id: 1, site_name: 'Site A', indent_id: 9, indent_number: 'IND-9', bill_number: 'B-9', receiving_url: '/uploads/p.pdf', created_by: 1, created_at: '2026-09-10 05:00:00', status: 'pending' }]);
old.close();
console.log('Dispatch receiving: all sites (project/company/client + DPR), indent filtering, Lovely approver, migrations checks passed');
