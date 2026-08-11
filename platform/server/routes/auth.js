'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { getDb } = require('../lib/db');
const { findValidToken, assertPassword } = require('./users');

const router = express.Router();

const TOKEN_DAYS = Number(process.env.PLATFORM_JWT_DAYS || 7);
const ISSUER = 'sotyn-platform';

let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  const seed = process.env.PLATFORM_JWT_SECRET || 'platform-secret-change-in-production';
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = 'jwt_secret'").get();
    if (row && row.value) {
      _secret = row.value;
      return _secret;
    }
    db.prepare(
      "INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('jwt_secret', ?)"
    ).run(seed);
    _secret = seed;
    return _secret;
  } catch (_) {
    return seed;
  }
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      aud: 'platform',
    },
    getSecret(),
    { expiresIn: `${TOKEN_DAYS}d`, issuer: ISSUER }
  );
}

function readBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function verifyToken(token) {
  return jwt.verify(token, getSecret(), { issuer: ISSUER });
}

function requireAuth(req, res, next) {
  // Brand asset previews are loaded via <img src> (no Authorization header).
  if (req.method === 'GET' && /^\/api\/branding\/[^/]+\/assets\//.test(req.path)) {
    return next();
  }
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = verifyToken(token);
    if (decoded.aud !== 'platform') {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    const user = getDb().prepare(
      'SELECT id, username, role, active FROM platform_users WHERE id = ?'
    ).get(decoded.sub);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.platformUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = getDb().prepare(
    'SELECT id, username, password_hash, role, active FROM platform_users WHERE username = ?'
  ).get(String(username).trim());

  if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

router.get('/me', (req, res) => {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = verifyToken(token);
    const user = getDb().prepare(
      'SELECT id, username, role, active FROM platform_users WHERE id = ?'
    ).get(decoded.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

/** Public: validate invite/reset token */
router.get('/password-token/:token', (req, res) => {
  const row = findValidToken(req.params.token);
  if (!row || !row.active) {
    return res.status(404).json({ error: 'Link invalid or expired' });
  }
  if (row.purpose !== 'invite' && row.purpose !== 'reset') {
    return res.status(404).json({ error: 'Link invalid or expired' });
  }
  res.json({
    username: row.username,
    purpose: row.purpose,
    expiresAt: row.expires_at,
  });
});

/** Public: set password via invite or reset link */
router.post('/password-token/:token', (req, res) => {
  try {
    const row = findValidToken(req.params.token);
    if (!row || !row.active) {
      return res.status(404).json({ error: 'Link invalid or expired' });
    }
    if (row.purpose !== 'invite' && row.purpose !== 'reset') {
      return res.status(404).json({ error: 'Link invalid or expired' });
    }
    const password = assertPassword(req.body?.password);
    const hash = bcrypt.hashSync(password, 10);
    const db = getDb();
    db.prepare(`
      UPDATE platform_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(hash, row.user_id);
    db.prepare(`
      UPDATE platform_user_tokens SET used_at = datetime('now') WHERE id = ?
    `).run(row.id);
    db.prepare(`
      UPDATE platform_user_tokens SET used_at = datetime('now')
      WHERE user_id = ? AND used_at IS NULL
    `).run(row.user_id);

    const user = db.prepare(
      'SELECT id, username, role, active FROM platform_users WHERE id = ?'
    ).get(row.user_id);
    const token = signToken(user);
    res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
      purpose: row.purpose,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Logged-in: change own password (uses bearer; mounted under /api/auth before requireAuth) */
router.post('/change-password', (req, res) => {
  const bearer = readBearer(req);
  if (!bearer) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = verifyToken(bearer);
    const db = getDb();
    const user = db.prepare(
      'SELECT id, username, password_hash, role, active FROM platform_users WHERE id = ?'
    ).get(decoded.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Unauthorized' });

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const password = assertPassword(newPassword);
    db.prepare(`
      UPDATE platform_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(bcrypt.hashSync(password, 10), user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message || 'Invalid token' });
  }
});

module.exports = { router, requireAuth, getSecret };
