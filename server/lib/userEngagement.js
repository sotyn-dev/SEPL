const { istToday } = require('./istDate');

// Attendance, authentication and automatic background traffic are not ERP work.
const EXCLUDED = /(?:^|\/)(?:attendance|punch[^/]*|track-location|locations|auth|login|logout|push|notifications|announcements|health|version)(?:\/|$)/i;
function qualifiesPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
    && !EXCLUDED.test(path.split(/[?#]/)[0]);
}

function ensureEngagementTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_engagement_days (
    day TEXT NOT NULL, user_id INTEGER NOT NULL,
    PRIMARY KEY (day, user_id)
  )`);
}

function recordView(db, userId, path) {
  if (!qualifiesPath(path)) return false;
  ensureEngagementTable(db);
  db.prepare('INSERT OR IGNORE INTO user_engagement_days (day,user_id) VALUES (?,?)').run(istToday(), userId);
  return true;
}

function dailyActiveUsers(db, from, to, today = istToday()) {
  const given = db.prepare('SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0').get().c;
  const last = to < today ? to : today;
  if (last < from) return { given, done: 0 };
  // Include zero-activity days, but never penalize future days in a current week.
  const days = Math.round((Date.parse(last + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  const activeDays = new Set();
  const hasViews = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_engagement_days'").get();
  if (hasViews) {
    for (const r of db.prepare(`SELECT e.day,e.user_id FROM user_engagement_days e JOIN users u ON u.id=e.user_id
      WHERE e.day BETWEEN ? AND ? AND COALESCE(u.active,1)=1 AND COALESCE(u.archived,0)=0`).all(from,last)) {
      activeDays.add(`${r.day}:${r.user_id}`);
    }
  }
  // Historical audit records retain evidence of successful updates. Past page
  // views were never collected, so they cannot be reconstructed retrospectively.
  const rows = db.prepare(`SELECT DISTINCT date(a.at,'+5 hours','+30 minutes') day,a.user_id,a.path,a.entity_type
    FROM audit_log a JOIN users u ON u.id=a.user_id
    WHERE a.at >= date(?,'-1 day') AND a.at < date(?,'+1 day')
      AND datetime(a.at) >= datetime(?,'-5 hours','-30 minutes')
      AND datetime(a.at) < datetime(?,'+1 day','-5 hours','-30 minutes')
      AND COALESCE(u.active,1)=1 AND COALESCE(u.archived,0)=0
      AND a.action IN ('CREATE','UPDATE','DELETE')
      AND a.status_code >= 200 AND a.status_code < 400`).all(from,last,from,last);
  for (const r of rows) {
    if (qualifiesPath(r.path) && !EXCLUDED.test('/' + (r.entity_type || ''))) activeDays.add(`${r.day}:${r.user_id}`);
  }
  return { given, done: Math.round(activeDays.size / days) };
}

module.exports = { qualifiesPath, ensureEngagementTable, recordView, dailyActiveUsers };
