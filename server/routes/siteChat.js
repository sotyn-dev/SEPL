// Site Chat — an internal, WhatsApp-style message thread per site (mam
// 2026-06-18: "create whatsapp message of every site … in erp kind of
// whatsapp"). Team-only: ERP users post free text + photo/file attachments
// to a site's thread; everything is stored in the ERP (no external WhatsApp).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

getDb().exec(`
  CREATE TABLE IF NOT EXISTS site_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    site_name TEXT,
    body TEXT,
    attachment_url TEXT,
    attachment_name TEXT,
    sender_id INTEGER,
    sender_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sitemsg_site ON site_messages(site_id, created_at);
`);

// GET the chat list — every site with its last-message preview + count, newest
// conversation first, then sites without messages alphabetically.
router.get('/sites', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb();
  const sites = db.prepare(`SELECT id, name, client_name, status FROM sites ORDER BY name`).all();
  const last = db.prepare(`SELECT site_id, body, attachment_name, sender_name, created_at FROM site_messages
                           WHERE id IN (SELECT MAX(id) FROM site_messages GROUP BY site_id)`).all();
  const lastBy = Object.fromEntries(last.map(l => [l.site_id, l]));
  const countBy = Object.fromEntries(db.prepare(`SELECT site_id, COUNT(*) c FROM site_messages GROUP BY site_id`).all().map(c => [c.site_id, c.c]));
  const out = sites.map(s => ({ ...s, last: lastBy[s.id] || null, count: countBy[s.id] || 0 }));
  out.sort((a, b) => {
    const ta = a.last?.created_at || '', tb = b.last?.created_at || '';
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1; if (tb) return 1;
    return String(a.name).localeCompare(String(b.name));
  });
  res.json(out);
});

// GET one site's messages, oldest first.
router.get('/:siteId', requirePermission('site_chat', 'view'), (req, res) => {
  res.json(getDb().prepare(`SELECT * FROM site_messages WHERE site_id=? ORDER BY created_at, id`).all(req.params.siteId));
});

// POST a message (text and/or attachment).
router.post('/:siteId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb();
  const { body, attachment_url, attachment_name } = req.body;
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a message or attach a file' });
  const site = db.prepare('SELECT id, name FROM sites WHERE id=?').get(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const info = db.prepare(`INSERT INTO site_messages (site_id, site_name, body, attachment_url, attachment_name, sender_id, sender_name)
                           VALUES (?,?,?,?,?,?,?)`)
    .run(site.id, site.name, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '');
  res.json(db.prepare('SELECT * FROM site_messages WHERE id=?').get(info.lastInsertRowid));
});

// DELETE a message — sender or admin only.
router.delete('/:id', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM site_messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM site_messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
