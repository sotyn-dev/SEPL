// Credential Vault — AES-256-GCM encryption for portal credentials
// Stored encrypted at rest so portal logins, vendor IDs, and temporary passwords
// are protected and only readable by authorized roles (Admin and assigned owner).

const crypto = require('crypto');
const { getDb } = require('../db/schema');

let _vaultKey = null;

function getVaultKey() {
  if (_vaultKey) return _vaultKey;
  try {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
    let row = db.prepare("SELECT value FROM app_settings WHERE key='vendor_vault_key'").get();
    if (row && row.value) {
      _vaultKey = Buffer.from(row.value, 'hex');
      return _vaultKey;
    }
    // Generate new 32-byte key once and persist it in app_settings
    const newKey = crypto.randomBytes(32);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vendor_vault_key', ?)").run(newKey.toString('hex'));
    _vaultKey = newKey;
    return _vaultKey;
  } catch (err) {
    // Fallback deterministic key if DB not ready
    return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'sepl-vendor-vault-secure-key').digest();
  }
}

/**
 * Encrypt a plain-text password using AES-256-GCM.
 * Returns formatted string: "iv_hex:tag_hex:cipher_hex"
 */
function encryptPassword(plainText) {
  if (!plainText || typeof plainText !== 'string') return null;
  const key = getVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt a stored password string.
 */
function decryptPassword(payload) {
  if (!payload || typeof payload !== 'string' || !payload.includes(':')) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  
  const [ivHex, tagHex, cipherHex] = parts;
  try {
    const key = getVaultKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.warn('[vault] decryption error:', err.message);
    return null;
  }
}

module.exports = {
  encryptPassword,
  decryptPassword,
};

