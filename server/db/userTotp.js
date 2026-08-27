// TOTP lives off the users table. initializeDatabase() only calls initialize().
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_totp (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret       TEXT,
      required     INTEGER NOT NULL DEFAULT 0,
      enabled      INTEGER NOT NULL DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME
    )
  `);
  try { db.exec('ALTER TABLE user_totp ADD COLUMN required INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
}

function get(db, userId) {
  return db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) || null;
}

function needsTotp(row) {
  return !!(row && row.required);
}

function totp(user, secret) {
  return new OTPAuth.TOTP({
    issuer: 'SEPL ERP',
    label: user.email || user.username || String(user.id),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

function verifyCode(user, secret, code) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token) || !secret) return false;
  return totp(user, secret).validate({ token, window: 1 }) !== null;
}

async function beginSetup(db, user) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  db.prepare(`
    INSERT INTO user_totp (user_id, secret, required, enabled, created_at, confirmed_at)
    VALUES (?, ?, 1, 0, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      secret = excluded.secret, enabled = 0, confirmed_at = NULL, created_at = CURRENT_TIMESTAMP
  `).run(user.id, secret);
  const uri = totp(user, secret).toString();
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { secret, qr };
}

function confirm(db, userId) {
  db.prepare(`UPDATE user_totp SET enabled = 1, required = 1, confirmed_at = CURRENT_TIMESTAMP WHERE user_id = ?`).run(userId);
}

function optIn(db, userId) {
  db.prepare(`
    INSERT INTO user_totp (user_id, required, enabled, created_at)
    VALUES (?, 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET required = 1
  `).run(userId);
}

function optOut(db, userId) {
  db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
}

// Lost phone: stay opted in, they scan a new QR next login.
function reset(db, userId) {
  db.prepare(`
    UPDATE user_totp SET secret = NULL, enabled = 0, confirmed_at = NULL WHERE user_id = ?
  `).run(userId);
}

module.exports = { initialize, get, needsTotp, verifyCode, beginSetup, confirm, optIn, optOut, reset };
