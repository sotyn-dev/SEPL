// Sales Bill Receive — schema (tables only).
//
// Register of client sales bills received against an indent: indent number
// (from indents), site name (from Business Book), bill number, uploaded file.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only.
// The 'sales_bill_receive' permission key stays in schema.js's ALL_MODULES list.

function runSalesBillReceiveMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_bill_receives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id),
      indent_number TEXT,
      site_name TEXT NOT NULL,
      bill_number TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_name TEXT,
      received_by INTEGER REFERENCES users(id),
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sbr_indent ON sales_bill_receives(indent_id);
    CREATE INDEX IF NOT EXISTS idx_sbr_received ON sales_bill_receives(received_at DESC);
  `);
}

module.exports = { runSalesBillReceiveMigrations };
