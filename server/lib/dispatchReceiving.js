const normalize = value => String(value || '').trim().toLowerCase();

// Indent No. is typed by hand (mam 2026-09-10: "indent number manuall fill"), so
// the typed text is what's stored. indent_id is only a best-effort link, set when
// the text matches one of the site's indents.
const TABLE_SQL = name => `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name TEXT NOT NULL,
    indent_id INTEGER REFERENCES indents(id),
    indent_number TEXT NOT NULL,
    bill_number TEXT NOT NULL,
    receiving_url TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

function initialize(db) {
  db.exec(TABLE_SQL('dispatch_receiving'));
  // First version required a picked indent (indent_id NOT NULL, no text column).
  // SQLite can't relax NOT NULL in place, so rebuild once, carrying every row
  // and its indent number across.
  const cols = db.prepare('PRAGMA table_info(dispatch_receiving)').all();
  if (!cols.some(c => c.name === 'indent_number')) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS dispatch_receiving_v2');
      db.exec(TABLE_SQL('dispatch_receiving_v2'));
      db.exec(`INSERT INTO dispatch_receiving_v2
        (id, site_name, indent_id, indent_number, bill_number, receiving_url, created_by, created_at)
        SELECT r.id, r.site_name, r.indent_id, COALESCE(i.indent_number, ''), r.bill_number, r.receiving_url, r.created_by, r.created_at
        FROM dispatch_receiving r LEFT JOIN indents i ON i.id = r.indent_id`);
      db.exec('DROP TABLE dispatch_receiving');
      db.exec('ALTER TABLE dispatch_receiving_v2 RENAME TO dispatch_receiving');
    })();
  }
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
