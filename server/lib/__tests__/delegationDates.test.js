const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

test('only approved extensions advance the delegation date colour', async t => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE delegations (
    id INTEGER PRIMARY KEY, assigned_by INTEGER, assigned_to INTEGER, due_date TEXT, extension_count INTEGER DEFAULT 0,
    description TEXT, title TEXT, status TEXT, requested_due_date TEXT, extension_status TEXT,
    extension_reason TEXT, extension_reviewed_at TEXT, extension_reviewed_by INTEGER
  ); INSERT INTO delegations(id, assigned_by, assigned_to, due_date, status) VALUES(1,1,1,'2026-09-17','approved');`);
  const stub = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
  stub('../../db/schema', { getDb: () => db });
  stub('../../middleware/auth', { authMiddleware: (req, res, next) => {
    req.user = { id: 1, role: 'admin' }; next();
  } });
  const app = express();
  app.use(express.json());
  app.use('/delegations', require('../../routes/delegations'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = async (method, suffix, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/delegations/1${suffix}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const row = () => db.prepare('SELECT * FROM delegations WHERE id=1').get();
  const reset = (count = 0, dueDate = '2026-09-17') => db.prepare(`UPDATE delegations
    SET due_date=?, extension_count=?, status='approved', requested_due_date=NULL,
      extension_status=NULL, extension_reason=NULL, extension_reviewed_at=NULL,
      extension_reviewed_by=NULL WHERE id=1`).run(dueDate, count);
  try {
    await t.test('direct later, earlier and unchanged dates preserve every colour', async () => {
      for (const count of [0, 1, 2]) {
        reset(count);
        for (const dueDate of ['2026-09-18', '2026-09-16', '2026-09-16']) {
          await call('PUT', '', { due_date: dueDate });
          assert.equal(row().due_date, dueDate);
          assert.equal(row().extension_count, count);
          assert.equal(row().status, 'approved');
        }
      }
    });
    await t.test('clearing and restoring a date preserve every colour', async () => {
      for (const count of [0, 1, 2]) {
        reset(count);
        await call('PUT', '', { due_date: '' });
        assert.equal(row().due_date, null);
        assert.equal(row().extension_count, count);
        await call('PUT', '', { due_date: '2026-09-21' });
        assert.equal(row().due_date, '2026-09-21');
        assert.equal(row().extension_count, count);
      }
    });
    await t.test('direct edits preserve pending and reviewed extension metadata', async () => {
      for (const extensionStatus of ['pending', 'approved']) {
        reset(1);
        db.prepare(`UPDATE delegations SET requested_due_date='2026-09-20',
          extension_status=?, extension_reason='Site access delay',
          extension_reviewed_at='2026-09-16 09:00:00', extension_reviewed_by=1`).run(extensionStatus);
        const before = row();
        await call('PUT', '', { due_date: '2026-09-19' });
        const after = row();
        assert.equal(after.due_date, '2026-09-19');
        for (const field of ['extension_count', 'extension_status', 'requested_due_date',
          'extension_reason', 'extension_reviewed_at', 'extension_reviewed_by', 'status']) {
          assert.equal(after[field], before[field], field);
        }
      }
    });
    await t.test('requesting or rejecting an extension preserves date and colour', async () => {
      reset(1);
      db.prepare("UPDATE delegations SET status='pending'").run();
      await call('POST', '/request-extension', { requested_due_date: '2026-09-20', reason: 'Site access delay' });
      assert.equal(row().extension_status, 'pending');
      assert.equal(row().due_date, '2026-09-17');
      assert.equal(row().extension_count, 1);
      await call('POST', '/reject-extension', {});
      assert.equal(row().extension_status, 'rejected');
      assert.equal(row().due_date, '2026-09-17');
      assert.equal(row().extension_count, 1);
    });
    await t.test('approved extensions still advance colours without counting the same date twice', async () => {
      reset();
      db.prepare("UPDATE delegations SET status='pending'").run();
      for (const [dueDate, count] of [['2026-09-20', 1], ['2026-09-23', 2], ['2026-09-23', 2]]) {
        await call('POST', '/request-extension', { requested_due_date: dueDate, reason: 'Site access delay' });
        await call('POST', '/approve-extension', {});
        assert.equal(row().due_date, dueDate);
        assert.equal(row().extension_count, count);
        assert.equal(row().extension_status, 'approved');
      }
      reset(0, null);
      db.prepare("UPDATE delegations SET status='pending'").run();
      await call('POST', '/request-extension', { requested_due_date: '2026-09-21', reason: 'First due date' });
      await call('POST', '/approve-extension', {});
      assert.equal(row().due_date, '2026-09-21');
      assert.equal(row().extension_count, 0, 'giving the first date is not an extension');
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
