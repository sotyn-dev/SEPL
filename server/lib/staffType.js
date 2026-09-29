const STAFF_TYPES = { blue_collar: 'Blue Collar', white_collar: 'White Collar' };

function normalizeStaffType(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Object.hasOwn(STAFF_TYPES, value)) {
    throw new Error('Staff Type must be Blue Collar or White Collar');
  }
  return value;
}

function ensureStaffTypeColumn(db) {
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'staff_type')) {
    db.exec("ALTER TABLE users ADD COLUMN staff_type TEXT CHECK(staff_type IN ('blue_collar','white_collar') OR staff_type IS NULL)");
  }
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS user_metadata_migrations (name TEXT PRIMARY KEY)');
    const migration = 'existing-unspecified-staff-white-collar-2026-09';
    if (!db.prepare('SELECT 1 FROM user_metadata_migrations WHERE name=?').get(migration)) {
      db.exec("UPDATE users SET staff_type='white_collar' WHERE staff_type IS NULL OR TRIM(staff_type)=''");
      db.prepare('INSERT INTO user_metadata_migrations(name) VALUES (?)').run(migration);
    }
  })();
}

module.exports = { STAFF_TYPES, normalizeStaffType, ensureStaffTypeColumn };
