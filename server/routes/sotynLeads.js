// SOTYN LEADS — the sotyn.ai website enquiry inbox (signed-in side).
//
// Mam (2026-09-07): "generate a new small module which name sotyn lead and
// always automatically fetch". Rows arrive here on their own from the public
// webhook (routes/publicSotynLead.js); this router is what the ERP screen
// reads, works and converts.
//
// The rule that shapes this file: a website enquiry is NOT an EPC lead.
// It stays in this inbox — out of the sales_funnel counts, the Stage-1 SLA
// and the scorecard — until a human presses Convert. Convert is the only
// place that writes a SEPL-xxxx row, and it needs BOTH sotyn_leads.create
// and leads.create, because it is really creating a funnel lead.
//
//   GET    /                → inbox (filters + counts). The screen polls this.
//   GET    /stats           → tiles: new / week / converted / conversion %
//   PATCH  /:id             → status, owner, remarks
//   POST   /:id/convert     → create the sales_funnel lead, link it back
//   DELETE /:id             → bin a junk submission

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'junk'];

// ── GET / — the inbox itself ─────────────────────────────────────────
// Bounded by design (audit 2026-08-21: return-everything lists are what
// freeze the ERP). Default 200 rows, hard ceiling 1000, with the total so
// the pager can show the real count.
router.get('/', requirePermission('sotyn_leads', 'view'), (req, res) => {
  const { status, form_type, q, from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = [];
  const params = [];
  if (status && STATUSES.includes(status)) { where.push('l.status = ?'); params.push(status); }
  if (form_type) { where.push('l.form_type = ?'); params.push(form_type); }
  if (from) { where.push("date(l.created_at, '+330 minutes') >= date(?)"); params.push(from); }
  if (to) { where.push("date(l.created_at, '+330 minutes') <= date(?)"); params.push(to); }
  if (q) {
    where.push('(l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ? OR l.email LIKE ? OR l.city LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const db = getDb();
  const rows = db.prepare(`
    -- Explicit columns, not l.* : raw_json / ip / user_agent are forensic fields
    -- the screen never renders, and the 30-second poll would ship that visitor
    -- PII to every viewer on every tick (audit 2026-09-07).
    SELECT l.id, l.name, l.company, l.phone, l.email, l.city, l.trade, l.team,
           l.turnover, l.event, l.form_type, l.magnet, l.source, l.page,
           l.utm_source, l.utm_campaign, l.status, l.owner_id, l.remarks,
           l.submissions, l.converted_lead_id, l.converted_lead_no, l.converted_at,
           l.submitted_at, l.created_at, l.updated_at,
           u.name AS owner_name, c.name AS converted_by_name
      FROM sotyn_leads l
      LEFT JOIN users u ON u.id = l.owner_id
      LEFT JOIN users c ON c.id = l.converted_by
      ${clause}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM sotyn_leads l ${clause}`).get(...params).c;

  // Status counts ignore the status filter — the tabs must keep showing
  // every bucket's size even while you are standing inside one of them.
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM sotyn_leads GROUP BY status').all()) {
    counts[r.status] = r.c;
  }
  res.json({ rows, total, counts, limit, offset });
});

// ── GET /stats — the four tiles above the table ──────────────────────
router.get('/stats', requirePermission('sotyn_leads', 'view'), (req, res) => {
  const db = getDb();
  // IST day/week boundaries (+330 minutes): the DB stores UTC, and "today"
  // has to mean today in Mohali, not in UTC.
  const g = (sql) => db.prepare(sql).get().c;
  const total = g('SELECT COUNT(*) AS c FROM sotyn_leads');
  const stats = {
    total,
    new_count: g("SELECT COUNT(*) AS c FROM sotyn_leads WHERE status='new'"),
    today: g("SELECT COUNT(*) AS c FROM sotyn_leads WHERE date(created_at,'+330 minutes') = date('now','+330 minutes')"),
    week: g("SELECT COUNT(*) AS c FROM sotyn_leads WHERE created_at >= datetime('now','-7 days')"),
    converted: g("SELECT COUNT(*) AS c FROM sotyn_leads WHERE status='converted'"),
    junk: g("SELECT COUNT(*) AS c FROM sotyn_leads WHERE status='junk'"),
  };
  // Conversion % counts only real enquiries — junk was never a lead.
  const real = total - stats.junk;
  stats.conversion_pct = real > 0 ? Math.round((stats.converted / real) * 1000) / 10 : 0;
  res.json(stats);
});

// ── PATCH /:id — work the lead ───────────────────────────────────────
router.patch('/:id', requirePermission('sotyn_leads', 'edit'), (req, res) => {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM sotyn_leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const sets = [];
  const params = [];
  if (req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    // 'converted' is not a label you can type on — it is set by Convert, and
    // only Convert, so the status can never claim a funnel lead that isn't there.
    if (req.body.status === 'converted') return res.status(400).json({ error: 'Use Convert to mark a lead converted' });
    if (lead.status === 'converted') return res.status(409).json({ error: 'This lead is already converted' });
    sets.push('status = ?'); params.push(req.body.status);
  }
  if (req.body.owner_id !== undefined) {
    // foreign_keys is ON, so an id that does not exist would surface as a 500
    // from SQLite rather than a 400 the caller can act on.
    const oid = req.body.owner_id || null;
    if (oid !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(oid)) {
      return res.status(400).json({ error: 'That user does not exist' });
    }
    sets.push('owner_id = ?'); params.push(oid);
  }
  if (req.body.remarks !== undefined) { sets.push('remarks = ?'); params.push(String(req.body.remarks || '').slice(0, 2000) || null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  sets.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE sotyn_leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  res.json({ message: 'Updated' });
});

// ── POST /:id/convert — inbox → Sales Funnel, one click ──────────────
// Needs leads.create as well: this endpoint creates a real SEPL-xxxx funnel
// lead, so anyone who can press it must be allowed to create funnel leads.
router.post('/:id/convert',
  requirePermission('sotyn_leads', 'create'),
  requirePermission('leads', 'create'),
  (req, res) => {
    const db = getDb();
    const lead = db.prepare('SELECT * FROM sotyn_leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.converted_lead_id) {
      return res.status(409).json({ error: `Already converted as ${lead.converted_lead_no}`, lead_no: lead.converted_lead_no });
    }

    const b = req.body || {};
    // The website only ever collects a person + a company, so the funnel's
    // required fields are filled from the enquiry (overridable in the modal).
    const clientName = String(b.client_name || lead.name || '').trim();
    if (!clientName) return res.status(400).json({ error: 'Customer name is required' });
    const companyName = String(b.company_name ?? lead.company ?? '').trim() || null;
    const projectName = String(b.project_name || '').trim()
      || `SOTYN ERP — ${companyName || clientName}`;

    // Everything the funnel has no column for is written into the remark, so
    // the salesperson opens the lead and sees the whole enquiry as submitted.
    const FORM_LABEL = {
      magnet: 'checklist download',
      webinar: 'webinar registration',
      demo: 'demo request',
    };
    const bits = [
      `Website enquiry from sotyn.ai (${FORM_LABEL[lead.form_type] || 'demo request'})`,
      lead.event && `Event: ${lead.event}`,
      lead.turnover && `Turnover: ${lead.turnover}`,
      lead.trade && `Trade: ${lead.trade}`,
      lead.team && `Team size: ${lead.team}`,
      lead.city && `City: ${lead.city}`,
      lead.magnet && `Magnet: ${lead.magnet}`,
      lead.page && `Page: ${lead.page}`,
      lead.utm_campaign && `Campaign: ${lead.utm_campaign}`,
      lead.submissions > 1 && `Submitted ${lead.submissions}x`,
      lead.remarks && `Inbox note: ${lead.remarks}`,
      b.remarks && String(b.remarks).slice(0, 1000),
    ].filter(Boolean);

    const { nextSequence } = require('../db/nextSequence');

    try {
      const convert = db.transaction(() => {
        const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });
        const r = db.prepare(`
          INSERT INTO sales_funnel
            (lead_no, client_name, company_name, phone, email, project_name,
             city, source, lead_kind, remarks, created_by,
             current_stage, stage_entered_at)
          VALUES (?,?,?,?,?,?,?,?,'private',?,?,'lead_capture', CURRENT_TIMESTAMP)
        `).run(
          leadNo, clientName, companyName, lead.phone || null, lead.email || null,
          projectName, b.city ?? lead.city ?? null, 'Website — sotyn.ai',
          bits.join(' · '), req.user.id
        );

        // Same audit trail a hand-typed Stage-1 lead gets, so the funnel's
        // timeline says where this lead actually came from.
        try {
          db.prepare(`
            INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_id, actor_name, notes)
            VALUES (?, 'lead_capture', 'create', ?, ?, ?)
          `).run(r.lastInsertRowid, req.user.id, req.user.name || null,
            `Converted from Sotyn Leads #${lead.id} (sotyn.ai website)`);
        } catch { /* audit table is best-effort, never blocks the convert */ }

        db.prepare(`
          UPDATE sotyn_leads
             SET status = 'converted', converted_lead_id = ?, converted_lead_no = ?,
                 converted_at = CURRENT_TIMESTAMP, converted_by = ?,
                 owner_id = COALESCE(owner_id, ?), updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(r.lastInsertRowid, leadNo, req.user.id, req.user.id, lead.id);

        return { id: r.lastInsertRowid, lead_no: leadNo };
      });
      const out = convert();
      res.status(201).json({ message: `Converted as ${out.lead_no}`, lead_id: out.id, lead_no: out.lead_no });
    } catch (e) {
      console.error('[sotyn-leads] convert failed:', e.message);
      res.status(500).json({ error: 'Could not convert this lead' });
    }
  });

// ── DELETE /:id — bin a junk submission ──────────────────────────────
router.delete('/:id', requirePermission('sotyn_leads', 'delete'), (req, res) => {
  const db = getDb();
  const lead = db.prepare('SELECT converted_lead_no FROM sotyn_leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  // A converted enquiry is the audit trail behind a live funnel lead —
  // deleting it would orphan that lead's origin. Mark it junk instead.
  if (lead.converted_lead_no) {
    return res.status(409).json({ error: `Cannot delete — already converted as ${lead.converted_lead_no}` });
  }
  db.prepare('DELETE FROM sotyn_leads WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Lead ingestion: WhatsApp paste + sales-mailbox scan ──────────────
//
// Mam (2026-09-07) "whatsapp ingestion banao" then "old data also retrive ... do
// which is best i need data". Every sotyn.ai form ships with an empty WEBHOOK, so
// enquiries never reach the ERP on their own. These two routes recover them from
// the only two places they can still be: the WhatsApp messages the forms open, and
// the sales@ mailbox every page links to.
//
// Both share ONE staging path below, so dedupe, caps and the preview contract can
// never drift apart between them.
//
// Two-step by design — a request without commit:true parses and reports, writing
// NOTHING. The screen shows what was found, what is already here and what is
// unusable, and only a deliberate second call inserts. An import that silently
// created 300 rows on a mis-paste would be far worse than one extra click.
//
// Dedupe is deliberately NOT the live webhook's 6-hour window: a backfill is months
// of history at once, so it matches across ALL time — on phone_key + form_type, or
// on email + form_type when the enquiry only carried an address. Re-running either
// importer is therefore a no-op, which is what makes it safe to repeat.
const MAX_IMPORT_CHARS = 5 * 1024 * 1024;   // a very long chat export, still bounded
const MAX_IMPORT_ROWS = 1000;               // one run cannot flood the inbox

const phoneKeyOf = (p) => (String(p || '').replace(/\D/g, '').slice(-10) || null);

// Same length caps the public webhook applies — a pasted file is untrusted input.
const cap = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

// A parsed timestamp may never be in the future. Anything ahead of now is
// nonsense (a wrong device clock, a typo'd year) and is dropped so the row falls
// back to the import time, rather than being written and poisoning the dedupe.
function notFuture(at) {
  if (!at) return null;
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return at > nowSql ? null : at;
}

// candidates: [{ lead, at, sender, body }] — the shape BOTH parseChat() and
// scanLeadMailbox() produce.
function stageCandidates(db, candidates) {
  const byPhone = db.prepare(
    'SELECT id, name, created_at FROM sotyn_leads WHERE phone_key = ? AND form_type = ? ORDER BY id LIMIT 1'
  );
  const byEmail = db.prepare(
    'SELECT id, name, created_at FROM sotyn_leads WHERE LOWER(email) = LOWER(?) AND form_type = ? ORDER BY id LIMIT 1'
  );

  const rows = [];
  const seen = new Set();
  for (const m of candidates) {
    const l = m.lead;
    // The message's own Phone line wins; a bare CTA has none, so fall back to the
    // sender — which is a usable number only when they are not in your contacts.
    const phone = l.phone || (/^\+?[\d ()-]{10,}$/.test(m.sender || '') ? m.sender : null);
    const key = phoneKeyOf(phone);
    const email = cap(l.email, 160);

    const row = {
      ...l,
      // Every value is capped exactly as the public webhook caps it. These come
      // from a pasted file, so they are no more trustworthy than a web form, and
      // an uncapped paste could otherwise write a megabyte into a name column.
      name: cap(l.name, 120),
      company: cap(l.company, 160),
      city: cap(l.city, 120),
      trade: cap(l.trade, 120),
      team: cap(l.team, 120),
      turnover: cap(l.turnover, 60),
      event: cap(l.event, 160),
      magnet: cap(l.magnet, 120),
      phone: cap(phone, 40), phone_key: key, email,
      // NEVER let a parsed timestamp sit in the future. A bad device clock or a
      // hand-typed year would otherwise poison the LIVE webhook's 6-hour dedupe
      // permanently: `created_at > datetime('now','-6 hours')` stays true for a
      // 2027 row forever, so every later real enquiry from that number is merged
      // into the imported row instead of arriving — and because the merge never
      // overwrites the name, the real visitor is silently lost. Verified against
      // a copy of the live database (review 2026-09-07). It also pinned the row
      // to the top of the inbox and into "Last 7 days" for good.
      at: notFuture(m.at),
      sender: m.sender, body: m.body,
      // With neither a number nor an address nobody can follow this up, and it
      // cannot be deduped — reported, never imported.
      skipped: (!key && !email) ? 'no phone number or email in the message' : null,
      duplicate: null,
    };

    if (!row.skipped) {
      const dedupeKey = (key ? 'p:' + key : 'e:' + String(email).toLowerCase()) + '|' + l.form_type;
      const existing = key ? byPhone.get(key, l.form_type) : byEmail.get(email, l.form_type);
      if (existing) row.duplicate = { id: existing.id, name: existing.name, created_at: existing.created_at };
      else if (seen.has(dedupeKey)) row.duplicate = { id: null, name: 'earlier in this batch' };
      else seen.add(dedupeKey);
    }
    rows.push(row);
  }

  const importable = rows.filter((r) => !r.skipped && !r.duplicate);
  return {
    rows,
    importable,
    summary: {
      found: rows.length,
      importable: importable.length,
      duplicates: rows.filter((r) => r.duplicate).length,
      skipped: rows.filter((r) => r.skipped).length,
    },
  };
}

// Trim a staged row down to what the preview table renders — the raw body, the
// sender and the forensic payload stay on the server.
const previewRow = (r) => ({
  form_type: r.form_type, name: r.name, company: r.company, phone: r.phone,
  email: r.email, city: r.city, trade: r.trade, team: r.team,
  turnover: r.turnover, event: r.event, at: r.at,
  duplicate: r.duplicate, skipped: r.skipped,
});

function insertStaged(db, importable, sourceTag) {
  const insert = db.prepare(`
    INSERT INTO sotyn_leads
      (name, company, phone, phone_key, email, city, trade, team, turnover, event,
       form_type, magnet, source, page, status, raw_json, submitted_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'new',?,?,COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
  `);
  const run = db.transaction((list) => {
    for (const r of list) {
      insert.run(
        r.name, r.company, r.phone, r.phone_key, r.email, r.city, r.trade, r.team,
        r.turnover, r.event, r.form_type, r.magnet,
        // Tagged so a recovered lead is never mistaken for a live website capture.
        sourceTag,
        JSON.stringify({ recovered: { via: sourceTag, sender: r.sender, at: r.at, body: r.body } }).slice(0, 4000),
        r.at, r.at
      );
    }
  });
  run(importable);
  return importable.length;
}

// POST /import — paste one WhatsApp message, or a whole exported chat.
router.post('/import', requirePermission('sotyn_leads', 'create'), (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const commit = req.body?.commit === true;
  if (!text.trim()) return res.status(400).json({ error: 'Paste a WhatsApp message or an exported chat first' });
  if (text.length > MAX_IMPORT_CHARS) {
    return res.status(413).json({ error: 'That export is too large — split it, or export a shorter date range' });
  }

  const { parseChat } = require('../lib/whatsappLeadParser');
  let parsed;
  try { parsed = parseChat(text); }
  catch (e) {
    console.error('[sotyn-leads] import parse failed:', e.message);
    return res.status(400).json({ error: 'Could not read that text as WhatsApp messages' });
  }

  const db = getDb();
  const staged = stageCandidates(db, parsed);
  if (!commit) {
    return res.json({ ...staged.summary, committed: false, rows: staged.rows.slice(0, 200).map(previewRow) });
  }
  if (!staged.importable.length) return res.json({ ...staged.summary, committed: true, inserted: 0 });
  if (staged.importable.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `That paste holds ${staged.importable.length} new leads — import at most ${MAX_IMPORT_ROWS} at a time` });
  }
  try {
    const n = insertStaged(db, staged.importable, 'whatsapp-import');
    console.log(`[sotyn-leads] whatsapp import by ${req.user?.name || req.user?.id}: ${n} lead(s)`);
    res.json({ ...staged.summary, committed: true, inserted: n });
  } catch (e) {
    console.error('[sotyn-leads] import failed:', e.message);
    res.status(500).json({ error: 'Could not save the imported leads' });
  }
});

// POST /scan-mailbox — read website enquiries out of the sales@ mailbox.
// Read-only against IMAP: it never deletes, moves or marks anything, so it can be
// run again and again. Credentials live in .env on the server (lib/sotynLeadMailbox).
router.post('/scan-mailbox', requirePermission('sotyn_leads', 'create'), async (req, res) => {
  const commit = req.body?.commit === true;
  const { scanLeadMailbox } = require('../lib/sotynLeadMailbox');

  let scan;
  try { scan = await scanLeadMailbox(); }
  catch (e) {
    console.error('[sotyn-leads] mailbox scan failed:', e.message);
    return res.status(502).json({ error: 'Could not read the mailbox' });
  }
  if (!scan.configured) {
    return res.status(400).json({ error: scan.problems[0], configured: false });
  }

  const db = getDb();
  const staged = stageCandidates(db, scan.candidates);
  const base = { ...staged.summary, scanned: scan.scanned, problems: scan.problems.slice(0, 10) };

  if (!commit) {
    return res.json({ ...base, committed: false, rows: staged.rows.slice(0, 200).map(previewRow) });
  }
  if (!staged.importable.length) return res.json({ ...base, committed: true, inserted: 0 });
  if (staged.importable.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `The mailbox holds ${staged.importable.length} new leads — narrow SOTYN_MAIL_SINCE_DAYS and run it again` });
  }
  try {
    const n = insertStaged(db, staged.importable, 'email-import');
    console.log(`[sotyn-leads] mailbox import by ${req.user?.name || req.user?.id}: ${n} lead(s) from ${scan.scanned} message(s)`);
    res.json({ ...base, committed: true, inserted: n });
  } catch (e) {
    console.error('[sotyn-leads] mailbox import failed:', e.message);
    res.status(500).json({ error: 'Could not save the imported leads' });
  }
});

module.exports = router;
