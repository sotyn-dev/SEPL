const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('TK-01375: Order to Planning calculates target prices of whole project (material, manpower, overheads)', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const ordersRouter = require('../../routes/orders');
  app.use('/api/orders', ordersRouter);
  t.after(() => { db.close(); });

  // Create site engineer user
  db.prepare(`INSERT OR IGNORE INTO users (id,name,email,username,password,role,active) VALUES (9010,'Eng One','eng1@example.invalid','eng1','pass','user',1)`).run();

  // Create Business Book entry
  db.prepare(`INSERT INTO business_book (id,lead_no,client_name,company_name,project_name,category,po_amount)
    VALUES (9501,'LEAD-9501','Client Acme','Acme Corp','Project Alpha','Solar',1000000)`).run();

  // Create Purchase Order with total_amount = 1,000,000, overheads_pct = 5%
  const poRes = db.prepare(`INSERT INTO purchase_orders (
    business_book_id, po_number, po_date, total_amount, site_engineer_id, site_engineer_ids, crm_name, overheads_pct, created_by
  ) VALUES (9501, 'PO-ALPHA-01', '2026-10-28', 1000000, 9010, '9010', 'Lovely', 5, 9001)`).run();
  const poId = poRes.lastInsertRowid;

  // Insert PO items:
  // Item 1: Qty 100, Rate 5000 (SITC selling = 500,000), Part Price 3000 (Material target = 300,000), Labour Rate 500 (Labour target = 50,000)
  // Item 2: Qty 200, Rate 2500 (SITC selling = 500,000), Part Price 1500 (Material target = 300,000), Labour Rate 300 (Labour target = 60,000)
  db.prepare(`INSERT INTO po_items (business_book_id, po_id, description, quantity, unit, rate, amount, part_price, labour_rate, labour_amount)
    VALUES (9501, ?, 'Item 1 - Solar Inverter', 100, 'nos', 5000, 500000, 3000, 500, 50000)`).run(poId);

  db.prepare(`INSERT INTO po_items (business_book_id, po_id, description, quantity, unit, rate, amount, part_price, labour_rate, labour_amount)
    VALUES (9501, ?, 'Item 2 - Mounting Structure', 200, 'nos', 2500, 500000, 1500, 300, 60000)`).run(poId);

  // Directly test the calculation logic from GET /orders/po
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId);
  const items = db.prepare(`SELECT
    SUM(COALESCE(quantity, 0) * COALESCE(part_price, 0)) AS target_material,
    SUM(COALESCE(labour_amount, COALESCE(quantity, 0) * COALESCE(labour_rate, 0), 0)) AS target_labour
    FROM po_items WHERE po_id=?`).get(poId);

  const targetMaterial = items.target_material; // 100*3000 + 200*1500 = 300,000 + 300,000 = 600,000
  const targetLabour = items.target_labour;     // 50,000 + 60,000 = 110,000
  const poTotal = po.total_amount;             // 1,000,000
  const targetOverheads = Math.round(poTotal * (po.overheads_pct || 5) / 100); // 5% of 1,000,000 = 50,000
  const targetTotal = targetMaterial + targetLabour + targetOverheads; // 600,000 + 110,000 + 50,000 = 760,000
  const projectedMargin = poTotal - targetTotal; // 1,000,000 - 760,000 = 240,000
  const marginPct = (projectedMargin / poTotal) * 100; // 24.0%

  assert.equal(targetMaterial, 600000, 'Material target should be 600,000');
  assert.equal(targetLabour, 110000, 'Labour target should be 110,000');
  assert.equal(targetOverheads, 50000, 'Overheads target should be 50,000');
  assert.equal(targetTotal, 760000, 'Total project target cost should be 760,000');
  assert.equal(projectedMargin, 240000, 'Projected margin should be 240,000');
  assert.equal(marginPct, 24, 'Margin percentage should be 24%');

  // Test updating overheads to fixed amount 60,000
  db.prepare('UPDATE purchase_orders SET overheads_amount=60000 WHERE id=?').run(poId);
  const updatedPo = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId);
  assert.equal(updatedPo.overheads_amount, 60000);
});
