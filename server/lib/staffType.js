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
}

module.exports = { STAFF_TYPES, normalizeStaffType, ensureStaffTypeColumn };
