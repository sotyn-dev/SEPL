// CRM Sales Funnel FMS — mam's spreadsheet-style flat tracker:
//   Step 1 Quotation submit → Step 2 Negotiation → Step 3 Win/Loss.
// Parallel to the existing 11-stage /sales-funnel module; this is the
// simpler workflow her sales team filled in a Google Sheet before.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();
router.use(authMiddleware);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// GET list — filters: q (search), step (1|2|3|all|open), state, source, type
router.get('/', requirePermission('crm_funnel', 'view'), (req, res) => {
  const { q, step, state, source, type } = req.query;
  let sql = 'SELECT * FROM crm_funnel WHERE 1=1';
  const params = [];

  if (step === 'open') { sql += " AND (final_status IS NULL OR final_status='')"; }
  if (step === '1') { sql += ' AND quotation_submitted=0'; }
  if (step === '2') { sql += " AND quotation_submitted=1 AND (final_status IS NULL OR final_status='')"; }
  if (step === '3') { sql += " AND final_status IN ('win','loss')"; }
  if (state) { sql += ' AND state=?'; params.push(state); }
  if (source) { sql += ' AND source=?'; params.push(source); }
  if (type) { sql += ' AND type=?'; params.push(type); }
  if (q) {
    sql += ' AND (client_name LIKE ? OR company_name LIKE ? OR mobile LIKE ? OR lead_no LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/:id', requirePermission('crm_funnel', 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM crm_funnel WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requirePermission('crm_funnel', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.client_name || !String(b.client_name).trim()) {
    return res.status(400).json({ error: 'Client name is required' });
  }
  const db = getDb();
  const leadNo = nextSequence(db, 'crm_funnel', 'lead_no', 'CRM-', { startFrom: 0, pad: 4 });
  const r = db.prepare(`INSERT INTO crm_funnel
    (lead_no, client_name, company_name, mobile, email, source, address, state, district,
     remarks, category, type,
     cust_boq_link, quotation_link, quotation_amount, quotation_submitted, quotation_submit_date,
     negotiation_status, negotiation_amount, negotiation_remarks,
     final_status, loss_reason, closed_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    leadNo,
    String(b.client_name).trim(),
    b.company_name || null, b.mobile || null, b.email || null, b.source || null,
    b.address || null, b.state || null, b.district || null,
    b.remarks || null, b.category || null, b.type || null,
    b.cust_boq_link || null, b.quotation_link || null,
    num(b.quotation_amount), b.quotation_submitted ? 1 : 0,
    b.quotation_submitted ? (b.quotation_submit_date || new Date().toISOString()) : null,
    b.negotiation_status || null, num(b.negotiation_amount), b.negotiation_remarks || null,
    b.final_status || null, b.loss_reason || null,
    b.final_status ? (b.closed_at || new Date().toISOString()) : null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid, lead_no: leadNo });
});

router.put('/:id', requirePermission('crm_funnel', 'edit'), (req, res) => {
  const b = req.body || {};
  const db = getDb();
  const existing = db.prepare('SELECT * FROM crm_funnel WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Stamp dates on the transition (Y/N → Y or final_status set the first time).
  const becomingSubmitted = !existing.quotation_submitted && b.quotation_submitted;
  const becomingClosed = !existing.final_status && b.final_status;

  db.prepare(`UPDATE crm_funnel SET
    client_name=?, company_name=?, mobile=?, email=?, source=?, address=?, state=?, district=?,
    remarks=?, category=?, type=?,
    cust_boq_link=?, quotation_link=?, quotation_amount=?, quotation_submitted=?, quotation_submit_date=?,
    negotiation_status=?, negotiation_amount=?, negotiation_remarks=?,
    final_status=?, loss_reason=?, closed_at=?,
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(
    b.client_name !== undefined ? String(b.client_name).trim() : existing.client_name,
    b.company_name !== undefined ? b.company_name : existing.company_name,
    b.mobile !== undefined ? b.mobile : existing.mobile,
    b.email !== undefined ? b.email : existing.email,
    b.source !== undefined ? b.source : existing.source,
    b.address !== undefined ? b.address : existing.address,
    b.state !== undefined ? b.state : existing.state,
    b.district !== undefined ? b.district : existing.district,
    b.remarks !== undefined ? b.remarks : existing.remarks,
    b.category !== undefined ? b.category : existing.category,
    b.type !== undefined ? b.type : existing.type,
    b.cust_boq_link !== undefined ? b.cust_boq_link : existing.cust_boq_link,
    b.quotation_link !== undefined ? b.quotation_link : existing.quotation_link,
    b.quotation_amount !== undefined ? num(b.quotation_amount) : existing.quotation_amount,
    b.quotation_submitted !== undefined ? (b.quotation_submitted ? 1 : 0) : existing.quotation_submitted,
    becomingSubmitted ? (b.quotation_submit_date || new Date().toISOString()) : existing.quotation_submit_date,
    b.negotiation_status !== undefined ? b.negotiation_status : existing.negotiation_status,
    b.negotiation_amount !== undefined ? num(b.negotiation_amount) : existing.negotiation_amount,
    b.negotiation_remarks !== undefined ? b.negotiation_remarks : existing.negotiation_remarks,
    b.final_status !== undefined ? b.final_status : existing.final_status,
    b.loss_reason !== undefined ? b.loss_reason : existing.loss_reason,
    becomingClosed ? (b.closed_at || new Date().toISOString()) : existing.closed_at,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('crm_funnel', 'delete'), (req, res) => {
  const r = getDb().prepare('DELETE FROM crm_funnel WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

module.exports = router;
