// Store change metadata only. Passwords remain one-way hashes.
function ensurePasswordChangeMetadata(db) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS users_password_changed_at
    AFTER UPDATE OF password ON users
    WHEN NEW.password IS NOT OLD.password
    BEGIN
      UPDATE users SET password_changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id;
    END;`);
}
module.exports = { ensurePasswordChangeMetadata };
