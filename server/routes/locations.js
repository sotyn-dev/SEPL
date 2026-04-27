// Admin-only Live Location + Timeline API.
//
// Reads from the existing `location_tracking` table that the Attendance
// page already populates every 30s via /attendance/track-location. No
// new write paths — just two read views for admin / mam:
//
//   GET /api/admin/locations/live   — latest ping per user in last 30 min
//   GET /api/admin/locations/timeline?user_id=N&date=YYYY-MM-DD
//                                    — full ping history for one user / day,
//                                      with distance-from-previous so mam
//                                      can see how much they moved.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

// Haversine — meters between two GPS points.
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/admin/locations/live
//   ?stale_minutes=N   how old a ping can be and still count as "live" (default 30)
//
// Returns one row per user — their MOST RECENT ping in the staleness window.
// Sorted: in-site first, then most-recent first. Useful for a "who is where
// right now" map / list.
router.get('/live', (req, res) => {
  const db = getDb();
  const staleMin = Math.max(1, Math.min(720, parseInt(req.query.stale_minutes, 10) || 30));
  const sinceIso = new Date(Date.now() - staleMin * 60 * 1000).toISOString();

  // Pick the latest ping per user_id within the staleness window.
  // SQLite-friendly: group by user_id, get max(time), then re-join to get the row.
  const rows = db.prepare(
    `SELECT lt.user_id, u.name as user_name, u.department, u.role,
            lt.latitude, lt.longitude, lt.address, lt.site_name, lt.time
       FROM location_tracking lt
       JOIN users u ON u.id = lt.user_id
       JOIN (
         SELECT user_id, MAX(time) as max_time
           FROM location_tracking
          WHERE time >= ?
          GROUP BY user_id
       ) latest ON latest.user_id = lt.user_id AND latest.max_time = lt.time
      ORDER BY (CASE WHEN lt.site_name IS NULL OR lt.site_name = 'Outside' THEN 1 ELSE 0 END),
               lt.time DESC`
  ).all(sinceIso);

  const now = Date.now();
  res.json({
    stale_minutes: staleMin,
    as_of: new Date().toISOString(),
    users: rows.map(r => ({
      user_id: r.user_id,
      user_name: r.user_name,
      department: r.department,
      role: r.role,
      latitude: r.latitude,
      longitude: r.longitude,
      address: r.address,
      site_name: r.site_name,
      time: r.time,
      minutes_ago: Math.round((now - new Date(r.time).getTime()) / 60000),
    })),
  });
});

// GET /api/admin/locations/timeline?user_id=N&date=YYYY-MM-DD
//
// All pings for that user on that date, ordered by time, with the
// straight-line distance from the previous ping in meters so mam can
// see "moved 540m between 11:02 and 11:18".
router.get('/timeline', (req, res) => {
  const userId = parseInt(req.query.user_id, 10);
  const date = (req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : null;
  if (!userId || !date) return res.status(400).json({ error: 'user_id and date (YYYY-MM-DD) are required' });

  const db = getDb();
  const user = db.prepare('SELECT id, name, department, role FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(
    `SELECT id, time, latitude, longitude, address, site_name
       FROM location_tracking
      WHERE user_id = ? AND date = ?
      ORDER BY time`
  ).all(userId, date);

  // Also pull the attendance punch in / out for that day so the UI can
  // show "where they went between IN and OUT" — mam's exact ask.
  const att = db.prepare(
    `SELECT punch_in_time, punch_out_time, punch_in_address, punch_out_address,
            site_name as att_site, total_hours, status
       FROM attendance WHERE user_id = ? AND date = ?`
  ).get(userId, date) || {};

  let totalMeters = 0;
  const enriched = rows.map((r, i) => {
    let distFromPrev = 0;
    if (i > 0) {
      const prev = rows[i - 1];
      distFromPrev = Math.round(haversine(prev.latitude, prev.longitude, r.latitude, r.longitude));
      totalMeters += distFromPrev;
    }
    // Tag whether this ping is BEFORE punch-in / BETWEEN / AFTER punch-out so
    // the dashboard can colour-code or filter to "during work hours".
    let phase = 'during';
    const t = new Date(r.time).getTime();
    if (att.punch_in_time && t < new Date(att.punch_in_time).getTime()) phase = 'before';
    else if (att.punch_out_time && t > new Date(att.punch_out_time).getTime()) phase = 'after';
    return { ...r, dist_from_prev_m: distFromPrev, phase };
  });

  res.json({
    user,
    date,
    ping_count: rows.length,
    total_distance_m: Math.round(totalMeters),
    attendance: {
      punch_in_time: att.punch_in_time || null,
      punch_out_time: att.punch_out_time || null,
      punch_in_address: att.punch_in_address || null,
      punch_out_address: att.punch_out_address || null,
      site_name: att.att_site || null,
      total_hours: att.total_hours || null,
      status: att.status || null,
    },
    pings: enriched,
  });
});

// GET /api/admin/locations/users
//   helper for the timeline picker — list of every user that has any
//   location ping ever (so the dropdown only shows tracked users).
router.get('/users', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT DISTINCT u.id, u.name, u.department
       FROM location_tracking lt
       JOIN users u ON u.id = lt.user_id
      ORDER BY u.name`
  ).all();
  res.json(rows);
});

module.exports = router;
