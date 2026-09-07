// SOTYN LEADS — PUBLIC WEBHOOK.  NO AUTHENTICATION.
//
// Mam (2026-09-07). The sotyn.ai marketing site (static Astro on Vercel)
// carries two forms whose JS already reads:
//     const WEBHOOK = "";      // <- shipped empty
// With it empty every enquiry fell through to the WhatsApp fallback and was
// never recorded anywhere. This is the endpoint that constant should point at:
//     https://securederp.in/api/public/sotyn-lead
// Fill it in on the site and leads arrive in the ERP by themselves.
//
// Security model — this URL is open to the whole internet, so it is
// deliberately narrow:
//   • WRITE-ONLY. It inserts one row into sotyn_leads and returns {ok:true}.
//     It never reads back, never lists, never touches another table. A
//     website enquiry is NOT an EPC lead — nothing reaches sales_funnel
//     until a signed-in user presses Convert (routes/sotynLeads.js).
//   • Origin-checked: only the sotyn.ai origins get CORS headers
//     (SOTYN_SITE_ORIGINS overrides). A browser on any other site is
//     refused by its own CORS check.
//   • Honeypot: the site's hidden `website` / `website_hp` field must be
//     empty. Bots that fill it get a cheerful 200 and are dropped, so they
//     never learn they were caught.
//   • Rate-limited per IP (5 / 10 min, 20 / day) — the whole point of a
//     public POST is that someone will eventually hammer it.
//   • Every string is length-capped before it reaches SQLite, and the body
//     is capped in bytes; raw_json keeps what was actually sent for
//     forensics without trusting it.
//   • Same phone + same form inside 6 h updates that row instead of
//     inserting a duplicate (double-tap on a slow 4G connection).
// No secret token: the site is static, so any token in its JS would be
// public anyway. Origin + honeypot + rate limit is the honest defence, and
// the endpoint cannot read or damage anything.

const express = require('express');
const cors = require('cors');
const { getDb } = require('../db/schema');
const router = express.Router();

const ALLOWED_ORIGINS = (process.env.SOTYN_SITE_ORIGINS ||
  'https://sotyn.ai,https://www.sotyn.ai')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

const siteCors = cors({
  origin: (origin, cb) => {
    // No Origin header = curl / server-to-server / the site's own SSR — allowed
    // (CORS only protects browsers; the rate limit and honeypot still apply).
    if (!origin) return cb(null, true);
    cb(null, ALLOWED_ORIGINS.includes(String(origin).replace(/\/$/, '')));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  maxAge: 86400,
});

// ── per-IP rate limit ────────────────────────────────────────────────
// In-memory on purpose: one PM2 process, and a limiter that survives a
// restart is not worth a table.
//
// The IP MUST come from req.ip, never from the X-Forwarded-For header
// directly (pre-commit audit 2026-09-07). server/index.js sets
// `app.set('trust proxy', 1)`, so Express takes the last hop our own nginx
// added and ignores anything the caller pre-seeded into that header. Reading
// XFF[0] ourselves — which is what this first shipped with — hands the key to
// the attacker: one forged header per request and the limiter never fires.
const hits = new Map();               // ip -> number[] (epoch ms)
const SHORT_WINDOW = 10 * 60 * 1000, SHORT_MAX = 5;
const DAY_WINDOW = 24 * 3600 * 1000, DAY_MAX = 20;
const MAX_KEYS = 20000;               // hard ceiling; real IPs, so this is generous

// The only IP on this deployment an attacker cannot choose.
//
// Our nginx (deploy-vps.sh) sets ONLY `X-Real-IP $remote_addr` — it never sets
// X-Forwarded-For. So a caller's own X-Forwarded-For header reaches Node
// untouched, and because index.js sets `trust proxy: 1`, Express happily
// derives req.ip FROM that forged header. req.ip is therefore spoofable here,
// and so was the x-forwarded-for[0] this first shipped with: either one lets a
// bot mint a fresh rate-limit bucket per request.
//
// X-Real-IP is safe because nginx OVERWRITES whatever the caller sent with the
// real socket peer — but only for traffic that actually came through nginx.
// So it is trusted only when the connection itself came from local nginx;
// anywhere else (dev, direct hit) the socket address is already the truth.
function clientIp(req) {
  const sock = req.socket?.remoteAddress || '';
  const viaLocalNginx = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  if (viaLocalNginx) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return sock || req.ip || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  // Prune expired keys, then — only if still over the ceiling — evict the
  // least-recently-seen. Bounded work: the scan runs at most once per request
  // and only once the map is already large.
  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > DAY_WINDOW) hits.delete(k);
    if (hits.size > MAX_KEYS) {
      const oldest = [...hits.entries()]
        .sort((a, b) => (a[1][a[1].length - 1] || 0) - (b[1][b[1].length - 1] || 0))
        .slice(0, hits.size - MAX_KEYS);
      for (const [k] of oldest) hits.delete(k);
    }
  }
  const list = (hits.get(ip) || []).filter(t => now - t < DAY_WINDOW);
  const recent = list.filter(t => now - t < SHORT_WINDOW);
  if (recent.length >= SHORT_MAX || list.length >= DAY_MAX) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}

const clean = (v, max = 200) => {
  if (v === undefined || v === null) return null;
  // Strip control characters only (a pasted newline, or a bot smuggling a
  // line break into a field). Everything a human types — +91, hyphens,
  // brackets — is kept exactly as entered.
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
// Last 10 digits — the site collects Indian mobiles with and without +91.
const phoneKey = (p) => (String(p || '').replace(/\D/g, '').slice(-10) || null);

router.options('/sotyn-lead', siteCors);
router.post('/sotyn-lead', siteCors, express.json({ limit: '32kb' }), (req, res) => {
  // The rate limit runs FIRST — before the honeypot, before any parsing of
  // attacker-controlled values. Anything that can throw must sit behind the
  // limiter, or a malformed body becomes an un-throttled 500 generator.
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many submissions' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};

  // Honeypot — the site sends `website` (demo form) / `website_hp` (magnet
  // form) as a hidden field no human ever sees filled.
  if (clean(b.website) || clean(b.website_hp)) return res.json({ ok: true });

  const name = clean(b.name, 120);
  const phone = clean(b.phone, 40);
  // The site validates name+phone before it ever calls us; anything without
  // both is a bot or a broken embed, not a lead.
  if (!name || !phoneKey(phone)) return res.status(400).json({ ok: false, error: 'Name and phone are required' });

  // magnet form sends `magnet`; demo form sends company/city/trade/team.
  const formType = clean(b.magnet) ? 'magnet' : 'demo';
  const row = {
    name,
    company: clean(b.company, 160),
    phone,
    email: clean(b.email, 160),
    city: clean(b.city, 120),
    trade: clean(b.trade, 120),
    team: clean(b.team, 120),
    form_type: formType,
    magnet: clean(b.magnet, 120),
    source: clean(b.source, 120) || 'sotyn.ai',
    page: clean(b.page, 200),
    referrer: clean(b.referrer || req.headers.referer, 300),
    utm_source: clean(b.utm_source, 120),
    utm_medium: clean(b.utm_medium, 120),
    utm_campaign: clean(b.utm_campaign, 160),
    utm_term: clean(b.utm_term, 160),
    utm_content: clean(b.utm_content, 160),
    submitted_at: clean(b.submittedAt || b.submitted_at, 40),
    ip,
    user_agent: clean(req.headers['user-agent'], 300),
    raw_json: JSON.stringify(b).slice(0, 4000),
  };

  try {
    const db = getDb();
    // Double-tap guard: same phone, same form, last 6 hours -> bump the count
    // and backfill anything the second submission added. Not a merge across
    // forms: the demo form and the checklist form are different intents.
    //
    // Matched on the stored phone_key (exact equality on an indexed column),
    // NOT a trailing-wildcard LIKE over every row. The LIKE this shipped with
    // was both unindexable and WRONG: an 8-digit entry made the pattern short
    // enough to match a different, longer number that merely ended the same way,
    // so one visitor's enquiry landed on a stranger's row (audit 2026-09-07).
    // A key shorter than 10 digits is never deduped — it cannot identify anyone.
    const key = phoneKey(phone);
    const dupe = key && key.length === 10 ? db.prepare(`
      SELECT id, submissions FROM sotyn_leads
       WHERE phone_key = ?
         AND form_type = ?
         AND status IN ('new','contacted','qualified')
         AND created_at > datetime('now','-6 hours')
       ORDER BY id DESC LIMIT 1
    `).get(key, formType) : null;

    if (dupe) {
      // The name column is deliberately NOT updated. It is the one field a
      // repeat submission could use to rewrite an existing enquiry — an
      // anonymous caller who guesses a phone number must never be able to
      // rename someone else's lead. Blank fields are still backfilled;
      // nothing already captured is overwritten.
      db.prepare(`
        UPDATE sotyn_leads
           SET submissions = submissions + 1,
               company    = COALESCE(company, ?),
               email      = COALESCE(email, ?),
               city       = COALESCE(city, ?),
               trade      = COALESCE(trade, ?),
               team       = COALESCE(team, ?),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(row.company, row.email, row.city, row.trade, row.team, dupe.id);
      return res.json({ ok: true, id: dupe.id, duplicate: true });
    }

    const r = db.prepare(`
      INSERT INTO sotyn_leads
        (name, company, phone, phone_key, email, city, trade, team,
         form_type, magnet, source, page, referrer,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         submitted_at, ip, user_agent, raw_json, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new')
    `).run(
      row.name, row.company, row.phone, key, row.email, row.city, row.trade, row.team,
      row.form_type, row.magnet, row.source, row.page, row.referrer,
      row.utm_source, row.utm_medium, row.utm_campaign, row.utm_term, row.utm_content,
      row.submitted_at, row.ip, row.user_agent, row.raw_json
    );
    // Name + company only. The phone and email stay out of the pm2 log —
    // visitor PII does not belong in a file we tail for other reasons.
    console.log(`[sotyn-lead] captured #${r.lastInsertRowid} - ${row.name} (${row.company || 'no company'}) via ${formType}`);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    // Never let the visitor see a stack trace, and never let a DB hiccup
    // lose the lead silently — it goes to the log for recovery.
    console.error('[sotyn-lead] FAILED to store lead:', e.message, row.raw_json);
    res.status(500).json({ ok: false, error: 'Could not store lead' });
  }
});

module.exports = router;
