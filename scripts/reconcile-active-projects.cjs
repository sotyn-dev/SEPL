// Read-only release check; require an explicit database path to avoid guessing.
const Database = require('better-sqlite3');
const { getActiveProjectMetric } = require('../server/lib/activeProjects');
if (!process.argv[2]) throw new Error('Usage: node scripts/reconcile-active-projects.cjs /path/to/erp.db');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const count = sql => db.prepare(sql).get().count;
  console.log(JSON.stringify({
    canonical: getActiveProjectMetric(db),
    comparison_only: {
      in_progress_orders: count("SELECT COUNT(*) count FROM purchase_orders WHERE status='in_progress'"),
      raw_active_site_rows: count("SELECT COUNT(*) count FROM sites WHERE status='active'"),
      financial_company_rows: count('SELECT COUNT(*) count FROM (SELECT company_name FROM business_book GROUP BY company_name)'),
    },
  }, null, 2));
} finally { db.close(); }
