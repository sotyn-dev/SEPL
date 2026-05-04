// Room Rental management — properties (flats/houses we rent),
// rooms within them, bookings (which employee stays where + when),
// and monthly rent payments to landlord. Used to track staff
// accommodation across project sites.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);

// ---------- DASHBOARD STATS ----------
router.get('/stats', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const db = getDb();
    const totalProps = db.prepare(`SELECT COUNT(*) as c FROM rental_properties WHERE status='active'`).get().c;
    const totalRooms = db.prepare(`SELECT COUNT(*) as c FROM rental_rooms`).get().c;
    const occupiedRooms = db.prepare(`SELECT COUNT(*) as c FROM rental_rooms WHERE status='occupied'`).get().c;
    const monthlyBurn = db.prepare(`SELECT COALESCE(SUM(monthly_rent),0) as s FROM rental_properties WHERE status='active'`).get().s;
    const totalDeposit = db.prepare(`SELECT COALESCE(SUM(deposit_paid),0) as s FROM rental_properties WHERE status='active'`).get().s;
    const expiringSoon = db.prepare(`
      SELECT COUNT(*) as c FROM rental_properties
      WHERE status='active' AND agreement_end_date IS NOT NULL
        AND agreement_end_date <= date('now', '+30 days')
    `).get().c;
    const activeBookings = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE status='active'`).get().c;
    res.json({
      total_properties: totalProps,
      total_rooms: totalRooms,
      occupied_rooms: occupiedRooms,
      vacant_rooms: totalRooms - occupiedRooms,
      monthly_burn: monthlyBurn,
      total_deposit_locked: totalDeposit,
      agreements_expiring_30d: expiringSoon,
      active_bookings: activeBookings,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- PROPERTIES ----------
router.get('/properties', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { status, search, city } = req.query;
    let sql = `
      SELECT p.*, s.name as site_name,
             (SELECT COUNT(*) FROM rental_rooms r WHERE r.property_id = p.id) as room_count,
             (SELECT COUNT(*) FROM rental_rooms r WHERE r.property_id = p.id AND r.status='occupied') as occupied_count,
             (SELECT COUNT(*) FROM rental_bookings b WHERE b.property_id = p.id AND b.status='active') as active_bookings
      FROM rental_properties p
      LEFT JOIN sites s ON s.id = p.site_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND p.status = ?'; params.push(status); }
    if (city) { sql += ' AND LOWER(p.city) LIKE ?'; params.push(`%${city.toLowerCase()}%`); }
    if (search) {
      sql += ' AND (LOWER(p.name) LIKE ? OR LOWER(p.address) LIKE ? OR LOWER(p.landlord_name) LIKE ?)';
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q);
    }
    sql += ' ORDER BY p.created_at DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/properties/:id', requirePermission('rentals', 'view'), (req, res) => {
  const db = getDb();
  const prop = db.prepare(`
    SELECT p.*, s.name as site_name FROM rental_properties p
    LEFT JOIN sites s ON s.id = p.site_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  const rooms = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM rental_bookings b WHERE b.room_id = r.id AND b.status='active') as occupant_count
    FROM rental_rooms r WHERE r.property_id = ? ORDER BY r.id
  `).all(req.params.id);
  const bookings = db.prepare(`
    SELECT b.*, r.room_name, u.name as occupant_user_name
    FROM rental_bookings b
    LEFT JOIN rental_rooms r ON r.id = b.room_id
    LEFT JOIN users u ON u.id = b.occupant_user_id
    WHERE b.property_id = ?
    ORDER BY b.status='active' DESC, b.check_in_date DESC
  `).all(req.params.id);
  const payments = db.prepare(`
    SELECT * FROM rental_payments WHERE property_id = ? ORDER BY period_month DESC
  `).all(req.params.id);
  res.json({ ...prop, rooms, bookings, payments });
});

router.post('/properties', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.name) return res.status(400).json({ error: 'Name is required' });
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO rental_properties (
        name, address, city, state, pincode,
        landlord_name, landlord_phone, landlord_email,
        monthly_rent, deposit_paid, agreement_start_date, agreement_end_date,
        bedrooms, total_capacity, amenities, agreement_file_url,
        status, notes, site_id, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      b.name, b.address || null, b.city || null, b.state || null, b.pincode || null,
      b.landlord_name || null, b.landlord_phone || null, b.landlord_email || null,
      b.monthly_rent || 0, b.deposit_paid || 0, b.agreement_start_date || null, b.agreement_end_date || null,
      b.bedrooms || 1, b.total_capacity || 1, b.amenities || null, b.agreement_file_url || null,
      b.status || 'active', b.notes || null, b.site_id || null, req.user.id
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/properties/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['name','address','city','state','pincode','landlord_name','landlord_phone','landlord_email','monthly_rent','deposit_paid','agreement_start_date','agreement_end_date','bedrooms','total_capacity','amenities','agreement_file_url','status','notes','site_id'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    sets.push('updated_at=CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_properties SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/properties/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM rental_payments WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_bookings WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_rooms WHERE property_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_properties WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- ROOMS ----------
router.post('/properties/:property_id/rooms', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.room_name) return res.status(400).json({ error: 'Room name required' });
    const r = getDb().prepare(`
      INSERT INTO rental_rooms (property_id, room_name, capacity, status, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.property_id, b.room_name, b.capacity || 1, b.status || 'available', b.notes || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rooms/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['room_name','capacity','status','notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_rooms SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rooms/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM rental_bookings WHERE room_id=?').run(req.params.id);
  db.prepare('DELETE FROM rental_rooms WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- BOOKINGS ----------
router.get('/bookings', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { status, occupant_user_id, site_id } = req.query;
    let sql = `
      SELECT b.*, r.room_name, p.name as property_name, p.city,
             u.name as occupant_user_name, s.name as site_name
      FROM rental_bookings b
      LEFT JOIN rental_rooms r ON r.id = b.room_id
      LEFT JOIN rental_properties p ON p.id = b.property_id
      LEFT JOIN users u ON u.id = b.occupant_user_id
      LEFT JOIN sites s ON s.id = b.site_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { sql += ' AND b.status=?'; params.push(status); }
    if (occupant_user_id) { sql += ' AND b.occupant_user_id=?'; params.push(occupant_user_id); }
    if (site_id) { sql += ' AND b.site_id=?'; params.push(site_id); }
    sql += ' ORDER BY b.status="active" DESC, b.check_in_date DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bookings', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.room_id || !b.check_in_date) return res.status(400).json({ error: 'room_id and check_in_date required' });
    if (!b.occupant_user_id && !b.occupant_name) return res.status(400).json({ error: 'Pick a user or type occupant name' });
    const db = getDb();
    const room = db.prepare('SELECT property_id, capacity, status FROM rental_rooms WHERE id=?').get(b.room_id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO rental_bookings (
          room_id, property_id, occupant_user_id, occupant_name, occupant_phone,
          check_in_date, check_out_date, site_id, rent_share, deposit_collected,
          status, notes, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        b.room_id, room.property_id, b.occupant_user_id || null, b.occupant_name || null, b.occupant_phone || null,
        b.check_in_date, b.check_out_date || null, b.site_id || null,
        b.rent_share || 0, b.deposit_collected || 0,
        'active', b.notes || null, req.user.id
      );
      // Mark room occupied
      db.prepare(`UPDATE rental_rooms SET status='occupied' WHERE id=?`).run(b.room_id);
      return r.lastInsertRowid;
    });
    const id = tx();
    // Notify the occupant if they're a user
    if (b.occupant_user_id) {
      try {
        const { notify } = require('../lib/push');
        notify(b.occupant_user_id, {
          title: '🏠 Room Booked for You',
          body: `Check-in ${b.check_in_date} at ${b.occupant_name || 'rental property'}`,
          url: '/rentals',
          tag: `booking-${id}`,
        });
      } catch {}
    }
    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/bookings/:id', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const fields = ['occupant_user_id','occupant_name','occupant_phone','check_in_date','check_out_date','actual_checkout_date','site_id','rent_share','deposit_collected','status','notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields' });
    vals.push(req.params.id);
    db.prepare(`UPDATE rental_bookings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bookings/:id/check-out', requirePermission('rentals', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const booking = db.prepare('SELECT * FROM rental_bookings WHERE id=?').get(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE rental_bookings
        SET status='completed',
            actual_checkout_date = COALESCE(?, date('now')),
            notes = COALESCE(?, notes)
        WHERE id=?
      `).run(req.body.actual_checkout_date || null, req.body.notes || null, req.params.id);
      // If no other active bookings on this room, mark available
      const others = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE room_id=? AND status='active' AND id != ?`).get(booking.room_id, req.params.id).c;
      if (others === 0) db.prepare(`UPDATE rental_rooms SET status='available' WHERE id=?`).run(booking.room_id);
    });
    tx();
    res.json({ message: 'Checked out' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bookings/:id', requirePermission('rentals', 'delete'), (req, res) => {
  const db = getDb();
  const booking = db.prepare('SELECT room_id FROM rental_bookings WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM rental_bookings WHERE id=?').run(req.params.id);
  if (booking) {
    const others = db.prepare(`SELECT COUNT(*) as c FROM rental_bookings WHERE room_id=? AND status='active'`).get(booking.room_id).c;
    if (others === 0) db.prepare(`UPDATE rental_rooms SET status='available' WHERE id=?`).run(booking.room_id);
  }
  res.json({ message: 'Deleted' });
});

// ---------- PAYMENTS ----------
router.get('/payments', requirePermission('rentals', 'view'), (req, res) => {
  try {
    const { property_id, period_month } = req.query;
    let sql = `
      SELECT pay.*, p.name as property_name, p.landlord_name
      FROM rental_payments pay
      LEFT JOIN rental_properties p ON p.id = pay.property_id
      WHERE 1=1
    `;
    const params = [];
    if (property_id) { sql += ' AND pay.property_id=?'; params.push(property_id); }
    if (period_month) { sql += ' AND pay.period_month=?'; params.push(period_month); }
    sql += ' ORDER BY pay.period_month DESC, pay.created_at DESC';
    res.json(getDb().prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/payments', requirePermission('rentals', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.property_id || !b.period_month) return res.status(400).json({ error: 'property_id and period_month required' });
    const db = getDb();
    db.prepare(`
      INSERT INTO rental_payments (property_id, period_month, amount_paid, paid_date, paid_via, transaction_ref, receipt_url, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(property_id, period_month) DO UPDATE SET
        amount_paid=excluded.amount_paid,
        paid_date=excluded.paid_date,
        paid_via=excluded.paid_via,
        transaction_ref=excluded.transaction_ref,
        receipt_url=COALESCE(excluded.receipt_url, receipt_url),
        notes=excluded.notes
    `).run(
      b.property_id, b.period_month, b.amount_paid || 0, b.paid_date || null,
      b.paid_via || null, b.transaction_ref || null, b.receipt_url || null,
      b.notes || null, req.user.id
    );
    res.status(201).json({ message: 'Saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/payments/:id', requirePermission('rentals', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM rental_payments WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
