const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

test('delegation proof submission handles single, multiple, and paste proofs', async (t) => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE delegations (
    id INTEGER PRIMARY KEY, assigned_by INTEGER, assigned_to INTEGER, due_date TEXT, extension_count INTEGER DEFAULT 0,
    description TEXT, title TEXT, status TEXT, proof_url TEXT, proof_remarks TEXT, submitted_at TEXT, reject_reason TEXT,
    requested_due_date TEXT, extension_status TEXT, extension_reason TEXT, extension_reviewed_at TEXT, extension_reviewed_by INTEGER
  ); INSERT INTO delegations(id, assigned_by, assigned_to, due_date, status) VALUES(1, 1, 1, '2026-10-28', 'pending');`);

  const stub = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
  stub('../../db/schema', { getDb: () => db });
  stub('../../middleware/auth', {
    authMiddleware: (req, res, next) => {
      req.user = { id: 1, role: 'admin' };
      next();
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/delegations', require('../../routes/delegations'));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/delegations/1`;

  const submitCall = async (body) => {
    const response = await fetch(`${baseUrl}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  const getTask = () => db.prepare('SELECT * FROM delegations WHERE id=1').get();

  try {
    await t.test('submits single proof_url as a simple string for backwards compatibility', async () => {
      const res = await submitCall({ proof_url: '/uploads/single.png', proof_remarks: 'Single image proof' });
      assert.equal(res.status, 200);
      assert.match(res.data.message, /proof submitted/i);
      const row = getTask();
      assert.equal(row.status, 'submitted');
      assert.equal(row.proof_url, '/uploads/single.png');
      assert.equal(row.proof_remarks, 'Single image proof');
    });

    await t.test('submits multiple proof_urls as JSON array string', async () => {
      const urls = ['/uploads/img1.png', '/uploads/img2.jpg', '/uploads/doc3.pdf'];
      const res = await submitCall({ proof_urls: urls, proof_remarks: 'Multi-image and doc proof' });
      assert.equal(res.status, 200);
      assert.match(res.data.message, /proof submitted/i);
      const row = getTask();
      assert.equal(row.status, 'submitted');
      assert.equal(row.proof_url, JSON.stringify(urls));
      assert.equal(row.proof_remarks, 'Multi-image and doc proof');
    });

    await t.test('single item in proof_urls array normalizes to single URL string', async () => {
      const res = await submitCall({ proof_urls: ['/uploads/only-one.png'] });
      assert.equal(res.status, 200);
      const row = getTask();
      assert.equal(row.proof_url, '/uploads/only-one.png');
    });

    await t.test('requires at least one proof_url or proof_urls item', async () => {
      const res = await submitCall({ proof_urls: [] });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /proof.*required/i);
    });
  } finally {
    server.close();
    db.close();
  }
});
