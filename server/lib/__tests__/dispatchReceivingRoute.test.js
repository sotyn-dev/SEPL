const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { initialize } = require('../dispatchReceiving');
const db = new Database(':memory:');
db.exec(`CREATE TABLE business_book(id INTEGER, project_name TEXT);
  CREATE TABLE order_planning(id INTEGER, business_book_id INTEGER);
  CREATE TABLE indents(id INTEGER PRIMARY KEY, planning_id INTEGER, site_name TEXT, indent_number TEXT);
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO business_book VALUES(1,'Site A'),(2,'Site B');
  INSERT INTO order_planning VALUES(1,1),(2,2);
  INSERT INTO indents VALUES(1,1,'Site A','IND-1'),(2,2,'Site B','IND-2');
  INSERT INTO users VALUES(1,'Test User');`);
initialize(db);
function stub(module, exports) { require.cache[require.resolve(module)] = { exports }; }
stub('../../db/schema', { getDb: () => db });
stub('../../middleware/auth', {
  authMiddleware: (req, res, next) => { req.user = { id: 1 }; next(); },
  requirePermission: () => (req, res, next) => next(),
});
stub('../storage', { exists: async key => key === 'proof.pdf' });
const app = express(); app.use(express.json());
app.use('/receiving', require('../../routes/dispatchReceiving'));
const server = app.listen(0, '127.0.0.1', async () => {
  try {
    const url = `http://127.0.0.1:${server.address().port}/receiving`;
    const good = { site: 'site a', indent_id: 1, bill_number: ' BILL-1 ', receiving_url: '/uploads/proof.pdf' };
    const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const field of Object.keys(good)) {
      const missing = { ...good }; delete missing[field];
      assert.equal((await post(missing)).status, 400, field);
    }
    assert.equal((await post({ ...good, indent_id: 2 })).status, 400);
    assert.equal((await post({ ...good, bill_number: ' ' })).status, 400);
    assert.equal((await post({ ...good, receiving_url: '/uploads/missing.pdf' })).status, 400);
    assert.equal((await post({ ...good, receiving_url: '/uploads/../proof.pdf' })).status, 400);
    assert.equal((await post(good)).status, 201);
    const entries = await (await fetch(url)).json();
    assert.equal(entries.length, 1); assert.equal(entries[0].bill_number, 'BILL-1');
    assert.equal(entries[0].indent_number, 'IND-1');
    console.log('Receiving API checks passed: all mandatory fields, site mismatch, proof validation, save and read');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); db.close(); }
});
