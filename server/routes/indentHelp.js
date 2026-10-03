const express = require('express');
const { getDb } = require('../db/schema');
const { canAccess, STAGES } = require('../lib/indentHelp');

module.exports = function indentHelpRouter({ canSeeAllIndents }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!canAccess(getDb(), req.user.id)) return res.status(403).json({ error: 'Indent to Dispatch access is required' });
    next();
  });
  const ownIndent = (indent, user) => indent.created_by === user.id ||
    (!!String(indent.raised_by_name || '').trim() && String(indent.raised_by_name).trim().toLowerCase() === String(user.name || '').trim().toLowerCase());

  router.get('/options', (req, res) => {
    const db = getDb(), all = canSeeAllIndents(db, req);
    const indents = db.prepare(`SELECT id, indent_number, site_name FROM indents
      ${all ? '' : `WHERE created_by=? OR (LENGTH(TRIM(COALESCE(raised_by_name,'')))>0 AND LOWER(TRIM(raised_by_name))=LOWER(TRIM(?)))`}
      ORDER BY id DESC`).all(...(all ? [] : [req.user.id, req.user.name || '']));
    const people = db.prepare(`SELECT u.id, u.name FROM users u WHERE COALESCE(u.active,1)=1
      AND (u.role='admin' OR EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
        WHERE ur.user_id=u.id AND rp.module='procurement' AND rp.can_view=1)) ORDER BY u.name`).all();
    res.json({ indents, people, stages: STAGES, can_see_all: all });
  });

  router.get('/', (req, res) => {
    const db = getDb(), all = canSeeAllIndents(db, req);
    const base = all ? '1=1' : '(h.raised_by=? OR h.assigned_to=?)';
    const baseParams = all ? [] : [req.user.id, req.user.id];
    const stats = db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(status='open'),0) open, COALESCE(SUM(status='done'),0) done,
      COALESCE(SUM(status='open' AND assigned_to=?),0) assigned_to_me
      FROM indent_help h WHERE ${base}`).get(req.user.id, ...baseParams);
    const where = [base], params = [...baseParams];
    if (req.query.scope === 'mine') { where.push('h.assigned_to=?'); params.push(req.user.id); }
    if (req.query.scope === 'raised') { where.push('h.raised_by=?'); params.push(req.user.id); }
    if (['open', 'done'].includes(req.query.status)) { where.push('h.status=?'); params.push(req.query.status); }
    const search = String(req.query.q || '').trim().slice(0, 150);
    if (search) {
      where.push("(i.indent_number LIKE ? OR i.site_name LIKE ? OR h.subject LIKE ? OR a.name LIKE ? OR r.name LIKE ? OR ('IH-' || printf('%05d',h.id)) LIKE ?)");
      params.push(...Array(6).fill(`%${search}%`));
    }
    const from = `FROM indent_help h JOIN indents i ON i.id=h.indent_id
      JOIN users a ON a.id=h.assigned_to JOIN users r ON r.id=h.raised_by WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n;
    const page = Math.min(Math.max(1, Math.floor(Number(req.query.page) || 1)), Math.max(1, Math.ceil(total / 20)));
    const rows = db.prepare(`SELECT h.*, i.indent_number, i.site_name, a.name assigned_to_name, r.name raised_by_name
      ${from} ORDER BY h.created_at DESC, h.id DESC LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20);
    res.json({ rows, total, page, pages: Math.max(1, Math.ceil(total / 20)), stats, can_see_all: all });
  });

  router.post('/', (req, res) => {
    const db = getDb(), body = req.body || {};
    const indentId = Number(body.indent_id), assignedTo = Number(body.assigned_to);
    if (!Number.isSafeInteger(indentId) || indentId <= 0) return res.status(400).json({ error: 'Select an indent number; it is compulsory' });
    const indent = db.prepare('SELECT id,indent_number,created_by,raised_by_name FROM indents WHERE id=?').get(indentId);
    if (!indent || (!canSeeAllIndents(db, req) && !ownIndent(indent, req.user))) return res.status(400).json({ error: 'Select an indent available to you' });
    if (!Number.isSafeInteger(assignedTo) || !canAccess(db, assignedTo)) return res.status(400).json({ error: 'Select an active person with Indent to Dispatch access' });
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!subject || subject.length > 180 || !description || description.length > 4000) return res.status(400).json({ error: 'Enter a subject (up to 180 characters) and issue details (up to 4,000 characters)' });
    if (!STAGES.includes(body.stage) || !['normal', 'high', 'urgent'].includes(body.priority)) return res.status(400).json({ error: 'Select a valid stage and priority' });
    if (typeof body.request_id !== 'string' || !/^[\w-]{16,80}$/.test(body.request_id)) return res.status(400).json({ error: 'Invalid request; reopen the form and try again' });
    const result = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM indent_help WHERE raised_by=? AND request_id=?').get(req.user.id, body.request_id);
      if (existing) return { id: existing.id, existing: true };
      const id = Number(db.prepare(`INSERT INTO indent_help(indent_id,raised_by,assigned_to,subject,description,stage,priority,request_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(indentId, req.user.id, assignedTo, subject, description, body.stage, body.priority, body.request_id).lastInsertRowid);
      db.prepare(`INSERT INTO notifications(user_id,type,title,body,link_url) VALUES(?,?,?,?,?)`)
        .run(assignedTo, 'indent_help', `Indent Help · ${indent.indent_number}`, subject, '/procurement?tab=indenthelp');
      return { id, existing: false };
    }).immediate();
    res.status(result.existing ? 200 : 201).json(result);
  });

  router.patch('/:id/done', (req, res) => {
    const db = getDb(), ticket = db.prepare('SELECT * FROM indent_help WHERE id=?').get(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Indent help not found' });
    // No admin or raiser override: only the assigned person can mark Done.
    if (ticket.assigned_to !== req.user.id) return res.status(403).json({ error: 'Only the assigned person can mark this Done' });
    const note = req.body?.completion_note;
    if (note != null && (typeof note !== 'string' || note.length > 2000)) return res.status(400).json({ error: 'Completion note must be at most 2,000 characters' });
    db.prepare(`UPDATE indent_help SET status='done',completion_note=?,completed_by=?,completed_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='open'`).run(note?.trim() || null, req.user.id, ticket.id);
    res.json({ id: ticket.id, status: 'done' });
  });
  return router;
};
