const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initialize, sites, indentsForSite } = require('../dispatchReceiving');
const db = new Database(':memory:');
db.exec(`CREATE TABLE business_book(id INTEGER, project_name TEXT);
  CREATE TABLE order_planning(id INTEGER, business_book_id INTEGER);
  CREATE TABLE indents(id INTEGER PRIMARY KEY, planning_id INTEGER, site_name TEXT, indent_number TEXT);
  CREATE TABLE users(id INTEGER PRIMARY KEY);
  INSERT INTO business_book VALUES (1,'Site A'),(2,' site a '),(3,'Site B'),(4,'');
  INSERT INTO order_planning VALUES (1,1),(2,2),(3,3);
  INSERT INTO indents VALUES (1,1,'Site A','IND-1'),(2,2,'site a','IND-2'),
    (3,3,'Site A','IND-3'),(4,NULL,' Site A ','IND-4');
  INSERT INTO users VALUES(1);`);
initialize(db); initialize(db);
assert.equal(sites(db).length, 2);
assert.deepEqual(indentsForSite(db,'SITE A').map(i => i.id), [4,2,1]);
assert.deepEqual(indentsForSite(db,'Site B').map(i => i.id), [3]);
assert.deepEqual(indentsForSite(db,'missing'), []);
assert.throws(() => db.prepare('INSERT INTO dispatch_receiving (site_name) VALUES (?)').run('Site A'));
// Indent No. is typed by hand, so a row needs the text but not an indent link.
db.prepare(`INSERT INTO dispatch_receiving (site_name,indent_id,indent_number,bill_number,receiving_url,created_by)
  VALUES (?,?,?,?,?,?)`).run('Site A',null,'MANUAL-7','B-1','/uploads/proof.pdf',1);
assert.deepEqual({ ...db.prepare('SELECT indent_id,indent_number,bill_number FROM dispatch_receiving').get() },
  { indent_id: null, indent_number: 'MANUAL-7', bill_number: 'B-1' });
assert.throws(() => db.prepare(`INSERT INTO dispatch_receiving (site_name,bill_number,receiving_url,created_by)
  VALUES ('Site A','B-2','/uploads/p.pdf',1)`).run(), /indent_number/);
db.close();

// A table from the first version (indent_id NOT NULL, no text column) is
// rebuilt once, keeping every row and its indent number.
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
assert.deepEqual(old.prepare('SELECT id,site_name,indent_id,indent_number,bill_number,receiving_url,created_by,created_at FROM dispatch_receiving').all().map(r => ({ ...r })),
  [{ id: 1, site_name: 'Site A', indent_id: 9, indent_number: 'IND-9', bill_number: 'B-9', receiving_url: '/uploads/p.pdf', created_by: 1, created_at: '2026-09-10 05:00:00' }]);
old.prepare(`INSERT INTO dispatch_receiving (site_name,indent_number,bill_number,receiving_url,created_by)
  VALUES ('Site A','TYPED-1','B-10','/uploads/q.pdf',1)`).run();
assert.equal(old.prepare('SELECT COUNT(*) c FROM dispatch_receiving').get().c, 2);
old.close();
console.log('Dispatch receiving: unique sites, indent filtering and persistence checks passed');
