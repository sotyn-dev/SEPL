// Planning metadata only: source modules retain ownership of tasks and approvals.
function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_work_plans (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      source TEXT NOT NULL CHECK(source IN ('delegations','pms_tasks','checklists')),
      source_id INTEGER NOT NULL, occurrence TEXT NOT NULL DEFAULT '',
      work_date TEXT NOT NULL, start_minute INTEGER NOT NULL,
      duration INTEGER NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
      steps TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]',
      instructions TEXT NOT NULL DEFAULT '', documents TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'planned', blocker TEXT, elapsed_seconds INTEGER NOT NULL DEFAULT 0,
      started_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, source, source_id, occurrence)
    );
    CREATE INDEX IF NOT EXISTS daily_work_date ON daily_work_plans(user_id, work_date);
    CREATE UNIQUE INDEX IF NOT EXISTS daily_work_one_running ON daily_work_plans(user_id) WHERE state='running';
    CREATE TABLE IF NOT EXISTS daily_work_schedules (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), config TEXT NOT NULL,
      updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daily_work_events (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
      source TEXT, source_id INTEGER, occurrence TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT, after_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS daily_work_event_task ON daily_work_events(user_id, source, source_id, occurrence, id);
    CREATE TABLE IF NOT EXISTS daily_work_reviews (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), work_date TEXT NOT NULL,
      entries TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS daily_work_review_date ON daily_work_reviews(user_id, work_date);
  `);
}
module.exports = { initialize };
