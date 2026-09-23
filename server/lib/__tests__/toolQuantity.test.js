const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.pragma('foreign_keys = OFF');
const schema = fs.readFileSync(path.join(__dirname, '../../db/schema.js'), 'utf8');
// Start with the previous tools schema to exercise upgrading existing rows.
db.exec(schema.match(/CREATE TABLE IF NOT EXISTS tools \([\s\S]*?\n    \);/)[0]
  .replace('quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0),', '')
  .replace('unit TEXT,', ''));
db.exec(`CREATE TABLE item_master (id INTEGER PRIMARY KEY, item_name TEXT, department TEXT, current_price REAL, type TEXT, uom TEXT);
  INSERT INTO item_master VALUES (1, 'Drill bits', 'Electrical', 123, 'RGP', 'SET');
  INSERT INTO tools (tool_code, name) VALUES ('OLD-1', 'Legacy tool');`);
let sequence = 0;
function loadRoutes() {
  const routes = {};
  const router = { use() {}, get() {}, delete() {}, post(url, ...handlers) { routes['POST ' + url] = handlers.at(-1); }, put(url, ...handlers) { routes['PUT ' + url] = handlers.at(-1); } };
  const mocks = {
    express: { Router: () => router },
    '../db/schema': { getDb: () => db },
    '../lib/statusFilter': {},
    '../middleware/auth': { requirePermission: () => () => {} },
    '../db/nextSequence': { nextSequence: () => 'TEST-' + (++sequence) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../routes/tools.js'), 'utf8'), {
    require: key => { assert.ok(key in mocks, key); return mocks[key]; }, module: {}, console,
  });
  return routes;
}
const routes = loadRoutes();
loadRoutes(); // Deployment migration must be repeatable.
assert.equal(db.prepare('SELECT quantity FROM tools WHERE id=1').get().quantity, 1);
function call(key, body, id) {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  routes[key]({ body, params: { id }, user: { id: 1 } }, res);
  return res;
}
const added = call('POST /', { item_master_id: 1, quantity: 12 });
assert.equal(added.code, 201, JSON.stringify(added.data));
const id = added.data.id;
assert.deepEqual(db.prepare('SELECT quantity, unit FROM tools WHERE id=?').get(id), { quantity: 12, unit: 'SET' });
assert.equal(call('PUT /:id', { quantity: '2.5', unit: ' MTR ' }, id).code, 200);
assert.deepEqual(db.prepare('SELECT quantity, unit FROM tools WHERE id=?').get(id), { quantity: 2.5, unit: 'MTR' });
for (const quantity of [0, -1, '', null, 'abc', 'Infinity', true]) {
  assert.equal(call('POST /', { item_master_id: 1, quantity }).code, 400);
  assert.equal(call('PUT /:id', { quantity }, id).code, 400);
}
for (const unit of ['', '  ', null, 'x'.repeat(31)]) {
  assert.equal(call('PUT /:id', { unit }, id).code, 400);
}
assert.equal(call('PUT /:id', { notes: 'Photo review', item_master_id: null }, 1).code, 200);
assert.equal(db.prepare('SELECT quantity FROM tools WHERE id=1').get().quantity, 1);
db.close();
console.log('Tool quantity migration, create/update persistence and validation passed');
