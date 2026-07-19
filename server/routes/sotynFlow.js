// SOTYN Flow — Trello-style task boards. Uses its OWN database (sotynflow.db,
// separate from erp.db and chat.db) and pushes live updates over the shared
// Socket.IO (flow:* events, f:<boardId> rooms — see sotynFlowSocket.js). Access
// model:
//   • create        — any signed-in user (becomes the board's first board-admin)
//   • view / cards   — board membership (super-viewers: app admin OR can_see_all
//                      on the sotyn_flow module see & open every board)
//   • manage         — board-admin on that board, OR the app admin role
//                      (edit board, members, columns, delete, promote/demote)
// User names are denormalised into board.db rows; the only reach into erp.db is
// userName() + the can_see_all lookup.
const express = require('express');
const { getDb } = require('../db/schema');            // erp.db — names + can_see_all
const { getBoardDb } = require('../db/sotynFlowDb');   // separate board database
const { emitBoard } = require('../lib/sotynFlowSocket');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const quarantine = require('../lib/quarantine');       // reversible move-not-delete for orphaned attachments
const router = express.Router();
router.use(authMiddleware);

// Best-effort: move each attachment URL to quarantine (reversible; lazy-restored on
// re-serve if a DB revert re-references it). Never throws — attachment cleanup must
// not fail the delete it accompanies.
function quarantineUrls(urls) {
  for (const u of urls) { if (u) { try { quarantine.quarantineUrl(u); } catch (e) { /* best-effort */ } } }
}

// ── access helpers ──────────────────────────────────────────────────────────
const isAppAdmin = (req) => req.user.role === 'admin';
// Super-viewer: MAX(can_see_all) on the sotyn_flow module across the user's roles.
function hasSeeAll(uid) {
  try {
    const row = getDb().prepare(`
      SELECT MAX(rp.can_see_all) AS allowed
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'sotyn_flow'`).get(uid);
    return !!row?.allowed;
  } catch (_) { return false; }
}
const canSeeAllBoards = (req) => isAppAdmin(req) || hasSeeAll(req.user.id);
const userName = (uid) => { try { return getDb().prepare('SELECT name FROM users WHERE id=?').get(uid)?.name || ''; } catch { return ''; } };

const isMember = (db, b, uid) => !!db.prepare('SELECT 1 FROM board_members WHERE board_id=? AND user_id=?').get(b, uid);
const myRole = (db, b, uid) => db.prepare('SELECT role FROM board_members WHERE board_id=? AND user_id=?').get(b, uid)?.role || null;
const isBoardAdmin = (db, b, uid) => myRole(db, b, uid) === 'admin';
const canAccess = (db, req, b) => isMember(db, b, req.user.id) || canSeeAllBoards(req);
const canManage = (db, req, b) => isAppAdmin(req) || isBoardAdmin(db, b, req.user.id);
const adminCount = (db, b) => db.prepare("SELECT COUNT(*) c FROM board_members WHERE board_id=? AND role='admin'").get(b).c;

// ── misc helpers ────────────────────────────────────────────────────────────
const parseJson = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const colTitle = (db, colId) => db.prepare('SELECT title FROM board_columns WHERE id=?').get(colId)?.title || '';
const logActivity = (db, boardId, cardId, req, type, detail) =>
  db.prepare('INSERT INTO board_card_activity (card_id, board_id, actor_id, actor_name, type, detail) VALUES (?,?,?,?,?,?)')
    .run(cardId, boardId, req.user.id, req.user.name || '', type, detail || null);
// ── labels: fixed priority set (radio) + board custom labels ──────────────────
// The 4 priorities are VIRTUAL — never stored on a board, always injected on read
// (GET) and always accepted on a card's label_ids. That keeps them present on
// every board (any card editor can set one) with no palette seeding or migration.
// Only plain, colourless "custom" labels are ever persisted in boards.labels.
const PRIORITY_LABELS = [
  { id: 'p:urgent', name: 'Urgent', color: '#dc2626', kind: 'priority' },
  { id: 'p:high',   name: 'High',   color: '#ea580c', kind: 'priority' },
  { id: 'p:medium', name: 'Medium', color: '#d97706', kind: 'priority' },
  { id: 'p:low',    name: 'Low',    color: '#6b7280', kind: 'priority' },
];
const PRIORITY_IDS = new Set(PRIORITY_LABELS.map(l => l.id));
const priIdByName = new Map(PRIORITY_LABELS.map(l => [l.name.toLowerCase(), l.id]));
const CUSTOM_MAX = 3, CUSTOM_LEN = 16;

// Keep only stored CUSTOM labels (plain, colourless): drop priorities (virtual),
// drop legacy coloured / priority-named labels, clamp names, cap the count.
const sanitizeCustoms = (labels) => (Array.isArray(labels) ? labels : [])
  .filter(l => l && l.color == null && !PRIORITY_IDS.has(l.id) && !priIdByName.has(String(l.name || '').toLowerCase()))
  .map(l => ({ id: l.id, name: String(l.name || '').slice(0, CUSTOM_LEN), color: null, kind: 'custom' }))
  .slice(0, CUSTOM_MAX);

// Idempotent per-board normalization, run on board read. Strips legacy coloured
// labels from the palette, migrates legacy priority-named labels → the fixed p:
// ids on every card, and enforces ≤1 priority + the custom cap per card. Writes
// only when something changed, so steady-state loads stay read-only. Returns the
// clean custom palette.
function normalizeBoardLabels(db, boardId) {
  const board = db.prepare('SELECT labels FROM boards WHERE id=?').get(boardId);
  if (!board) return [];
  const stored = parseJson(board.labels, []);
  // Legacy priority-alias ids (matched by old p: id or by name) → canonical p: id.
  const alias = new Map();
  for (const l of stored) {
    if (!l) continue;
    if (PRIORITY_IDS.has(l.id)) alias.set(l.id, l.id);
    else { const byName = priIdByName.get(String(l.name || '').toLowerCase()); if (byName) alias.set(l.id, byName); }
  }
  const customs = sanitizeCustoms(stored);
  const customIds = new Set(customs.map(c => c.id));

  const cards = db.prepare('SELECT id, label_ids FROM board_cards WHERE board_id=?').all(boardId);
  const cardUpdates = [];
  for (const card of cards) {
    const ids = parseJson(card.label_ids, []);
    let pri = null; const kept = [];
    for (const id of ids) {
      const canon = alias.get(id) || (PRIORITY_IDS.has(id) ? id : null);
      if (canon) { if (!pri) pri = canon; }        // first priority wins (radio)
      else if (customIds.has(id)) kept.push(id);
    }
    const next = [...(pri ? [pri] : []), ...kept.slice(0, CUSTOM_MAX)];
    if (JSON.stringify(next) !== JSON.stringify(ids)) cardUpdates.push([card.id, JSON.stringify(next)]);
  }

  const paletteChanged = JSON.stringify(customs) !== JSON.stringify(stored);
  if (paletteChanged || cardUpdates.length) {
    db.transaction(() => {
      if (paletteChanged) db.prepare('UPDATE boards SET labels=? WHERE id=?').run(JSON.stringify(customs), boardId);
      const upd = db.prepare('UPDATE board_cards SET label_ids=? WHERE id=?');
      for (const [id, json] of cardUpdates) upd.run(json, id);
    })();
  }
  return customs;
}

// Card enrichment for the board payload.
const enrichCard = (db, c) => ({
  id: c.id, board_id: c.board_id, column_id: c.column_id, title: c.title, description: c.description,
  position: c.position, completed: c.completed, due_date: c.due_date,
  checklist: parseJson(c.checklist, []), label_ids: parseJson(c.label_ids, []),
  created_by: c.created_by, created_by_name: c.created_by_name, created_at: c.created_at, updated_at: c.updated_at,
  members: db.prepare('SELECT user_id, user_name AS name FROM board_card_members WHERE card_id=? ORDER BY user_name').all(c.id),
  comment_count: db.prepare('SELECT COUNT(*) c FROM board_card_comments WHERE card_id=?').get(c.id).c,
  attachment_count: db.prepare('SELECT COUNT(*) c FROM board_card_comments WHERE card_id=? AND attachment_url IS NOT NULL').get(c.id).c,
});

// ── boards ──────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getBoardDb(); const uid = req.user.id;
  const seeAll = canSeeAllBoards(req);
  const mineOnly = req.query.mine === '1';
  const q = String(req.query.q || '').trim().toLowerCase();
  let boards = (seeAll && !mineOnly)
    ? db.prepare('SELECT * FROM boards ORDER BY datetime(created_at) DESC, id DESC').all()
    : db.prepare('SELECT b.* FROM boards b JOIN board_members m ON m.board_id=b.id AND m.user_id=? ORDER BY datetime(b.created_at) DESC, b.id DESC').all(uid);
  if (q) boards = boards.filter(b => (b.name || '').toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q));
  const boardsOut = boards.map(b => ({
    id: b.id, name: b.name, description: b.description, labels: parseJson(b.labels, []),
    member_count: db.prepare('SELECT COUNT(*) c FROM board_members WHERE board_id=?').get(b.id).c,
    card_count: db.prepare('SELECT COUNT(*) c FROM board_cards WHERE board_id=?').get(b.id).c,
    column_count: db.prepare('SELECT COUNT(*) c FROM board_columns WHERE board_id=?').get(b.id).c,
    my_role: myRole(db, b.id, uid),
    members: db.prepare("SELECT user_id, user_name AS name, role FROM board_members WHERE board_id=? ORDER BY (role='admin') DESC, user_name LIMIT 8").all(b.id),
  }));
  res.json({ boards: boardsOut, can_see_all: seeAll });
});

router.post('/', requirePermission('sotyn_flow', 'create'), (req, res) => {
  const db = getBoardDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Board name is required' });
  const description = req.body?.description != null ? String(req.body.description) : null;
  const memberIds = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
  const create = db.transaction(() => {
    const bid = db.prepare('INSERT INTO boards (name, description, labels, created_by, created_by_name) VALUES (?,?,?,?,?)')
      .run(name, description, '[]', req.user.id, req.user.name || '').lastInsertRowid;
    const insMem = db.prepare('INSERT OR IGNORE INTO board_members (board_id, user_id, user_name, role, added_by) VALUES (?,?,?,?,?)');
    insMem.run(bid, req.user.id, req.user.name || '', 'admin', req.user.id);   // creator = board-admin
    for (const u of memberIds) if (u !== req.user.id) insMem.run(bid, u, userName(u), 'member', req.user.id);
    const insCol = db.prepare('INSERT INTO board_columns (board_id, title, position) VALUES (?,?,?)');
    ['To Do', 'In Progress', 'Done'].forEach((t, i) => insCol.run(bid, t, i + 1));
    return bid;
  });
  const bid = create();
  emitBoard(bid, 'changed', { boardId: bid });
  res.json({ id: bid, name });
});

router.get('/:id', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'You are not a member of this board' });
  const board = db.prepare('SELECT * FROM boards WHERE id=?').get(b);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const customs = normalizeBoardLabels(db, b);   // purge legacy + remap cards BEFORE we read cards
  const columns = db.prepare('SELECT id, title, position FROM board_columns WHERE board_id=? ORDER BY position, id').all(b);
  const cards = db.prepare('SELECT * FROM board_cards WHERE board_id=? ORDER BY position, id').all(b).map(c => enrichCard(db, c));
  const members = db.prepare("SELECT user_id, user_name AS name, role FROM board_members WHERE board_id=? ORDER BY (role='admin') DESC, user_name").all(b);
  res.json({
    board: { id: board.id, name: board.name, description: board.description, labels: [...PRIORITY_LABELS, ...customs], my_role: myRole(db, b, req.user.id) },
    columns, cards, members,
  });
});

router.put('/:id', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can edit this board' });
  if (!db.prepare('SELECT 1 FROM boards WHERE id=?').get(b)) return res.status(404).json({ error: 'Board not found' });
  const set = [], vals = [];
  if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n) return res.status(400).json({ error: 'Name required' }); set.push('name=?'); vals.push(n); }
  if (req.body?.description !== undefined) { set.push('description=?'); vals.push(req.body.description != null ? String(req.body.description) : null); }
  if (req.body?.labels !== undefined) { set.push('labels=?'); vals.push(JSON.stringify(sanitizeCustoms(req.body.labels))); }   // priorities are virtual; only customs persist
  if (set.length) db.prepare(`UPDATE boards SET ${set.join(', ')} WHERE id=?`).run(...vals, b);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can delete this board' });
  if (!db.prepare('SELECT 1 FROM boards WHERE id=?').get(b)) return res.status(404).json({ error: 'Not found' });
  const atts = db.prepare('SELECT attachment_url FROM board_card_comments WHERE board_id=? AND attachment_url IS NOT NULL').all(b).map(r => r.attachment_url);
  db.transaction(() => {
    const cardIds = db.prepare('SELECT id FROM board_cards WHERE board_id=?').all(b).map(r => r.id);
    db.prepare('DELETE FROM board_card_comments WHERE board_id=?').run(b);
    db.prepare('DELETE FROM board_card_activity WHERE board_id=?').run(b);
    for (const cid of cardIds) db.prepare('DELETE FROM board_card_members WHERE card_id=?').run(cid);
    db.prepare('DELETE FROM board_cards WHERE board_id=?').run(b);
    db.prepare('DELETE FROM board_columns WHERE board_id=?').run(b);
    db.prepare('DELETE FROM board_members WHERE board_id=?').run(b);
    db.prepare('DELETE FROM boards WHERE id=?').run(b);
  })();
  quarantineUrls(atts);
  emitBoard(b, 'board_deleted', { boardId: b });
  res.json({ ok: true });
});

// ── members ─────────────────────────────────────────────────────────────────
router.get('/:id/members', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare("SELECT user_id, user_name AS name, role FROM board_members WHERE board_id=? ORDER BY (role='admin') DESC, user_name").all(b));
});

router.post('/:id/members', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can add members' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(Number).filter(Boolean) : [];
  const ins = db.prepare("INSERT OR IGNORE INTO board_members (board_id, user_id, user_name, role, added_by) VALUES (?,?,?,'member',?)");
  let added = 0; db.transaction(() => { for (const u of ids) added += ins.run(b, u, userName(u), req.user.id).changes; })();
  emitBoard(b, 'changed', { boardId: b });
  res.json({ added });
});

router.delete('/:id/members/:userId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const u = +req.params.userId;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can remove members' });
  const target = db.prepare('SELECT role FROM board_members WHERE board_id=? AND user_id=?').get(b, u);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  if (target.role === 'admin' && adminCount(db, b) <= 1) return res.status(409).json({ error: 'A board must keep at least one admin' });
  db.transaction(() => {
    // drop this user from every card on the board, then the board itself
    const cardIds = db.prepare('SELECT id FROM board_cards WHERE board_id=?').all(b).map(r => r.id);
    const delCard = db.prepare('DELETE FROM board_card_members WHERE card_id=? AND user_id=?');
    for (const cid of cardIds) delCard.run(cid, u);
    db.prepare('DELETE FROM board_members WHERE board_id=? AND user_id=?').run(b, u);
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

router.put('/:id/members/:userId/role', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const u = +req.params.userId;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can change roles' });
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  const target = db.prepare('SELECT role FROM board_members WHERE board_id=? AND user_id=?').get(b, u);
  if (!target) return res.status(404).json({ error: 'Not a member' });
  if (target.role === 'admin' && role === 'member' && adminCount(db, b) <= 1)
    return res.status(409).json({ error: 'A board must keep at least one admin' });
  db.prepare('UPDATE board_members SET role=? WHERE board_id=? AND user_id=?').run(role, b, u);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

// ── columns (manage) ────────────────────────────────────────────────────────
router.post('/:id/columns', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can add columns' });
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Column title required' });
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM board_columns WHERE board_id=?').get(b).p;
  const id = db.prepare('INSERT INTO board_columns (board_id, title, position) VALUES (?,?,?)').run(b, title, pos).lastInsertRowid;
  emitBoard(b, 'changed', { boardId: b });
  res.json({ id, title, position: pos });
});

router.put('/:id/columns/:colId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.colId;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can edit columns' });
  if (!db.prepare('SELECT 1 FROM board_columns WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Column not found' });
  const set = [], vals = [];
  if (req.body?.title !== undefined) { const t = String(req.body.title).trim(); if (!t) return res.status(400).json({ error: 'Title required' }); set.push('title=?'); vals.push(t); }
  if (req.body?.position !== undefined) { set.push('position=?'); vals.push(Number(req.body.position) || 0); }
  if (set.length) db.prepare(`UPDATE board_columns SET ${set.join(', ')} WHERE id=?`).run(...vals, c);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

router.delete('/:id/columns/:colId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.colId;
  if (!canManage(db, req, b)) return res.status(403).json({ error: 'Only a board admin can delete columns' });
  if (!db.prepare('SELECT 1 FROM board_columns WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Column not found' });
  const atts = db.prepare('SELECT c.attachment_url FROM board_card_comments c JOIN board_cards k ON k.id=c.card_id WHERE k.column_id=? AND c.attachment_url IS NOT NULL').all(c).map(r => r.attachment_url);
  db.transaction(() => {
    const cardIds = db.prepare('SELECT id FROM board_cards WHERE column_id=?').all(c).map(r => r.id);
    for (const cid of cardIds) {
      db.prepare('DELETE FROM board_card_comments WHERE card_id=?').run(cid);
      db.prepare('DELETE FROM board_card_activity WHERE card_id=?').run(cid);
      db.prepare('DELETE FROM board_card_members WHERE card_id=?').run(cid);
    }
    db.prepare('DELETE FROM board_cards WHERE column_id=?').run(c);
    db.prepare('DELETE FROM board_columns WHERE id=?').run(c);
  })();
  quarantineUrls(atts);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

// ── cards (any board member) ──────────────────────────────────────────────────
router.post('/:id/cards', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  const columnId = +req.body?.column_id;
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Card title required' });
  if (!db.prepare('SELECT 1 FROM board_columns WHERE id=? AND board_id=?').get(columnId, b)) return res.status(400).json({ error: 'Invalid column' });
  const memberIds = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
  const cardId = db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM board_cards WHERE column_id=?').get(columnId).p;
    const id = db.prepare('INSERT INTO board_cards (board_id, column_id, title, description, position, checklist, label_ids, created_by, created_by_name) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(b, columnId, title, req.body?.description != null ? String(req.body.description) : null, pos, '[]', '[]', req.user.id, req.user.name || '').lastInsertRowid;
    const insM = db.prepare('INSERT OR IGNORE INTO board_card_members (card_id, user_id, user_name) VALUES (?,?,?)');
    for (const u of memberIds) if (isMember(db, b, u)) insM.run(id, u, userName(u));
    logActivity(db, b, id, req, 'created', `added this card to ${colTitle(db, columnId)}`);
    return id;
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json(enrichCard(db, db.prepare('SELECT * FROM board_cards WHERE id=?').get(cardId)));
});

router.put('/:id/cards/:cardId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  const card = db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(c, b);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const set = [], vals = [], acts = [];
  if (req.body?.title !== undefined) { const t = String(req.body.title).trim(); if (!t) return res.status(400).json({ error: 'Title required' }); if (t !== card.title) acts.push(['renamed', `renamed to “${t}”`]); set.push('title=?'); vals.push(t); }
  if (req.body?.description !== undefined) { set.push('description=?'); vals.push(req.body.description != null ? String(req.body.description) : null); if ((req.body.description || '') !== (card.description || '')) acts.push(['described', 'updated the description']); }
  if (req.body?.completed !== undefined) { const done = req.body.completed ? 1 : 0; if (done !== card.completed) acts.push([done ? 'completed' : 'reopened', done ? 'marked this card complete' : 'reopened this card']); set.push('completed=?'); vals.push(done); }
  if (req.body?.due_date !== undefined) { set.push('due_date=?'); vals.push(req.body.due_date ? String(req.body.due_date) : null); }
  if (req.body?.checklist !== undefined) { set.push('checklist=?'); vals.push(JSON.stringify(Array.isArray(req.body.checklist) ? req.body.checklist : [])); }
  if (req.body?.label_ids !== undefined) {
    const stored = parseJson(db.prepare('SELECT labels FROM boards WHERE id=?').get(b)?.labels, []);
    const validCustom = new Set(sanitizeCustoms(stored).map(l => l.id));
    let pri = null; const customs = [];
    for (const id of (Array.isArray(req.body.label_ids) ? req.body.label_ids : [])) {
      if (PRIORITY_IDS.has(id)) { if (!pri) pri = id; }   // ≤1 priority (radio); priorities always valid
      else if (validCustom.has(id)) customs.push(id);
    }
    const ids = [...(pri ? [pri] : []), ...customs.slice(0, CUSTOM_MAX)];
    set.push('label_ids=?'); vals.push(JSON.stringify(ids));
  }
  db.transaction(() => {
    if (set.length) { set.push("updated_at=CURRENT_TIMESTAMP"); db.prepare(`UPDATE board_cards SET ${set.join(', ')} WHERE id=?`).run(...vals, c); }
    for (const [t, d] of acts) logActivity(db, b, c, req, t, d);
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json(enrichCard(db, db.prepare('SELECT * FROM board_cards WHERE id=?').get(c)));
});

router.put('/:id/cards/:cardId/move', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  const card = db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(c, b);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const toCol = +req.body?.column_id;
  if (!db.prepare('SELECT 1 FROM board_columns WHERE id=? AND board_id=?').get(toCol, b)) return res.status(400).json({ error: 'Invalid column' });
  const pos = req.body?.position != null ? Number(req.body.position)
    : db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM board_cards WHERE column_id=?').get(toCol).p;
  db.transaction(() => {
    db.prepare('UPDATE board_cards SET column_id=?, position=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(toCol, pos, c);
    if (toCol !== card.column_id) logActivity(db, b, c, req, 'moved', `moved ${colTitle(db, card.column_id)} → ${colTitle(db, toCol)}`);
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

router.delete('/:id/cards/:cardId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  if (!db.prepare('SELECT 1 FROM board_cards WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Card not found' });
  const atts = db.prepare('SELECT attachment_url FROM board_card_comments WHERE card_id=? AND attachment_url IS NOT NULL').all(c).map(r => r.attachment_url);
  db.transaction(() => {
    db.prepare('DELETE FROM board_card_comments WHERE card_id=?').run(c);
    db.prepare('DELETE FROM board_card_activity WHERE card_id=?').run(c);
    db.prepare('DELETE FROM board_card_members WHERE card_id=?').run(c);
    db.prepare('DELETE FROM board_cards WHERE id=?').run(c);
  })();
  quarantineUrls(atts);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

// ── card assignment ───────────────────────────────────────────────────────────
router.post('/:id/cards/:cardId/members', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  if (!db.prepare('SELECT 1 FROM board_cards WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Card not found' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(Number).filter(Boolean) : [];
  const ins = db.prepare('INSERT OR IGNORE INTO board_card_members (card_id, user_id, user_name) VALUES (?,?,?)');
  db.transaction(() => {
    for (const u of ids) {
      if (!isMember(db, b, u)) continue;                 // assignee must be a board member
      if (ins.run(c, u, userName(u)).changes) logActivity(db, b, c, req, 'assigned', `assigned ${userName(u)}`);
    }
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json(db.prepare('SELECT user_id, user_name AS name FROM board_card_members WHERE card_id=? ORDER BY user_name').all(c));
});

router.delete('/:id/cards/:cardId/members/:userId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId; const u = +req.params.userId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  if (!db.prepare('SELECT 1 FROM board_cards WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Card not found' });
  db.transaction(() => {
    if (db.prepare('DELETE FROM board_card_members WHERE card_id=? AND user_id=?').run(c, u).changes) logActivity(db, b, c, req, 'unassigned', `removed ${userName(u)}`);
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

// ── card conversation (comments + activity) ──────────────────────────────────
router.get('/:id/cards/:cardId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  const card = db.prepare('SELECT * FROM board_cards WHERE id=? AND board_id=?').get(c, b);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const comments = db.prepare('SELECT * FROM board_card_comments WHERE card_id=? ORDER BY id').all(c);
  const activity = db.prepare('SELECT * FROM board_card_activity WHERE card_id=? ORDER BY id').all(c);
  res.json({ card: enrichCard(db, card), comments, activity });
});

router.post('/:id/cards/:cardId/comments', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const c = +req.params.cardId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  if (!db.prepare('SELECT 1 FROM board_cards WHERE id=? AND board_id=?').get(c, b)) return res.status(404).json({ error: 'Card not found' });
  const { body, attachment_url, attachment_name } = req.body || {};
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a comment or attach a file' });
  const id = db.transaction(() => {
    const rid = db.prepare('INSERT INTO board_card_comments (card_id, board_id, body, attachment_url, attachment_name, sender_id, sender_name) VALUES (?,?,?,?,?,?,?)')
      .run(c, b, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '').lastInsertRowid;
    if (attachment_url) logActivity(db, b, c, req, 'attached', `attached ${attachment_name || 'a file'}`);
    return rid;
  })();
  emitBoard(b, 'changed', { boardId: b });
  res.json(db.prepare('SELECT * FROM board_card_comments WHERE id=?').get(id));
});

router.delete('/:id/cards/:cardId/comments/:commentId', (req, res) => {
  const db = getBoardDb(); const b = +req.params.id; const cm = +req.params.commentId;
  if (!canAccess(db, req, b)) return res.status(403).json({ error: 'Not a member' });
  const comment = db.prepare('SELECT * FROM board_card_comments WHERE id=? AND board_id=?').get(cm, b);
  if (!comment) return res.status(404).json({ error: 'Not found' });
  if (comment.sender_id !== req.user.id && !canManage(db, req, b)) return res.status(403).json({ error: 'You can only delete your own comments' });
  db.prepare('DELETE FROM board_card_comments WHERE id=?').run(cm);
  if (comment.attachment_url) quarantineUrls([comment.attachment_url]);
  emitBoard(b, 'changed', { boardId: b });
  res.json({ ok: true });
});

module.exports = router;
