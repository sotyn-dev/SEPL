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
db.prepare(`INSERT INTO dispatch_receiving (site_name,indent_id,bill_number,receiving_url,created_by)
  VALUES (?,?,?,?,?)`).run('Site A',1,'B-1','/uploads/proof.pdf',1);
assert.equal(db.prepare('SELECT bill_number FROM dispatch_receiving').get().bill_number,'B-1');
db.close();
console.log('Dispatch receiving: unique sites, indent filtering and persistence checks passed');
