#!/usr/bin/env node
// Explicit database path only. Default mode is READ-ONLY and prints no names,
// phones, email addresses or enquiry text. Apply requires the reviewed digest.
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const { proposedWebsiteCorrections } = require('../lib/websiteLeadFields');

function buildPlan(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='website_lead_meta'").get();
  if (!hasMeta) return { changes: [], skipped: [{ reason: 'No saved website metadata table' }] };
  const rows = db.prepare(`SELECT s.id, s.lead_no, s.state, s.district, s.category, m.payload_json
    FROM sales_funnel s JOIN website_lead_meta m ON m.funnel_id=s.id
    WHERE s.source='Website' ORDER BY s.id`).all();
  const changes = [], skipped = [];
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { skipped.push({ leadNo: row.lead_no, reason: 'Invalid saved payload' }); continue; }
    if (!payload || typeof payload !== 'object' || payload.truncated) {
      skipped.push({ leadNo: row.lead_no, reason: 'Missing or truncated saved payload' }); continue;
    }
    const after = proposedWebsiteCorrections(row, payload);
    if (Object.keys(after).length) changes.push({ id: row.id, leadNo: row.lead_no,
      before: Object.fromEntries(Object.keys(after).map(key => [key, row[key]])), after });
  }
  return { changes, skipped };
}

const digestPlan = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

function applyPlan(db, expectedDigest) {
  return db.transaction(() => {
    const plan = buildPlan(db);
    if (digestPlan(plan) !== expectedDigest) throw new Error('Plan changed or digest is incorrect. Review a fresh dry run before applying.');
    for (const change of plan.changes) {
      // Keys come only from proposedWebsiteCorrections, never the CLI/payload.
      const keys = Object.keys(change.after);
      db.prepare(`UPDATE sales_funnel SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(...keys.map(k => change.after[k]), change.id);
      db.prepare(`INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_name, notes)
        VALUES (?, NULL, 'website_fields_reconciled', 'Approved website reconciliation', ?)`)
        .run(change.id, JSON.stringify({ before: change.before, after: change.after, planDigest: expectedDigest }));
    }
    return plan.changes.length;
  }).immediate();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--db') || !value('--db') || value('--db').startsWith('--')) {
    throw new Error('Usage: node server/scripts/reconcileWebsiteLeadFields.js --db /explicit/database.sqlite [--apply --expected-digest REVIEWED_SHA256]');
  }
  const apply = args.includes('--apply');
  if (apply && (!args.includes('--expected-digest') || !/^[a-f0-9]{64}$/.test(value('--expected-digest') || ''))) {
    throw new Error('Apply requires the digest from a reviewed dry run. Obtain owner approval and a database backup first.');
  }
  const db = new Database(value('--db'), { readonly: !apply, fileMustExist: true });
  try {
    if (apply) console.log(JSON.stringify({ applied: applyPlan(db, value('--expected-digest')) }));
    else { const plan = buildPlan(db); console.log(JSON.stringify({ mode: 'read-only', digest: digestPlan(plan), ...plan }, null, 2)); }
  } finally { db.close(); }
}

module.exports = { buildPlan, digestPlan, applyPlan };
