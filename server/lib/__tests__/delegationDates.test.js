const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

test('edited dates and approved extensions share one revision count', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE delegations (
    id INTEGER PRIMARY KEY, assigned_by INTEGER, due_date TEXT, extension_count INTEGER DEFAULT 0,
    description TEXT, title TEXT, status TEXT, requested_due_date TEXT, extension_status TEXT,
    extension_reviewed_at TEXT, extension_reviewed_by INTEGER
  ); INSERT INTO delegations(id, assigned_by, due_date, status) VALUES(1,1,'2026-09-17','approved');`);
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
  try {
    await call('PUT', '', { due_date: '2026-09-18' });
    assert.equal(row().extension_count, 1);
    assert.equal(row().status, 'approved');
    await call('PUT', '', { due_date: '2026-09-18', description: 'Same date' });
    assert.equal(row().extension_count, 1);
    db.prepare("UPDATE delegations SET requested_due_date=?, extension_status='pending'").run('2026-09-20');
    await call('POST', '/approve-extension', {});
    assert.equal(row().extension_count, 2);
    assert.equal(row().due_date, '2026-09-20');
    db.prepare("UPDATE delegations SET extension_status='pending'").run();
    await call('POST', '/approve-extension', {});
    assert.equal(row().extension_count, 2, 'same date approval must not count twice');
    await call('PUT', '', { due_date: '2026-09-19' });
    assert.equal(row().extension_count, 3, 'an earlier replacement date also counts');
    db.prepare('UPDATE delegations SET due_date=NULL, extension_count=0').run();
    await call('PUT', '', { due_date: '2026-09-21' });
    assert.equal(row().extension_count, 0, 'first date is not a revision');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
