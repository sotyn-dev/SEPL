// Read-only diagnosis: no schema initialization and no business data changes.
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const number = process.argv[2] || 'SEPL/SB/26-27/008';
  const bill = db.prepare('SELECT id, bill_number, business_book_id, bill_type FROM sales_bills WHERE bill_number=?').get(number);
  console.log('Database:', dbPath);
  console.log('Bill:', bill || 'NOT FOUND — check the running app directory/database');
  if (bill) {
    console.log('Stored invoice units:');
    console.table(db.prepare('SELECT description, unit FROM sales_bill_items WHERE sales_bill_id=?').all(bill.id));
    console.log('Current BOQ rows for 37mm pipe:');
    console.table(db.prepare("SELECT id, po_id, description, unit, rate FROM po_items WHERE business_book_id=? AND description LIKE '%37%'").all(bill.business_book_id));
    console.log('Linked DPR pipe rows and their current BOQ unit:');
    console.table(db.prepare(`SELECT wi.id, wi.description, wi.unit AS dpr_unit, wi.po_item_id,
      p.po_id, p.description AS boq_description, p.unit AS boq_unit
      FROM dpr_work_items wi JOIN dpr d ON d.id=wi.dpr_id
      LEFT JOIN po_items p ON p.id=wi.po_item_id
      WHERE d.sales_bill_id=? AND (wi.description LIKE '%37%' OR p.description LIKE '%37%')`).all(bill.id));
  }
} finally { db.close(); }
