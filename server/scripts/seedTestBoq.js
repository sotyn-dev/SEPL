// Seed test composite BOQ items for local testing of TSK-0822
const { getDb } = require('../db/schema');

function seedTestBoq() {
  const db = getDb();
  console.log('Seeding test BOQ items for local testing...');

  const sampleRows = [
    {
      item_id: null,
      code: '',
      description: 'SITC of 100mm dia MS ERW Heavy Class Fire Hydrant Riser Pipe inclusive of cutting, welding, pipe supports, primer and red enamel paint',
      boq_text: 'SITC of 100mm dia MS ERW Heavy Class Fire Hydrant Riser Pipe inclusive of cutting, welding, pipe supports, primer and red enamel paint',
      category: 'Fire Fighting',
      make: 'Tata / Jindal',
      unit: 'Mtr',
      qty: 250,
      pp: 0,
      lab: 0,
      confidence: 'none',
      subs: []
    },
    {
      item_id: null,
      code: '',
      description: 'Supply and laying of 3.5C x 240 sq.mm XLPE aluminium armoured cable in pre-laid cable tray with brass double compression glands and aluminium lugs',
      boq_text: 'Supply and laying of 3.5C x 240 sq.mm XLPE aluminium armoured cable in pre-laid cable tray with brass double compression glands and aluminium lugs',
      category: 'Electrical',
      make: 'Polycab / Havells',
      unit: 'Mtr',
      qty: 500,
      pp: 0,
      lab: 0,
      confidence: 'none',
      subs: []
    },
    {
      item_id: null,
      code: '',
      description: 'Internal point wiring for light/fan/plug point in concealed 25mm PVC conduit using 3 x 1.5 sq.mm FRLS copper wire with modular switches and accessories',
      boq_text: 'Internal point wiring for light/fan/plug point in concealed 25mm PVC conduit using 3 x 1.5 sq.mm FRLS copper wire with modular switches and accessories',
      category: 'Electrical',
      make: 'Anchor / Legrand',
      unit: 'Point',
      qty: 120,
      pp: 0,
      lab: 0,
      confidence: 'none',
      subs: []
    },
    {
      item_id: null,
      code: '',
      description: 'SITC of 250 kVA Oil Immersed Distribution Transformer 11kV/433V with first filling of oil, HT/LT cable termination boxes, and standard accessories',
      boq_text: 'SITC of 250 kVA Oil Immersed Distribution Transformer 11kV/433V with first filling of oil, HT/LT cable termination boxes, and standard accessories',
      category: 'Electrical',
      make: 'Schneider / ABB',
      unit: 'Set',
      qty: 1,
      pp: 0,
      lab: 0,
      confidence: 'none',
      subs: []
    }
  ];

  // 1. Seed into estimate_quotations (for /estimator -> Saved view)
  const existingEst = db.prepare('SELECT id FROM estimate_quotations WHERE title LIKE ?').get('%Test BOQ%');
  if (!existingEst) {
    db.prepare(`
      INSERT INTO estimate_quotations (title, client_name, acc_pct, margins_json, rows_json, manpower_json, cost, sp, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      'MEPF Composite Scope (Test BOQ)',
      'CONSERN PHARMA (Demo Project)',
      5,
      JSON.stringify({ 'Fire Fighting': 15, 'Electrical': 15 }),
      JSON.stringify(sampleRows),
      JSON.stringify([
        { name: 'Site Engineer', qty: 1, monthly_cost: 40000, months: 1 }
      ]),
      0,
      0
    );
    console.log('✓ Created test estimate in estimate_quotations');
  } else {
    console.log('✓ Test estimate already exists (id:', existingEst.id, ')');
  }

  // 2. Seed into purchase_orders & po_items (for /orders)
  const existingPo = db.prepare('SELECT id FROM purchase_orders WHERE po_number = ?').get('PO-TEST-001');
  let poId = existingPo?.id;
  if (!existingPo) {
    const res = db.prepare(`
      INSERT INTO purchase_orders (po_number, business_book_id, po_date, total_amount, status, created_by)
      VALUES (?, 1, '2026-10-08', ?, 'received', 1)
    `).run(
      'PO-TEST-001',
      500000
    );
    poId = res.lastInsertRowid;
    console.log('✓ Created test PO in purchase_orders (id:', poId, ')');

    const insItem = db.prepare(`
      INSERT INTO po_items (po_id, business_book_id, sr_no, description, quantity, unit, rate, amount)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    `);

    sampleRows.slice(0, 3).forEach((r, idx) => {
      insItem.run(poId, String(idx + 1), r.description, r.qty, r.unit, 0, 0);
    });
    console.log('✓ Created 3 composite items in po_items');
  } else {
    console.log('✓ Test PO already exists (id:', poId, ')');
  }

  console.log('Seeding completed successfully!');
}

seedTestBoq();
