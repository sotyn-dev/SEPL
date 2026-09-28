const SOURCE = 'auto:subcontractor_work_orders';
const MIGRATION = 'subcontractor_work_order_uploads_v1';
const fileValue = value => typeof value === 'string' ? value.trim() : '';

function recordWorkOrder(db, contractorId, file, uploadedBy, uploadedAt) {
  const url = fileValue(file);
  if (!url) return;
  db.prepare(`INSERT OR IGNORE INTO subcontractor_work_order_uploads
    (sub_contractor_id, file_url, uploaded_by, uploaded_at) VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`)
    .run(contractorId, url, uploadedBy || null, uploadedAt || null);
}

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS subcontractor_work_order_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_contractor_id INTEGER NOT NULL,
    file_url TEXT NOT NULL UNIQUE,
    uploaded_by INTEGER,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_subcontractor_work_order_upload_date ON subcontractor_work_order_uploads(uploaded_at);`);
  if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(MIGRATION)) return;
  db.transaction(() => {
    const current = db.prepare("SELECT id,work_order_file,created_by FROM sub_contractors WHERE TRIM(COALESCE(work_order_file,''))<>''").all();
    const fileOwners = new Map(current.map(row => [fileValue(row.work_order_file), row.id]));
    const events = [];
    const audits = db.prepare(`SELECT entity_id, at, user_id, body_summary FROM audit_log
      WHERE entity_type='sub-contractors' AND method IN ('POST','PUT') AND status_code BETWEEN 200 AND 299 ORDER BY at,id`).all();
    for (const audit of audits) {
      try {
        const file = fileValue(JSON.parse(audit.body_summary)?.work_order_file);
        if (!file) continue;
        const id = Number(audit.entity_id) || null;
        if (id) fileOwners.set(file, id);
        events.push({ ...audit, file, contractorId: id });
      } catch { /* Malformed/truncated historical bodies cannot establish an upload date. */ }
    }
    // The first successful save of each file defines its week. Ordinary edits,
    // reattaching the same file and repeat migrations never add another count.
    for (const event of events) {
      const id = event.contractorId || fileOwners.get(event.file);
      if (id) recordWorkOrder(db, id, event.file, event.user_id, event.at);
    }
    // Older saved files may predate audit logging. The ERP upload route prefixes
    // filenames with Date.now(); use that evidence, never the record edit date.
    for (const row of current) {
      const match = /^\/uploads\/(\d{13})-/.exec(fileValue(row.work_order_file));
      const timestamp = match && Number(match[1]);
      if (timestamp >= Date.UTC(2020, 0, 1) && timestamp <= Date.now()) {
        recordWorkOrder(db, row.id, row.work_order_file, row.created_by,
          new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19));
      }
    }
    const kpis = db.prepare("SELECT id FROM score_kpis WHERE metric_name='Work Order' AND data_source='auto:raci_step:subcon_hiring:12'").all();
    for (const { id } of kpis) {
      db.prepare('UPDATE score_kpis SET data_source=?,default_planned=2 WHERE id=?').run(SOURCE, id);
      db.prepare('UPDATE score_user_kpi_target SET planned_value=2 WHERE kpi_id=? AND planned_value=0').run(id);
    }
    db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run(MIGRATION, 'done');
  })();
}

function countWorkOrders(db, from, to) {
  return db.prepare(`SELECT COUNT(*) AS count FROM subcontractor_work_order_uploads
    WHERE date(uploaded_at,'+330 minutes') BETWEEN ? AND ?`).get(from, to).count;
}

module.exports = { initialize, recordWorkOrder, countWorkOrders };
