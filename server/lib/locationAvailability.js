const ERROR_GRACE_MS = 5 * 60 * 1000;
const SILENCE_GRACE_MS = 30 * 60 * 1000;
const RECOVERY_MS = 60 * 1000;
const RECOVERY_MAX_GAP_MS = 90 * 1000;

const REASONS = {
  'permission-denied': 'Browser location permission is denied.',
  'position-unavailable': 'The browser could not determine a location.',
  timeout: 'The browser location request timed out.',
  'no-geolocation-api': 'This browser does not support location sharing.',
  'no-recent-location': 'No recent location reading or browser heartbeat was received.',
};

function locationReason(reason) {
  return REASONS[reason] || 'The browser could not provide a location reading.';
}

function validCoordinates(latitude, longitude) {
  return typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
}

// Server-stamped history includes ALL sessions: an unavailable laptop must not
// override a phone still sending locations. History survives server restarts.
function getLocationInterruption(db, userId, attendance, today, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const dayStart = Date.parse(`${today}T00:00:00+05:30`);
  const punchMs = Date.parse(attendance.punch_in_time);
  const startMs = Math.max(dayStart, Number.isFinite(punchMs) ? punchMs : dayStart);
  const startIso = new Date(startMs).toISOString();
  const latest = db.prepare(`
    SELECT time, latitude, longitude, site_name, address FROM location_tracking
    WHERE user_id = ? AND date = ? AND time >= ? AND time <= ?
    ORDER BY time DESC, id DESC LIMIT 1
  `).get(userId, today, startIso, nowIso);
  const success = db.prepare(`
    SELECT time FROM location_tracking
    WHERE user_id = ? AND date = ? AND time >= ? AND time <= ?
      AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
      AND COALESCE(site_name, '') <> 'GPS_OFF'
    ORDER BY time DESC, id DESC LIMIT 1
  `).get(userId, today, startIso, nowIso);
  const successMs = success ? Date.parse(success.time) : null;
  if (successMs !== null && nowMs - successMs < ERROR_GRACE_MS) return null;

  const latestMs = latest ? Date.parse(latest.time) : startMs;
  if (nowMs - latestMs >= SILENCE_GRACE_MS) {
    return { since: new Date(latestMs).toISOString(), reason: 'no-recent-location', lastPing: latest };
  }

  const firstFailure = db.prepare(`
    SELECT time FROM location_tracking
    WHERE user_id = ? AND date = ? AND time >= ? AND time <= ?
      AND (? IS NULL OR time > ?)
      AND (site_name = 'GPS_OFF' OR latitude IS NULL OR longitude IS NULL)
    ORDER BY time ASC, id ASC LIMIT 1
  `).get(userId, today, startIso, nowIso, success?.time || null, success?.time || null);
  if (!firstFailure || nowMs - Date.parse(firstFailure.time) < ERROR_GRACE_MS) return null;
  return { since: firstFailure.time, reason: latest?.address || 'unknown-error', lastPing: latest };
}

module.exports = {
  ERROR_GRACE_MS, SILENCE_GRACE_MS, RECOVERY_MS, RECOVERY_MAX_GAP_MS,
  locationReason, validCoordinates, getLocationInterruption,
};
