const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensurePasswordChangeMetadata } = require('../passwordChangeMetadata');

test('only future password replacements record a timestamp; no password history is stored', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,password TEXT); INSERT INTO users VALUES(1,'User','old-hash')");
    ensurePasswordChangeMetadata(db);
    assert.equal(db.prepare('SELECT password_changed_at FROM users').get().password_changed_at, null);
    db.exec("UPDATE users SET name='Renamed',password='old-hash'");
    assert.equal(db.prepare('SELECT password_changed_at FROM users').get().password_changed_at, null);
    db.exec("UPDATE users SET password='new-hash'");
    const changed = db.prepare('SELECT * FROM users').get();
    assert.match(changed.password_changed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(changed.password, 'new-hash');
    ensurePasswordChangeMetadata(db);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(), changed);
    assert.deepEqual(db.prepare('PRAGMA table_info(users)').all().map(c=>c.name), ['id','name','password','password_changed_at']);
  } finally { db.close(); }
});
