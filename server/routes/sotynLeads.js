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

module.exports = router;
