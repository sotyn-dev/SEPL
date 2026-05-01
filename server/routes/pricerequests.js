const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Anyone with item-master view permission (or admin) can also approve /
// finalize price requests — same gate as Procurement uses for vendor rates.
const canQuote = (req) => req.user.role === 'admin' || (() => {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(rp.can_approve) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module IN ('procurement','item_master')
  `).get(req.user.id);
  return !!row?.ok;
})();

// ------- LIST -------
// scope=mine | all   (non-quoters always see their own; quoters see all by default)
// status=open|quoted|finalized|added
router.get('/', (req, res) => {
  const db = getDb();
  const isQuoter = canQuote(req);
  const { status, scope } = req.query;
  const where = []; const params = [];
  // Regular users only see what they raised. Quoters see everything by default
  // but can switch to "mine" to focus on their own raises.
  if (!isQuoter || scope === 'mine') { where.push('p.raised_by = ?'); params.push(req.user.id); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  const sql = `
    SELECT p.*, u.name as raised_by_name, fu.name as finalized_by_name
      FROM price_requests p
      LEFT JOIN users u  ON u.id  = p.raised_by
      LEFT JOIN users fu ON fu.id = p.finalized_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.status='added' ASC, p.created_at DESC
  `;
  res.json(db.prepare(sql).all(...params));
});

// ------- CREATE (Stage 1) -------
// Any authenticated user. Site engineer raises a request for a new item.
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.item_name || !String(b.item_name).trim()) {
    return res.status(400).json({ error: 'Item name is required' });
  }
  const allowedTypes = ['PO', 'FOC', 'RGP'];
  const itemType = allowedTypes.includes(String(b.item_type || '').toUpperCase())
    ? String(b.item_type).toUpperCase() : 'PO';
  const r = getDb().prepare(`
    INSERT INTO price_requests
      (site_name, item_name, size, specification, make, uom, item_type, notes, raised_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    b.site_name || null,
    String(b.item_name).trim(),
    b.size || null,
    b.specification || null,
    b.make || null,
    b.uom || 'PCS',
    itemType,
    b.notes || null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

// ------- DELETE (raiser or admin) -------
router.delete('/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT raised_by, status FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const isOwner = cur.raised_by === req.user.id;
  if (!(req.user.role === 'admin' || isOwner)) return res.status(403).json({ error: 'Not allowed' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Cannot delete after item promoted to master' });
  db.prepare('DELETE FROM price_requests WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ------- GROUPED VIEW (Stage 2 — for the quoting team) -------
// Identical items raised by multiple sites collapse into one row so vendor
// rates are entered once. Group key: lower(item_name, size, spec, make, uom, item_type).
// One representative request id is returned to act as the "merge anchor".
router.get('/grouped', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  // Pull every non-added request and group in JS — small dataset, easier to reason about.
  const rows = db.prepare(`
    SELECT p.*, u.name as raised_by_name
      FROM price_requests p
      LEFT JOIN users u ON u.id = p.raised_by
     WHERE p.status IN ('open','quoted')
     ORDER BY p.created_at ASC
  `).all();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const map = new Map();
  for (const r of rows) {
    const key = [r.item_name, r.size, r.specification, r.make, r.uom, r.item_type].map(norm).join('|');
    if (!map.has(key)) {
      map.set(key, {
        anchor_id: r.id,
        item_name: r.item_name, size: r.size, specification: r.specification,
        make: r.make, uom: r.uom, item_type: r.item_type,
        request_ids: [],
        sites: [],
        // vendor + final fields are taken from the anchor (first request) so
        // updates always target a single canonical id.
        vendor1_name: r.vendor1_name, vendor1_rate: r.vendor1_rate, vendor1_terms: r.vendor1_terms,
        vendor2_name: r.vendor2_name, vendor2_rate: r.vendor2_rate, vendor2_terms: r.vendor2_terms,
        vendor3_name: r.vendor3_name, vendor3_rate: r.vendor3_rate, vendor3_terms: r.vendor3_terms,
        final_vendor_name: r.final_vendor_name, final_rate: r.final_rate, final_terms: r.final_terms,
        status: r.status,
      });
    }
    const g = map.get(key);
    g.request_ids.push(r.id);
    if (r.site_name && !g.sites.includes(r.site_name)) g.sites.push(r.site_name);
  }
  res.json([...map.values()]);
});

// ------- UPDATE VENDOR RATE (Stage 2) -------
// Patch one or more vendor fields on the anchor. The status auto-flips to
// 'quoted' once any vendor has a positive rate.
router.put('/:id/rate', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Already promoted to master' });

  const b = req.body || {};
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };
  for (const n of [1, 2, 3]) {
    if (b[`vendor${n}_name`] !== undefined)  set(`vendor${n}_name`,  b[`vendor${n}_name`] || null);
    if (b[`vendor${n}_rate`] !== undefined)  set(`vendor${n}_rate`,  b[`vendor${n}_rate`] === '' ? null : +b[`vendor${n}_rate`]);
    if (b[`vendor${n}_terms`] !== undefined) set(`vendor${n}_terms`, b[`vendor${n}_terms`] || null);
  }
  // Bump status to 'quoted' once at least one vendor has rate > 0
  const nextRow = { ...cur };
  for (const k of sets) {} // (no-op — sets is array of strings)
  // Re-derive from the patch + cur
  const merged = { ...cur };
  if (b.vendor1_rate !== undefined) merged.vendor1_rate = +b.vendor1_rate || 0;
  if (b.vendor2_rate !== undefined) merged.vendor2_rate = +b.vendor2_rate || 0;
  if (b.vendor3_rate !== undefined) merged.vendor3_rate = +b.vendor3_rate || 0;
  const anyRate = [merged.vendor1_rate, merged.vendor2_rate, merged.vendor3_rate].some(v => +v > 0);
  if (cur.status !== 'finalized' && anyRate) set('status', 'quoted');

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE price_requests SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Rate updated' });
});

// ------- FINALIZE + PROMOTE TO ITEM MASTER (Stages 3 + 4) -------
// Body: { final_vendor_name, final_rate, final_terms, propagate_to_group: bool }
// If propagate_to_group is true (default), the finalize is also written to all
// other requests sharing the same item identity, AND a single item_master entry
// is created and linked to every one of them.
router.post('/:id/finalize', (req, res) => {
  if (!canQuote(req)) return res.status(403).json({ error: 'Quoting permission required' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM price_requests WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  if (cur.status === 'added') return res.status(400).json({ error: 'Already promoted to master' });

  const { final_vendor_name, final_rate, final_terms, propagate_to_group } = req.body || {};
  if (!final_vendor_name || !(+final_rate > 0)) {
    return res.status(400).json({ error: 'Final vendor name and a positive final rate are required' });
  }

  // Find sibling requests (same item identity) when propagation is on
  const propagate = propagate_to_group !== false;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const myKey = [cur.item_name, cur.size, cur.specification, cur.make, cur.uom, cur.item_type].map(norm).join('|');
  const allOpen = db.prepare(`SELECT * FROM price_requests WHERE status IN ('open','quoted')`).all();
  const siblings = propagate
    ? allOpen.filter(r => [r.item_name, r.size, r.specification, r.make, r.uom, r.item_type].map(norm).join('|') === myKey)
    : [cur];
  // Always include `cur` even if it's already 'finalized'
  if (!siblings.find(s => s.id === cur.id)) siblings.push(cur);

  // 1) Auto-generate item_code by reusing item_master's existing pattern. We
  //    derive a 3-letter prefix from the type (PO / FOC / RGP) and append the
  //    next id, e.g. PO-0042. The item_master upsert below ignores duplicates
  //    on item_code, so we keep the format simple and unique-enough.
  const seq = db.prepare(`SELECT COUNT(*) as c FROM item_master`).get().c + 1;
  const codePrefix = String(cur.item_type || 'PO').toUpperCase();
  const itemCode = `${codePrefix}-${String(seq).padStart(4, '0')}`;
  const itemMasterIns = db.prepare(`
    INSERT INTO item_master
      (item_code, item_name, specification, size, uom, type, make, current_price, gst, department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = itemMasterIns.run(
    itemCode,
    cur.item_name,
    cur.specification || '',
    cur.size || '',
    cur.uom || 'PCS',
    cur.item_type || 'PO',
    final_vendor_name || cur.make || '',
    +final_rate || 0,
    '18%',
    null,
  );
  const newMasterId = r.lastInsertRowid;

  // 2) Update every sibling request: set final fields, status='added', link to master.
  const upd = db.prepare(`
    UPDATE price_requests
       SET final_vendor_name = ?,
           final_rate        = ?,
           final_terms       = ?,
           finalized_by      = ?,
           finalized_at      = CURRENT_TIMESTAMP,
           status            = 'added',
           item_master_id    = ?,
           updated_at        = CURRENT_TIMESTAMP
     WHERE id = ?
  `);
  for (const s of siblings) {
    upd.run(final_vendor_name, +final_rate, final_terms || null, req.user.id, newMasterId, s.id);
  }

  res.json({
    message: 'Rate finalized and item added to Item Master',
    item_master_id: newMasterId,
    item_code: itemCode,
    propagated_count: siblings.length,
  });
});

module.exports = router;
