const normalize = value => String(value || '').trim().toLowerCase();

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS dispatch_receiving (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name TEXT NOT NULL,
    indent_id INTEGER NOT NULL REFERENCES indents(id),
    bill_number TEXT NOT NULL,
    receiving_url TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function sites(db) {
  const unique = new Map();
  for (const row of db.prepare("SELECT project_name FROM business_book WHERE TRIM(COALESCE(project_name,'')) != '' ORDER BY project_name").all()) {
    const key = normalize(row.project_name);
    if (!unique.has(key)) unique.set(key, { value: key, label: row.project_name.trim() });
  }
  return [...unique.values()];
}

function indentsForSite(db, site) {
  return db.prepare(`SELECT i.id, i.indent_number FROM indents i
    LEFT JOIN order_planning op ON op.id=i.planning_id
    LEFT JOIN business_book bb ON bb.id=op.business_book_id
    WHERE TRIM(COALESCE(i.indent_number,'')) != '' AND (
      LOWER(TRIM(bb.project_name))=? OR
      (op.business_book_id IS NULL AND LOWER(TRIM(i.site_name))=?)
    ) ORDER BY i.id DESC`).all(normalize(site), normalize(site));
}

module.exports = { initialize, sites, indentsForSite, normalize };
