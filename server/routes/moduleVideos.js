// Per-module training videos (mam 2026-08-19): "give one small training video
// button like admin add and everyone can view".
//
// LINKS ONLY — deliberately no file upload. A YouTube link costs no disk and no
// streaming load on the VPS (uploading would push every viewer's playback through
// Node on a box with OOM history), and it works on phones with any video length.
//
// Anyone signed in can VIEW the list; only admin can add / edit / remove.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

router.use(authMiddleware);

// Accept the shapes people actually paste, and return a canonical embed URL.
// Anything that isn't a recognisable YouTube link is rejected rather than
// stored raw — a bare string here would end up in an href/iframe, and
// 'javascript:' / 'data:' URLs must never reach either.
function parseYouTube(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s.startsWith('http') ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] || null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const parts = u.pathname.split('/').filter(Boolean);       // embed/<id>, shorts/<id>, live/<id>, v/<id>
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || null;
    }
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  // Carry a start time through if the person copied "share at current time".
  const t = u.searchParams.get('t') || u.searchParams.get('start');
  const start = t && /^\d+s?$/.test(t) ? parseInt(t, 10) : null;
  return {
    video_id: id,
    watch_url: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`,
    embed_url: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
  };
}

const shape = (r) => {
  const p = parseYouTube(r.url) || {};
  return { ...r, video_id: p.video_id || null, watch_url: p.watch_url || null, embed_url: p.embed_url || null };
};

// GET /api/module-videos?module=procurement — any signed-in user.
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const mod = String(req.query.module || '').trim();
    const rows = mod
      ? db.prepare(`SELECT v.*, u.name AS created_by_name FROM module_help_videos v
                    LEFT JOIN users u ON u.id = v.created_by
                    WHERE v.module = ? ORDER BY v.sort_order, v.id`).all(mod)
      : db.prepare(`SELECT v.*, u.name AS created_by_name FROM module_help_videos v
                    LEFT JOIN users u ON u.id = v.created_by
                    ORDER BY v.module, v.sort_order, v.id`).all();
    res.json(rows.map(shape));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/module-videos — admin only.
router.post('/', adminOnly, (req, res) => {
  try {
    const mod = String(req.body?.module || '').trim();
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const parsed = parseYouTube(req.body?.url);
    if (!mod) return res.status(400).json({ error: 'Module is required' });
    if (!title) return res.status(400).json({ error: 'Give the video a title (e.g. "How to raise an indent")' });
    if (!parsed) return res.status(400).json({ error: "That doesn't look like a YouTube link. Paste the address from the browser or the Share button (youtube.com/watch?v=… or youtu.be/…)." });

    const db = getDb();
    const info = db.prepare(
      `INSERT INTO module_help_videos (module, title, url, created_by) VALUES (?,?,?,?)`
    ).run(mod, title, parsed.watch_url, req.user.id);
    logAuditEvent({
      user: req.user, action: 'TRAINING_VIDEO_ADD', entity_type: 'module_help_video',
      entity_id: info.lastInsertRowid, entity_label: `${mod}: ${title}`,
      method: 'POST', path: '/api/module-videos', status_code: 201,
    });
    res.status(201).json({ message: 'Training video added — everyone can watch it now.', id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/module-videos/:id — admin only (rename / re-link).
router.put('/:id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM module_help_videos WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Video not found' });
    const title = req.body?.title !== undefined ? String(req.body.title).trim().slice(0, 120) : row.title;
    if (!title) return res.status(400).json({ error: 'Title cannot be empty' });
    let url = row.url;
    if (req.body?.url !== undefined) {
      const parsed = parseYouTube(req.body.url);
      if (!parsed) return res.status(400).json({ error: 'That doesn\'t look like a YouTube link.' });
      url = parsed.watch_url;
    }
    db.prepare('UPDATE module_help_videos SET title=?, url=? WHERE id=?').run(title, url, row.id);
    logAuditEvent({
      user: req.user, action: 'TRAINING_VIDEO_EDIT', entity_type: 'module_help_video',
      entity_id: row.id, entity_label: `${row.module}: ${title}`,
      method: 'PUT', path: '/api/module-videos', status_code: 200,
    });
    res.json({ message: 'Saved' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/module-videos/:id — admin only.
router.delete('/:id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM module_help_videos WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Video not found' });
    db.prepare('DELETE FROM module_help_videos WHERE id=?').run(row.id);
    logAuditEvent({
      user: req.user, action: 'TRAINING_VIDEO_REMOVE', entity_type: 'module_help_video',
      entity_id: row.id, entity_label: `${row.module}: ${row.title}`,
      method: 'DELETE', path: '/api/module-videos', status_code: 200,
    });
    res.json({ message: 'Removed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
