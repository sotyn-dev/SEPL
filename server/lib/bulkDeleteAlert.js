// Real-time guard against exactly what happened 2026-08-22/23: one account
// deleting hundreds of records in a single sitting, unnoticed until someone
// happened to look the next day. This fires the moment a user's delete count
// in a short rolling window crosses an escalating threshold — deliberately
// NOT a daily digest (like sposExceptionReport.js), because by the time a
// scheduled report runs, a rampage like that one is long since finished.
//
// Escalating thresholds so admins get ONE alert per stage of severity, not
// one notification per delete: 10 (first sign something's off), then 50,
// 100, 250, 500, 1000 — keeps re-alerting if it just keeps going, instead of
// firing once and going silent for the rest of the damage.
//
// Scope, deliberately: DELETE/FORCE_DELETE only, in a rolling window. Mass
// UPDATEs — e.g. bulk-deactivating employee accounts, also part of that
// incident — aren't covered here. That's a real, separate pattern worth its
// own alert; left out of v1 to avoid noise from ordinary bulk edits (CSV
// re-imports, status corrections) that legitimately touch many rows at once
// in ways a mass delete almost never does.
//
// Called from middleware/audit.js right after a DELETE/FORCE_DELETE is
// logged. Never throws into the caller — this is a safety net, not a
// blocking check, and it must never be able to break the request it's
// watching.

const { getDb } = require('../db/schema');

const WINDOW_MINUTES = 10;
const THRESHOLDS = [10, 50, 100, 250, 500, 1000];

function checkBulkDelete(userId, userName) {
  if (!userId) return;
  try {
    const db = getDb();
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const { c: count } = db.prepare(
      `SELECT COUNT(*) c FROM audit_log
        WHERE user_id = ? AND action IN ('DELETE','FORCE_DELETE') AND at >= ?`
    ).get(userId, since);

    // Highest threshold this count has just reached or passed.
    const tier = [...THRESHOLDS].reverse().find(t => count >= t);
    if (!tier) return;

    // One alert per (user, day, severity tier) — re-fires as it escalates,
    // never spams once already raised for that tier today. Synchronous
    // better-sqlite3 on a single Node event loop means this select-then-
    // insert can't race with itself across concurrent requests.
    const today = new Date().toISOString().slice(0, 10);
    const dedupe = `bulk_delete_alert:${userId}:${today}:${tier}`;
    const already = db.prepare('SELECT id FROM notifications WHERE dedupe_key = ? LIMIT 1').get(dedupe);
    if (already) return;

    const who = userName || `user #${userId}`;
    const title = `🚨 ${who} has deleted ${count} record(s) in the last ${WINDOW_MINUTES} minutes`;
    const body = `Account "${who}" has made ${count} delete request(s) in a ${WINDOW_MINUTES}-minute window — well above normal activity. Check Admin -> Audit Log to see what's been removed. If this isn't expected, deactivate the account and use Force Logout immediately — that now actually ends their session.`;
    const url = `/admin/audit?user_id=${userId}&action=DELETE`;

    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    if (!admins.length) return;

    try {
      const ins = db.prepare(
        `INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
         VALUES (?,?,?,?,?,?,?)`
      );
      for (const a of admins) ins.run(a.id, 'bulk_delete_alert', title, body.slice(0, 900), url, 'in_app', dedupe);
    } catch (e) { console.warn('[bulk-delete-alert] in-app notify failed:', e.message); }

    try {
      const { notifyMany } = require('./push');
      notifyMany(admins.map(a => a.id), { title, body: body.slice(0, 180), url, tag: `bulk-delete-${userId}` });
    } catch (e) { console.warn('[bulk-delete-alert] push failed:', e.message); }

    // Email is genuinely async (SMTP round-trip) — fire and forget, never
    // block or throw into the caller.
    setImmediate(async () => {
      try {
        const { sendEmail, getEmailConfig } = require('./email');
        const director = getEmailConfig().director;
        if (sendEmail && director) {
          await sendEmail({
            to: director,
            subject: `[SEPL ERP] ${title}`,
            text: `${body}\n\nOpen: /admin/audit?user_id=${userId}`,
            html: `<h3>${title}</h3><p>${body}</p>`,
          });
        }
      } catch (e) { console.warn('[bulk-delete-alert] email failed:', e.message); }
    });

    console.warn(`[bulk-delete-alert] ${who} (user_id=${userId}) crossed ${tier} deletes in ${WINDOW_MINUTES}min — admins notified`);
  } catch (e) {
    console.error('[bulk-delete-alert] check failed:', e.message);
  }
}

module.exports = { checkBulkDelete };
