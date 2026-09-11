const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { initialize } = require('../dispatchReceiving');
const db = new Database(':memory:');
db.exec(`CREATE TABLE business_book(id INTEGER, project_name TEXT, company_name TEXT, client_name TEXT);
  CREATE TABLE sites(id INTEGER PRIMARY KEY, name TEXT, business_book_id INTEGER);
  CREATE TABLE order_planning(id INTEGER, business_book_id INTEGER);
  CREATE TABLE indents(id INTEGER PRIMARY KEY, planning_id INTEGER, site_name TEXT, indent_number TEXT);
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, role TEXT, active INTEGER);
  CREATE TABLE notifications(id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, title TEXT, body TEXT, link_url TEXT, channel_sent TEXT, dedupe_key TEXT, read_at TEXT, created_at TEXT);
  INSERT INTO business_book VALUES(1,'Site A',NULL,NULL),(2,'Site B',NULL,NULL),(3,'','CONSERN PHARMA',NULL);
  INSERT INTO order_planning VALUES(1,1),(2,2);
  INSERT INTO indents VALUES(1,1,'Site A','IND-1'),(2,2,'Site B','IND-2');
  INSERT INTO users VALUES(1,'Ajmer','engineer',1),(2,'Lovely Sharma','crm',1),(9,'Boss','admin',1);`);
initialize(db);
function stub(module, exports) { require.cache[require.resolve(module)] = { exports }; }
const USERS = { 1: { id: 1, name: 'Ajmer', role: 'engineer' }, 2: { id: 2, name: 'Lovely Sharma', role: 'crm' }, 9: { id: 9, name: 'Boss', role: 'admin' } };
stub('../../db/schema', { getDb: () => db });
stub('../../middleware/auth', {
  authMiddleware: (req, res, next) => { req.user = USERS[req.headers['x-user'] || 1]; next(); },
  requirePermission: () => (req, res, next) => next(),
});
stub('../storage', { exists: async key => key === 'proof.pdf' || key === 'proof2.pdf' });
const app = express(); app.use(express.json());
app.use('/receiving', require('../../routes/dispatchReceiving'));
const server = app.listen(0, '127.0.0.1', async () => {
  try {
    const url = `http://127.0.0.1:${server.address().port}/receiving`;
    const call = (method, path, body, user = 1) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': String(user) }, body: body ? JSON.stringify(body) : undefined });
    const list = async (user = 1) => (await call('GET', '')).json().then(rows => rows) && (await (await call('GET', '', null, user)).json());
    const good = { site: 'site a', indent_number: ' ind-1 ', bill_number: ' BILL-1 ', receiving_url: '/uploads/proof.pdf' };

    // Sites: company-only lead is listed.
    const siteLabels = (await (await call('GET', '/sites')).json()).map(s => s.label);
    assert.ok(siteLabels.includes('CONSERN PHARMA'), siteLabels.join(','));

    // Add: mandatory fields + proof validation (unchanged rules).
    for (const field of Object.keys(good)) {
      const missing = { ...good }; delete missing[field];
      assert.equal((await call('POST', '', missing)).status, 400, field);
    }
    assert.equal((await call('POST', '', { ...good, indent_number: ' ' })).status, 400);
    assert.equal((await call('POST', '', { ...good, indent_number: 'X'.repeat(101) })).status, 400);
    assert.equal((await call('POST', '', { ...good, bill_number: ' ' })).status, 400);
    assert.equal((await call('POST', '', { ...good, receiving_url: '/uploads/missing.pdf' })).status, 400);
    assert.equal((await call('POST', '', { ...good, receiving_url: '/uploads/../proof.pdf' })).status, 400);
    const created = await call('POST', '', good);
    assert.equal(created.status, 201);
    const id = (await created.json()).id;
    // Typed by hand: a number that isn't one of this site's indents still saves, just unlinked.
    assert.equal((await call('POST', '', { ...good, indent_number: 'IND-2', bill_number: 'BILL-2' })).status, 201);

    // Lovely is told about each new receiving.
    assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=2 AND type='dispatch_receiving'").get().c, 2);

    let rows = await list(1);
    assert.equal(rows.length, 2);
    const [typed, matched] = rows;                       // newest first
    assert.equal(matched.bill_number, 'BILL-1'); assert.equal(matched.indent_number, 'ind-1'); assert.equal(matched.indent_id, 1);
    assert.equal(typed.indent_number, 'IND-2'); assert.equal(typed.indent_id, null);
    assert.equal(matched.status, 'pending');
    assert.equal(matched.can_approve, false);             // the engineer can't approve
    assert.equal(matched.approver_names, 'Lovely Sharma');
    assert.equal((await list(2)).find(r => r.id === id).can_approve, true);

    // Only Lovely / admin approve.
    assert.equal((await call('POST', `/${id}/approve`, {}, 1)).status, 403);
    assert.equal((await call('POST', `/${id}/approve`, {}, 2)).status, 200);
    assert.equal((await call('POST', `/${id}/approve`, {}, 2)).status, 409);  // already approved
    rows = await list(2);
    const approved = rows.find(r => r.id === id);
    assert.equal(approved.status, 'approved'); assert.equal(approved.approved_by_name, 'Lovely Sharma'); assert.equal(approved.can_approve, false);

    // Edit: validation, keeps file when none sent, goes back to pending.
    assert.equal((await call('PUT', `/${id}`, { site: 'site a', indent_number: '', bill_number: 'B' })).status, 400);
    assert.equal((await call('PUT', '/999', { site: 'site a', indent_number: 'IND-1', bill_number: 'B' })).status, 404);
    const edit = await call('PUT', `/${id}`, { site: 'consern pharma', indent_number: 'IND-9', bill_number: 'BILL-1B' });
    assert.equal(edit.status, 200);
    let row = db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(id);
    assert.equal(row.site_name, 'CONSERN PHARMA'); assert.equal(row.bill_number, 'BILL-1B'); assert.equal(row.receiving_url, '/uploads/proof.pdf');
    assert.equal(row.status, 'pending'); assert.equal(row.approved_by, null); assert.equal(row.updated_by, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=2").get().c, 3);
    assert.equal((await call('PUT', `/${id}`, { site: 'site a', indent_number: 'IND-1', bill_number: 'B', receiving_url: '/uploads/nope.pdf' })).status, 400);
    assert.equal((await call('PUT', `/${id}`, { site: 'site a', indent_number: 'IND-1', bill_number: 'B', receiving_url: '/uploads/proof2.pdf' })).status, 200);
    assert.equal(db.prepare('SELECT receiving_url FROM dispatch_receiving WHERE id=?').get(id).receiving_url, '/uploads/proof2.pdf');

    // Reject needs a reason; admin can stand in.
    assert.equal((await call('POST', `/${id}/reject`, {}, 9)).status, 400);
    assert.equal((await call('POST', `/${id}/reject`, { reason: 'Wrong bill photo' }, 9)).status, 200);
    row = db.prepare('SELECT status, rejected_reason, approved_by FROM dispatch_receiving WHERE id=?').get(id);
    assert.deepEqual({ ...row }, { status: 'rejected', rejected_reason: 'Wrong bill photo', approved_by: 9 });

    console.log('Receiving API checks passed: add + proof rules, all sites, Lovely notified, approve/reject gate + reason, edit resets to pending and keeps/replaces the file');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); db.close(); }
});
