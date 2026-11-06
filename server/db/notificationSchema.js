// Schema initialization for the Central ERP Notification Engine.
// Extends the existing notifications table with reference and priority fields,
// ensures notification_preferences exists, and sets up high-performance indices.

function initializeNotificationSchema(db) {
  try {
    // Add columns to existing notifications table safely
    try { db.exec(`ALTER TABLE notifications ADD COLUMN reference_id INTEGER`); } catch (_) {}
    try { db.exec(`ALTER TABLE notifications ADD COLUMN reference_type TEXT`); } catch (_) {}
    try { db.exec(`ALTER TABLE notifications ADD COLUMN priority TEXT DEFAULT 'normal'`); } catch (_) {}
    try { db.exec(`ALTER TABLE notifications ADD COLUMN is_read INTEGER DEFAULT 0`); } catch (_) {}
    try { db.exec(`ALTER TABLE notifications ADD COLUMN module TEXT`); } catch (_) {}

    // Notification preferences per user & category
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        in_app INTEGER DEFAULT 1,
        push INTEGER DEFAULT 1,
        email INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, category)
      )
    `);

    // High performance indices
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications(user_id, is_read, id DESC)`); } catch (_) {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_notif_ref ON notifications(reference_type, reference_id)`); } catch (_) {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_notif_pref_user ON notification_preferences(user_id)`); } catch (_) {}

    // Backfill is_read from read_at if needed
    try {
      db.exec(`UPDATE notifications SET is_read = 1 WHERE read_at IS NOT NULL AND (is_read IS NULL OR is_read = 0)`);
      db.exec(`UPDATE notifications SET is_read = 0 WHERE read_at IS NULL AND is_read IS NULL`);
    } catch (_) {}

  } catch (err) {
    console.error('[notificationSchema] init error:', err.message);
  }
}

module.exports = { initializeNotificationSchema };

