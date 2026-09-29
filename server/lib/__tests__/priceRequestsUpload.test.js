const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb, initializeDatabase } = require('../../db/schema');
const { getSecret } = require('../../middleware/auth');

describe('Price Requests Attachment & Sheet URL', () => {
  let server;
  let baseUrl;
  let authHeader;

  before(async () => {
    initializeDatabase();

    const token = jwt.sign({ id: 1, name: 'Admin User', role: 'admin', email: 'admin@example.com' }, getSecret());
    authHeader = { 'Authorization': `Bearer ${token}` };

    const app = express();
    app.use(express.json());
    app.use('/api/price-requests', require('../../routes/pricerequests'));

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/price-requests`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  test('POST / with JSON and sheet_url', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_name: 'Test Site',
        item_name: 'SS Ball Valve 50mm',
        size: '50mm',
        specification: 'SS 316',
        department: 'FIRE FIGHTING',
        sheet_url: 'https://docs.google.com/spreadsheets/d/123456789/edit',
        notes: 'Urgent for fire line',
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert(body.id > 0);

    const db = getDb();
    const row = db.prepare('SELECT * FROM price_requests WHERE id=?').get(body.id);
    assert.equal(row.item_name, 'SS Ball Valve 50mm');
    assert.equal(row.department, 'FIRE FIGHTING');
    assert.equal(row.sheet_url, 'https://docs.google.com/spreadsheets/d/123456789/edit');
    assert.equal(row.attachment_url, null);
  });

  test('POST / with multipart FormData file attachment and sheet_url', async () => {
    const form = new FormData();
    form.append('item_name', 'Fire Sprinkler Head Pendent');
    form.append('department', 'FIRE FIGHTING');
    form.append('sheet_url', 'https://docs.google.com/spreadsheets/d/sprinklers');
    form.append('notes', 'Attached BOQ CSV');
    form.append('file', new Blob(['item,qty,price\nval1,10,100\n'], { type: 'text/csv' }), 'test-doc.csv');

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: authHeader,
      body: form,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert(body.id > 0);

    const db = getDb();
    const row = db.prepare('SELECT * FROM price_requests WHERE id=?').get(body.id);
    assert.equal(row.item_name, 'Fire Sprinkler Head Pendent');
    assert.equal(row.sheet_url, 'https://docs.google.com/spreadsheets/d/sprinklers');
    assert(row.attachment_url && row.attachment_url.startsWith('/uploads/'));
    assert.equal(row.attachment_name, 'test-doc.csv');
  });

  test('GET /grouped includes sheet_urls and attachments', async () => {
    const res = await fetch(`${baseUrl}/grouped`, {
      headers: authHeader,
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert(Array.isArray(list));

    const item = list.find(i => i.item_name === 'Fire Sprinkler Head Pendent');
    assert(item, 'Item should be present in grouped response');
    assert(Array.isArray(item.sheet_urls));
    assert(item.sheet_urls.includes('https://docs.google.com/spreadsheets/d/sprinklers'));
    assert(Array.isArray(item.attachments));
    assert(item.attachments.some(a => a.name === 'test-doc.csv'));
  });

  test('PUT /:id can update sheet_url and remove attachment', async () => {
    const db = getDb();
    const created = db.prepare(`
      INSERT INTO price_requests (site_name, item_name, department, sheet_url, attachment_url, attachment_name, raised_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Site B', 'Air Release Valve', 'CIVIL', 'https://old.link', '/uploads/fake.pdf', 'fake.pdf', 1);

    const updateRes = await fetch(`${baseUrl}/${created.lastInsertRowid}`, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_name: 'Air Release Valve Updated',
        department: 'CIVIL',
        sheet_url: 'https://new.link',
        remove_attachment: true,
      }),
    });

    assert.equal(updateRes.status, 200);

    const updated = db.prepare('SELECT * FROM price_requests WHERE id=?').get(created.lastInsertRowid);
    assert.equal(updated.item_name, 'Air Release Valve Updated');
    assert.equal(updated.sheet_url, 'https://new.link');
    assert.equal(updated.attachment_url, null);
    assert.equal(updated.attachment_name, null);
  });
});
