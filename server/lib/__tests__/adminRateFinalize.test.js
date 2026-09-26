const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../routes/procurement.js'), 'utf8');
const start = source.indexOf("router.post('/item-rates/:id/finalize'");
const end = source.indexOf('// The Item Master price', start);
let handler;
let quotes;
let block;
let saved;
const db = { prepare(sql) {
  if (sql.includes('SELECT vendor1_name')) return { get: () => quotes };
  if (sql.includes('UPDATE indent_item_rates')) return { run: (...args) => { saved = args; } };
  if (sql.includes('SELECT ii.item_master_id')) return { get: () => null };
  throw new Error(sql);
} };
vm.runInNewContext(source.slice(start, end), {
  router: { post(url, middleware, fn) { handler = fn; } },
  needsApprove() {}, getDb: () => db,
  assertIndentApprovedByRate: () => block, console,
});
function call(role, body = {}) {
  saved = null;
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  handler({ params: { id: 7 }, user: { id: 42, role }, body: { final_vendor_name: 'Vendor A', final_rate: 12.5, ...body } }, res);
  return res;
}
quotes = {};
assert.equal(call('admin').code, 200);
assert.equal(saved[0], 12.5);
assert.equal(saved[4], 42); // Record the actual finalizer.
for (const role of ['user', 'manager', undefined]) {
  assert.equal(call(role, { role: 'admin', isAdmin: true }).code, 400);
  assert.equal(saved, null);
}
quotes = { vendor1_name: 'A', vendor1_rate: 1 };
assert.equal(call('admin').code, 200);
assert.equal(call('user').code, 400);
quotes = { ...quotes, vendor2_name: 'B', vendor2_rate: 2, vendor3_name: 'C', vendor3_rate: 3 };
assert.equal(call('user').code, 200);
block = { status: 403, error: 'L1/L2 approval required' };
assert.equal(call('admin').code, 403);
assert.equal(saved, null);
block = null;
for (const rate of [0, -1, 'bad', Infinity]) {
  assert.equal(call('admin', { final_rate: rate }).code, 400);
  assert.equal(saved, null);
}
assert.equal(call('admin', { final_vendor_name: ' ' }).code, 400);
quotes = null;
assert.equal(call('admin').code, 404);
console.log('Admin direct finalization: role enforcement, approval gate, audit actor and rate validation passed.');
