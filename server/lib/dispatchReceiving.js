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
  // Approval + edit trail (mam 2026-09-11: "give here edit option and Lovely will
  // approve this receiving"). Receivings already saved start as pending.
  const have = new Set(db.prepare('PRAGMA table_info(dispatch_receiving)').all().map(c => c.name));
  const addColumn = (name, ddl) => { if (!have.has(name)) db.exec(`ALTER TABLE dispatch_receiving ADD COLUMN ${ddl}`); };
  addColumn('status', "status TEXT NOT NULL DEFAULT 'pending'");
  addColumn('approved_by', 'approved_by INTEGER REFERENCES users(id)');   // who approved OR rejected
  addColumn('approved_at', 'approved_at TEXT');
  addColumn('rejected_reason', 'rejected_reason TEXT');
  addColumn('updated_by', 'updated_by INTEGER REFERENCES users(id)');
  addColumn('updated_at', 'updated_at TEXT');
}

// A Business Book lead's site name: its project, else its company, else its
// client. Only project names were listed before, so leads with just a company
// name — most of them — never appeared (mam 2026-09-11: "all sites not fetch").
const bbSiteName = alias => `COALESCE(NULLIF(TRIM(${alias}.project_name),''), NULLIF(TRIM(${alias}.company_name),''), NULLIF(TRIM(${alias}.client_name),''))`;

// Every site: each Business Book lead plus every DPR site, one entry per name.
function sites(db) {
  const unique = new Map();
  const add = (name) => {
    const label = String(name || '').trim();
    if (!label) return;
    const key = normalize(label);
    if (!unique.has(key)) unique.set(key, { value: key, label });
  };
  for (const row of db.prepare(`SELECT ${bbSiteName('bb')} AS name FROM business_book bb`).all()) add(row.name);
  for (const row of db.prepare('SELECT name FROM sites').all()) add(row.name);
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function indentsForSite(db, site) {
  return db.prepare(`SELECT i.id, i.indent_number FROM indents i
    LEFT JOIN order_planning op ON op.id=i.planning_id
    LEFT JOIN business_book bb ON bb.id=op.business_book_id
    WHERE TRIM(COALESCE(i.indent_number,'')) != '' AND (
      LOWER(${bbSiteName('bb')})=? OR
      (op.business_book_id IS NULL AND LOWER(TRIM(i.site_name))=?)
    ) ORDER BY i.id DESC`).all(normalize(site), normalize(site));
}

// Who approves a receiving (mam 2026-09-11: "Lovely will approve this
// receiving"): the active user(s) named Lovely. Admin can stand in.
function receivingApprovers(db) {
  return db.prepare("SELECT id, name FROM users WHERE LOWER(TRIM(COALESCE(name,''))) LIKE 'lovely%' AND COALESCE(active,1)=1 ORDER BY id").all();
}

function canApproveReceiving(db, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return receivingApprovers(db).some(u => u.id === user.id);
}

module.exports = { initialize, sites, indentsForSite, normalize, receivingApprovers, canApproveReceiving };
