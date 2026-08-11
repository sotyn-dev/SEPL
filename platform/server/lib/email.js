'use strict';

// SMTP helper — same shape as ERP server/lib/email.js.
// Platform prefers env (VPS .env); optional platform_settings override.
// If SMTP is not configured, sendEmail() returns { skipped: true }.

const { getDb } = require('./db');

function getSetting(key) {
  try {
    const row = getDb().prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function envOrSetting(envKey, settingKey) {
  const fromEnv = process.env[envKey];
  if (fromEnv != null && String(fromEnv).trim() !== '') return String(fromEnv).trim();
  return getSetting(settingKey);
}

function getEmailConfig() {
  return {
    host: envOrSetting('PLATFORM_SMTP_HOST', 'email_smtp_host'),
    port: +(envOrSetting('PLATFORM_SMTP_PORT', 'email_smtp_port') || 587),
    secure: (envOrSetting('PLATFORM_SMTP_SECURE', 'email_smtp_secure') || '') === '1',
    user: envOrSetting('PLATFORM_SMTP_USER', 'email_smtp_user'),
    pass: envOrSetting('PLATFORM_SMTP_PASS', 'email_smtp_pass'),
    from:
      envOrSetting('PLATFORM_EMAIL_FROM', 'email_from')
      || envOrSetting('PLATFORM_SMTP_USER', 'email_smtp_user'),
  };
}

function isConfigured() {
  const c = getEmailConfig();
  return !!(c.host && c.user && c.pass);
}

async function sendEmail({ to, subject, html, text, from }) {
  const c = getEmailConfig();
  if (!c.host || !c.user || !c.pass) {
    return { skipped: true, reason: 'SMTP not configured' };
  }
  if (!to) {
    return { skipped: true, reason: 'No recipient' };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    return { skipped: true, reason: 'nodemailer not installed' };
  }

  const transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });

  const info = await transporter.sendMail({
    from: from || c.from,
    to,
    subject,
    html,
    text,
  });
  return { sent: true, messageId: info?.messageId };
}

function inviteEmailHtml({ username, url, expiresAt }) {
  return `
    <p>You have been invited to the <strong>Sotyn Platform</strong> control plane.</p>
    <p>Username: <strong>${escapeHtml(username)}</strong></p>
    <p><a href="${escapeAttr(url)}">Accept invite &amp; set password</a></p>
    <p style="color:#666;font-size:12px">Or paste: ${escapeHtml(url)}</p>
    <p style="color:#666;font-size:12px">Link expires: ${escapeHtml(expiresAt || '')}</p>
  `;
}

function resetEmailHtml({ username, url, expiresAt, selfServe }) {
  const lead = selfServe
    ? 'A password reset was requested for your Sotyn Platform account.'
    : 'An administrator issued a password reset for your Sotyn Platform account. Your previous password no longer works.';
  return `
    <p>${lead}</p>
    <p>Username: <strong>${escapeHtml(username)}</strong></p>
    <p><a href="${escapeAttr(url)}">Set a new password</a></p>
    <p style="color:#666;font-size:12px">Or paste: ${escapeHtml(url)}</p>
    <p style="color:#666;font-size:12px">Link expires: ${escapeHtml(expiresAt || '')}</p>
    ${selfServe ? '<p style="color:#666;font-size:12px">If you did not request this, you can ignore this email — your current password still works until you use the link.</p>' : ''}
  `;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

module.exports = {
  sendEmail,
  isConfigured,
  getEmailConfig,
  inviteEmailHtml,
  resetEmailHtml,
};
