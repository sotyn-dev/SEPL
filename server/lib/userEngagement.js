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

function dailyActiveUsersDetail(db, from, to, today = istToday()) {
  const users = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.department, e.designation
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id OR lower(e.email) = lower(u.email)
     WHERE COALESCE(u.active, 1) = 1 AND COALESCE(u.archived, 0) = 0
     ORDER BY u.name ASC`
  ).all();

  const last = to < today ? to : today;
  const days = last >= from ? (Math.round((Date.parse(last + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1) : 0;

  const userDaysMap = new Map();
  users.forEach(u => userDaysMap.set(u.id, new Set()));

  const hasViews = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_engagement_days'").get();
  if (hasViews && days > 0) {
    for (const r of db.prepare(`SELECT e.day, e.user_id FROM user_engagement_days e JOIN users u ON u.id=e.user_id
      WHERE e.day BETWEEN ? AND ? AND COALESCE(u.active,1)=1 AND COALESCE(u.archived,0)=0`).all(from, last)) {
      if (userDaysMap.has(r.user_id)) {
        userDaysMap.get(r.user_id).add(r.day);
      }
    }
  }

  if (days > 0) {
    const rows = db.prepare(`SELECT DISTINCT date(a.at,'+5 hours','+30 minutes') day, a.user_id, a.path, a.entity_type
      FROM audit_log a JOIN users u ON u.id=a.user_id
      WHERE a.at >= date(?,'-1 day') AND a.at < date(?,'+1 day')
        AND datetime(a.at) >= datetime(?,'-5 hours','-30 minutes')
        AND datetime(a.at) < datetime(?,'+1 day','-5 hours','-30 minutes')
        AND COALESCE(u.active,1)=1 AND COALESCE(u.archived,0)=0
        AND a.action IN ('CREATE','UPDATE','DELETE')
        AND a.status_code >= 200 AND a.status_code < 400`).all(from, last, from, last);
    for (const r of rows) {
      if (qualifiesPath(r.path) && !EXCLUDED.test('/' + (r.entity_type || ''))) {
        if (userDaysMap.has(r.user_id)) {
          userDaysMap.get(r.user_id).add(r.day);
        }
      }
    }
  }

  const active = [];
  const inactive = [];
  let totalUserDays = 0;

  for (const u of users) {
    const daysSet = userDaysMap.get(u.id) || new Set();
    const daysArr = Array.from(daysSet).sort();
    totalUserDays += daysArr.length;
    const item = {
      id: u.id,
      name: u.name,
      email: u.email,
      department: u.department || '—',
      role: u.role || '—',
      designation: u.designation || u.role || '—',
      active_days: daysArr,
      active_days_count: daysArr.length,
    };
    if (daysArr.length > 0) {
      active.push(item);
    } else {
      inactive.push(item);
    }
  }

  active.sort((a, b) => b.active_days_count - a.active_days_count || a.name.localeCompare(b.name));
  inactive.sort((a, b) => (a.department || '').localeCompare(b.department || '') || a.name.localeCompare(b.name));

  const averageDailyActive = days > 0 ? Math.round(totalUserDays / days) : 0;

  return {
    total_registered: users.length,
    average_daily_active: averageDailyActive,
    days_counted: days,
    from,
    to: last,
    active_users: active,
    inactive_users: inactive,
  };
}

module.exports = { qualifiesPath, ensureEngagementTable, recordView, dailyActiveUsers, dailyActiveUsersDetail };
