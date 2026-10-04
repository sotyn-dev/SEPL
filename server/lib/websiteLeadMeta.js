// The full website payload behind a sales_funnel row.
//
// The website-lead webhook copies a fixed set of fields into sales_funnel and
// writes the rest into remarks. Forms keep growing new fields (the Energy Desk
// report alone sends about thirty), and a new column per field is not
// sustainable, so the whole payload is kept here, keyed by the funnel row.
// It is what a later feature reads when it needs a field the remarks only
// summarise — e.g. an Energy Desk report linked back to its lead.
//
// Write-only from the webhook, and never fatal: a lead must not fail because
// its side record did.

const MAX_PAYLOAD_BYTES = 32 * 1024;

function ensureWebsiteLeadMeta(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS website_lead_meta (
      funnel_id    INTEGER PRIMARY KEY REFERENCES sales_funnel(id),
      lead_ref     TEXT UNIQUE,
      lead_source  TEXT,
      payload_json TEXT NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function recordWebsiteLeadMeta(db, { funnelId, leadRef, leadSource, payload }) {
  ensureWebsiteLeadMeta(db);
  let json = JSON.stringify(payload || {});
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    json = JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json, 'utf8') });
  }
  db.prepare(`
    INSERT OR IGNORE INTO website_lead_meta (funnel_id, lead_ref, lead_source, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(funnelId, leadRef || null, leadSource ? String(leadSource).slice(0, 40) : null, json);
}

module.exports = { ensureWebsiteLeadMeta, recordWebsiteLeadMeta, MAX_PAYLOAD_BYTES };
