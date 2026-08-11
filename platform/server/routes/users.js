'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { getDb } = require('../lib/db');
const {
  sendEmail,
  isConfigured,
  inviteEmailHtml,
  resetEmailHtml,
} = require('../lib/email');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,48}$/;
const ROLES = new Set(['platform_admin']);
const INVITE_DAYS = Number(process.env.PLATFORM_INVITE_DAYS || 7);
const RESET_HOURS = Number(process.env.PLATFORM_RESET_HOURS || 24);
const PUBLIC_BASE = (process.env.PLATFORM_PUBLIC_URL || 'http://127.0.0.1:7101').replace(/\/$/, '');

function requireAdmin(req, res, next) {
  if (!req.platformUser || req.platformUser.role !== 'platform_admin') {
    return res.status(403).json({ error: 'platform_admin required' });
  }
  next();
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function assertUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) {
    const err = new Error('Username: 3–48 chars, letters, digits, . _ -');
    err.status = 400;
    throw err;
  }
  return u;
}

function assertPassword(password) {
  const p = String(password || '');
  if (p.length < 10) {
    const err = new Error('Password must be at least 10 characters');
    err.status = 400;
    throw err;
  }
  return p;
}

function assertRole(role) {
  const r = role || 'platform_admin';
  if (!ROLES.has(r)) {
    const err = new Error(`Invalid role (allowed: ${[...ROLES].join(', ')})`);
    err.status = 400;
    throw err;
  }
  return r;
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    role: row.role,
    active: !!row.active,
    pendingInvite: !!row.pending_invite,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createUserToken(db, { userId, purpose, createdBy, expiresAt }) {
  const raw = newToken();
  const id = `tok_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    UPDATE platform_user_tokens SET used_at = datetime('now')
    WHERE user_id = ? AND purpose = ? AND used_at IS NULL
  `).run(userId, purpose);
  db.prepare(`
    INSERT INTO platform_user_tokens (id, user_id, purpose, token_hash, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, purpose, hashToken(raw), expiresAt, createdBy || null);
  return raw;
}

function findValidToken(raw) {
  const row = getDb().prepare(`
    SELECT t.*, u.username, u.role, u.active
    FROM platform_user_tokens t
    JOIN platform_users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hashToken(raw));
  if (!row || row.used_at) return null;
  if (Number.isNaN(Date.parse(row.expires_at)) || Date.parse(row.expires_at) < Date.now()) {
    return null;
  }
  return row;
}

function findUserByLogin(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  return getDb().prepare(`
    SELECT * FROM platform_users
    WHERE LOWER(username) = LOWER(?) OR (email IS NOT NULL AND LOWER(email) = LOWER(?))
  `).get(id, id);
}

async function trySendInviteEmail({ to, username, url, expiresAt }) {
  if (!to) return { skipped: true, reason: 'No email on user' };
  if (!isConfigured()) return { skipped: true, reason: 'SMTP not configured' };
  try {
    return await sendEmail({
      to,
      subject: 'Sotyn Platform invite',
      html: inviteEmailHtml({ username, url, expiresAt }),
      text: `You are invited to Sotyn Platform.\nUsername: ${username}\nAccept: ${url}\nExpires: ${expiresAt}`,
    });
  } catch (e) {
    console.error('[platform-email] invite send failed:', e.message);
    return { skipped: true, reason: e.message };
  }
}

async function trySendResetEmail({ to, username, url, expiresAt, selfServe }) {
  if (!to) return { skipped: true, reason: 'No email on user' };
  if (!isConfigured()) return { skipped: true, reason: 'SMTP not configured' };
  try {
    return await sendEmail({
      to,
      subject: 'Sotyn Platform password reset',
      html: resetEmailHtml({ username, url, expiresAt, selfServe }),
      text: `Password reset for ${username}.\nSet password: ${url}\nExpires: ${expiresAt}`,
    });
  } catch (e) {
    console.error('[platform-email] reset send failed:', e.message);
    return { skipped: true, reason: e.message };
  }
}

router.get('/', requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT u.*,
                      EXISTS(
                        SELECT 1 FROM platform_user_tokens t
                        WHERE t.user_id = u.id AND t.purpose = 'invite' AND t.used_at IS NULL
                      ) AS pending_invite
    FROM platform_users u
    ORDER BY u.created_at ASC
  `).all();
  res.json({ users: rows.map(mapUser), smtpConfigured: isConfigured() });
});

router.post('/invite', requireAdmin, async (req, res) => {
  try {
    const username = assertUsername(req.body?.username);
    const role = assertRole(req.body?.role);
    const email = req.body?.email ? String(req.body.email).trim().slice(0, 120) : null;

    const db = getDb();
    if (db.prepare('SELECT id FROM platform_users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const id = `user_${crypto.randomBytes(8).toString('hex')}`;
    const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    db.prepare(`
      INSERT INTO platform_users (id, username, password_hash, role, active, email)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(id, username, unusable, role, email);

    const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const raw = createUserToken(db, {
      userId: id,
      purpose: 'invite',
      createdBy: req.platformUser.id,
      expiresAt,
    });

    const invitePath = `/invite/${raw}`;
    const inviteUrl = `${PUBLIC_BASE}${invitePath}`;
    const emailResult = await trySendInviteEmail({
      to: email,
      username,
      url: inviteUrl,
      expiresAt,
    });

    res.status(201).json({
      user: mapUser({
        id,
        username,
        email,
        role,
        active: 1,
        pending_invite: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      inviteToken: raw,
      inviteUrl,
      invitePath,
      expiresAt,
      emailSent: !!emailResult.sent,
      emailSkipped: emailResult.skipped ? emailResult.reason : null,
      note: emailResult.sent
        ? `Invite emailed to ${email}. Link also shown once below.`
        : 'Copy the invite link to the new operator. Token shown once.'
          + (email && !emailResult.sent ? ` (Email not sent: ${emailResult.reason})` : ''),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.active) return res.status(400).json({ error: 'User is deactivated' });

    const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    db.prepare(`
      UPDATE platform_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(unusable, user.id);

    const expiresAt = new Date(Date.now() + RESET_HOURS * 60 * 60 * 1000).toISOString();
    const raw = createUserToken(db, {
      userId: user.id,
      purpose: 'reset',
      createdBy: req.platformUser.id,
      expiresAt,
    });

    const resetPath = `/reset/${raw}`;
    const resetUrl = `${PUBLIC_BASE}${resetPath}`;
    const emailResult = await trySendResetEmail({
      to: user.email,
      username: user.username,
      url: resetUrl,
      expiresAt,
      selfServe: false,
    });

    res.json({
      userId: user.id,
      username: user.username,
      resetToken: raw,
      resetUrl,
      resetPath,
      expiresAt,
      emailSent: !!emailResult.sent,
      emailSkipped: emailResult.skipped ? emailResult.reason : null,
      note: emailResult.sent
        ? `Old password invalidated. Reset link emailed to ${user.email}.`
        : 'Old password invalidated. Copy the reset link to the operator. Token shown once.'
          + (user.email && !emailResult.sent ? ` (Email not sent: ${emailResult.reason})` : ''),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Admin sets password directly (no link). Burns open invite/reset tokens. */
router.post('/:id/set-password', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.active) return res.status(400).json({ error: 'User is deactivated' });

    const password = assertPassword(req.body?.password);
    db.prepare(`
      UPDATE platform_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(bcrypt.hashSync(password, 10), user.id);
    db.prepare(`
      UPDATE platform_user_tokens SET used_at = datetime('now')
      WHERE user_id = ? AND used_at IS NULL
    `).run(user.id);

    res.json({
      ok: true,
      userId: user.id,
      username: user.username,
      note: 'Password set by admin. Tell the operator the new password out of band.',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/deactivate', requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.platformUser.id) {
    return res.status(400).json({ error: 'Cannot deactivate yourself' });
  }
  const activeAdmins = db.prepare(`
    SELECT COUNT(*) AS n FROM platform_users WHERE role = 'platform_admin' AND active = 1
  `).get().n;
  if (user.role === 'platform_admin' && user.active && activeAdmins <= 1) {
    return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
  }
  db.prepare(`UPDATE platform_users SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(user.id);
  db.prepare(`
    UPDATE platform_user_tokens SET used_at = datetime('now')
    WHERE user_id = ? AND used_at IS NULL
  `).run(user.id);
  res.json({ ok: true, userId: user.id, active: false });
});

router.post('/:id/activate', requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM platform_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare(`UPDATE platform_users SET active = 1, updated_at = datetime('now') WHERE id = ?`).run(user.id);
  res.json({ ok: true, userId: user.id, active: true });
});

module.exports = {
  router,
  requireAdmin,
  findValidToken,
  findUserByLogin,
  createUserToken,
  hashToken,
  assertPassword,
  assertUsername,
  trySendResetEmail,
  PUBLIC_BASE,
  RESET_HOURS,
};
