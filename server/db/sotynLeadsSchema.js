// SOTYN LEADS — the sotyn.ai website lead inbox (idempotent SQLite schema).
//
// Mam (2026-09-07): "generate a new small module which name sotyn lead and
// always automatically fetch". The public site (https://sotyn.ai, static
// Astro on Vercel) carries two forms — #demoForm (name, company, phone,
// city, trade, team) and #magnetForm (name, phone, email → the 11-point
// checklist PDF). Both already POST to a `WEBHOOK` constant; it shipped
// empty, so every enquiry only ever opened WhatsApp and nothing was stored.
// This table is the other end of that webhook: the lead lands here by
// itself, and the ERP screen keeps polling so it appears without anyone
// importing anything.
//
// Deliberately ONE table. A website enquiry is not an EPC lead — it stays
// in this inbox until a human presses Convert, which is what writes the
// SEPL-xxxx row into sales_funnel (see routes/sotynLeads.js). That keeps
// software enquiries and bot noise out of the EPC funnel counts, the
// Stage-1 SLA and the scorecard, while losing nothing.
//
//   status: new → contacted → qualified → converted   (junk = spam/bin)
//   converted_lead_id/_no point at the sales_funnel row once converted.

function runSotynLeadsMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sotyn_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- what the visitor typed
      name TEXT,
      company TEXT,
      phone TEXT,
      phone_key TEXT,                       -- last 10 digits, indexed: the dedupe key
      email TEXT,
      city TEXT,
      trade TEXT,
      team TEXT,
      turnover TEXT,                        -- webinar form: ₹ slab the visitor picked
      event TEXT,                           -- webinar form: which masterclass they booked
      -- where it came from
      form_type TEXT DEFAULT 'demo',        -- 'demo' | 'magnet'
      magnet TEXT,                          -- lead-magnet slug, magnet form only
      source TEXT,                          -- e.g. 'sotynerp-website'
      page TEXT,                            -- landing path at submit time
      referrer TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
      -- inbox state
      status TEXT NOT NULL DEFAULT 'new',   -- new | contacted | qualified | converted | junk
      owner_id INTEGER REFERENCES users(id),
      remarks TEXT,
      submissions INTEGER NOT NULL DEFAULT 1,   -- same person hitting submit twice
      -- 1-click convert → sales_funnel
      converted_lead_id INTEGER,
      converted_lead_no TEXT,
      converted_at DATETIME,
      converted_by INTEGER REFERENCES users(id),
      -- forensics: never throw away what the site actually sent
      raw_json TEXT,
      ip TEXT,
      user_agent TEXT,
      submitted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sotyn_leads_status  ON sotyn_leads (status);
    CREATE INDEX IF NOT EXISTS idx_sotyn_leads_created ON sotyn_leads (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sotyn_leads_phone   ON sotyn_leads (phone);
  `);

  // Self-healing column top-up (audit 2026-09-07). CREATE TABLE IF NOT EXISTS
  // is a no-op on a database that already has an OLDER version of this table,
  // so a column added after the first deploy would never appear and every
  // webhook INSERT would 500. Same ALTER-and-swallow pattern the rest of
  // server/db/schema.js uses: SQLite has no ADD COLUMN IF NOT EXISTS, and a
  // duplicate-column error is the expected steady state.
  for (const decl of ['phone_key TEXT', 'turnover TEXT', 'event TEXT']) {
    try { db.exec(`ALTER TABLE sotyn_leads ADD COLUMN ${decl}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }

  // Backfill the dedupe key for any row captured before the column existed,
  // and index it — the old trailing-LIKE match could not use an index at all.
  // substr(...,-10) mirrors the route's phoneKey(): the LAST ten digits, so
  // +91-98765-43210 and 09876543210 resolve to the same person.
  db.exec(`
    UPDATE sotyn_leads
       SET phone_key = substr(
             REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(phone,''),
               ' ',''), '-',''), '+',''), '(',''), ')',''), -10)
     WHERE phone_key IS NULL AND phone IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sotyn_leads_phonekey ON sotyn_leads (phone_key, form_type);
  `);
}

module.exports = { runSotynLeadsMigrations };
