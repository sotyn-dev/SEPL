// Field-level encryption for Aadhaar (Mandatory Field Spec Statutory #18 —
// "last 4 only stored… masked storage"). AES-256-GCM, Node's built-in
// `crypto` — no new dependency. The plaintext Aadhaar never touches disk;
// only the ciphertext (aadhar_number) and the plain last-4 (aadhar_last4,
// used for ordinary masked display without decrypting) are stored.
//
// Key comes from AADHAR_ENCRYPTION_KEY (.env) — a 32-byte key, base64 or hex
// encoded. Loaded lazily (not at require-time) so a missing key only breaks
// the Aadhaar feature, not server boot as a whole.

const crypto = require('crypto');

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.AADHAR_ENCRYPTION_KEY;
  if (!raw) throw new Error('AADHAR_ENCRYPTION_KEY is not set — see .env.example');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('AADHAR_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
  cachedKey = buf;
  return cachedKey;
}

const last4 = (plain) => String(plain || '').replace(/\D/g, '').slice(-4);
const maskAadhaar = (plain) => (plain ? `XXXXXXXX${last4(plain)}` : null);

// Stored form: base64(iv).base64(authTag).base64(ciphertext) — self-describing,
// no separate IV column needed.
function encryptAadhaar(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptAadhaar(stored) {
  if (!stored) return null;
  const parts = String(stored).split('.');
  if (parts.length !== 3) return null; // not our ciphertext shape — refuse rather than mis-decrypt
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    console.error('[cryptoFields] Aadhaar decrypt failed:', e.message);
    return null;
  }
}

module.exports = { encryptAadhaar, decryptAadhaar, maskAadhaar, last4 };
