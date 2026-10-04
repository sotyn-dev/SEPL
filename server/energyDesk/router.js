// ENERGY DESK — public routes behind securedengineers.com/solar-savings-report/.
// Mounted at /api/public/energy-desk, BEFORE the global 10 MB JSON parser, so
// the 32 kb caps below are real (the same reason routes/publicSotynLead.js is
// mounted there).
//
//   GET  /health     → { enabled, ai_available, engine_version, config_version }
//   POST /reports    → recompute a report the page already showed, and store it
//   POST /fallback   → the page's no-JavaScript form: record the lead, compute
//                      the report here, and send the visitor to /thank-you/
//
// The page computes its estimate in the browser with the same engine, so it
// works whether or not this module is live; this module adds storage, a
// server-side recompute, and the only form on the site that works without JS.
//
// Security model, the same shape as the website-lead webhook:
//   • Origin-checked. CORS headers only for the website's own origins, and the
//     write routes refuse any other Origin. A static site cannot hold a secret,
//     so there is none to leak.
//   • Per-IP limits on the key from lib/clientIp.js (not req.ip, which a caller
//     can steer through X-Forwarded-For on this deployment).
//   • Inputs are rebuilt field by field from a fixed list, numbers parsed,
//     strings length-capped; nothing from the request is stored unparsed.
//   • Off unless ENERGY_DESK_ENABLED=1: /health then says enabled:false and the
//     page never calls the rest.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { getDb } = require('../db/schema');
const { rateLimit } = require('../lib/rateLimit');
const { clientIp } = require('../lib/clientIp');
const { isAllowedWebsiteOrigin, websiteRefOf } = require('../lib/websiteLead');
const config = require('./config');
const { storeManualReport } = require('./store');

const engine = config.engine;
const SITE = 'https://www.securedengineers.com';
const router = express.Router();

const enabled = () => /^(1|true|yes)$/i.test(String(process.env.ENERGY_DESK_ENABLED || ''));

router.use(cors({
  origin: (origin, cb) => cb(null, isAllowedWebsiteOrigin(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  maxAge: 86400,
}));
router.use(express.json({ limit: '32kb' }));
router.use(express.urlencoded({ extended: false, limit: '32kb' }));

const ipKey = (req) => 'ip:' + clientIp(req);
const reportBurst = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyFn: ipKey });
const reportDay = rateLimit({ windowMs: 24 * 3600 * 1000, max: 60, keyFn: ipKey });
// The no-JS form creates a lead, so it gets the website-lead webhook's limits.
const formBurst = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyFn: ipKey });
const formDay = rateLimit({ windowMs: 24 * 3600 * 1000, max: 40, keyFn: ipKey });

// ── Inputs: a fixed list, parsed, capped ──────────────────────────────────
const CATEGORIES = new Set(['industrial', 'commercial', 'domestic', 'other']);
const str = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const s = String(v).toLowerCase();
  const mult = /lakh|lac/.test(s) ? 1e5 : /crore|\bcr\b/.test(s) ? 1e7 : 1;
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n * mult : NaN;
}

function cleanInputs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const state = str(r.state, 40);
  const regionId = str(r.regionId, 20) || engine.regionForState(state) || '';
  return {
    state,
    regionId,
    discom: str(r.discom, 40),
    category: CATEGORIES.has(r.category) ? r.category : 'other',
    monthlyKwh: num(r.monthlyKwh) ?? 0,
    monthlyBillInr: num(r.monthlyBillInr) ?? 0,
    fixedDemandInr: num(r.fixedDemandInr),
    sanctionedLoad: num(r.sanctionedLoad),
    sanctionedLoadUnit: r.sanctionedLoadUnit === 'kW' ? 'kW' : 'kVA',
    roofSqft: num(r.roofSqft),
    daytimeSharePct: num(r.daytimeSharePct),
    runsDg: r.runsDg === true || r.runsDg === 'on' || r.runsDg === 'yes',
  };
}

// ── GET /health ───────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const cfg = config.getConfig();
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: enabled() && Boolean(cfg),
    ai_available: false,
    engine_version: engine.ENGINE_VERSION,
    config_version: cfg ? cfg.version : null,
    price_version: cfg && cfg.price ? cfg.price.version : null,
  });
});

// ── POST /reports ─────────────────────────────────────────────────────────
router.post('/reports', reportBurst, reportDay, (req, res) => {
  if (!enabled()) return res.status(503).json({ error: 'The Energy Desk is not switched on.' });
  if (!isAllowedWebsiteOrigin(req.headers.origin)) return res.status(403).json({ error: 'Post from the website.' });
  const cfg = config.getConfig();
  if (!cfg) return res.status(503).json({ error: 'Config not loaded yet.' });

  const b = req.body || {};
  const leadRef = websiteRefOf({ lead_ref: b.lead_ref });
  if (!leadRef) return res.status(400).json({ error: 'lead_ref must be the website reference (SEPL-YYYYMMDD-XXXXXXXX).' });

  const inputs = cleanInputs(b.inputs);
  const report = engine.buildReport(inputs, cfg.resolved, cfg.price);
  if (!report.ok) return res.status(422).json({ error: 'The numbers do not make a report.', errors: report.errors });

  try {
    const saved = storeManualReport(getDb(), {
      leadRef, inputs, report,
      engineVersion: engine.ENGINE_VERSION,
      configVersion: cfg.version,
      ip: clientIp(req),
    });
    return res.status(saved.duplicate ? 200 : 201).json({
      ok: true,
      report_id: saved.publicId,
      duplicate: saved.duplicate,
      kwp: report.kwp,
      limited_by: report.limitedBy,
      // The page compares these with what it showed; a mismatch means the
      // browser and the ERP ran different engine or config versions.
      engine_version: engine.ENGINE_VERSION,
      config_version: cfg.version,
    });
  } catch (err) {
    console.error('[energy-desk] report not stored:', err.message);
    return res.status(500).json({ error: 'The report could not be stored.' });
  }
});

// ── POST /fallback — the page's form for visitors without JavaScript ──────
const thanks = (ref) => `${SITE}/thank-you/${ref ? '?ref=' + encodeURIComponent(ref) : ''}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>`;

function newLeadRef() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `SEPL-${ymd}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function copyToSheet(body) {
  const url = process.env.ENERGY_DESK_SHEETS_URL;
  if (!url) return;
  try {
    // text/plain, as the website sends it: Apps Script cannot answer a preflight.
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  } catch (e) {
    console.warn('[energy-desk] Sheet copy failed (the ERP has the lead):', e.message);
  }
}

router.post('/fallback', formBurst, formDay, async (req, res) => {
  const back = `<p><a href="${SITE}/solar-savings-report/">Back to the form</a></p>`;
  if (!enabled()) {
    return res.status(503).type('html').send(page('This form is not available just now', `<p>Please contact us through <a href="${SITE}/contact/">our contact page</a>.</p>`));
  }
  // A classic form post carries an Origin header in every current browser.
  if (!isAllowedWebsiteOrigin(req.headers.origin)) {
    return res.status(403).type('html').send(page('Please use the form on our website', back));
  }
  const f = req.body || {};
  if (str(f.b_validate, 100)) return res.redirect(303, thanks('')); // honeypot: say nothing

  const name = str(f.name, 80);
  const phone = str(f.phone, 20);
  if (!name || !phone || f.consent !== 'yes') {
    return res.status(400).type('html').send(page('A few details are missing', `<p>Please go back and fill in your name, your phone number and the consent box.</p>${back}`));
  }

  // Compute the report here when the numbers allow it, so this lead reaches
  // Sales with the same figures a JavaScript visitor would have seen.
  const leadRef = newLeadRef();
  const cfg = config.getConfig();
  const loadText = str(f.sanctioned_load, 30);
  const inputs = cleanInputs({
    state: f.state,
    category: 'other',
    monthlyKwh: f.avg_monthly_kwh,
    monthlyBillInr: f.avg_monthly_bill_inr,
    sanctionedLoad: loadText || null,
    sanctionedLoadUnit: /kw\b/i.test(loadText) && !/kva/i.test(loadText) ? 'kW' : 'kVA',
  });
  const report = cfg && inputs.regionId ? engine.buildReport(inputs, cfg.resolved, cfg.price) : null;

  const lead = {
    name, phone,
    email: str(f.email, 120),
    company: str(f.company, 100),
    state: inputs.state,
    consent: 'yes',
    lead_id: leadRef,
    formId: 'lead.solar.bill-report.nojs',
    source: 'lead.solar.bill-report.nojs',
    service: 'Solar EPC — bill report',
    page: '/solar-savings-report/',
    ...(report && report.ok
      ? { ...engine.leadFields(report, engine.ENGINE_VERSION), report_path: 'nojs', message: engine.summaryLine(report) }
      : { message: `Bill report requested without JavaScript — units ${str(f.avg_monthly_kwh, 20) || '?'}, bill ${str(f.avg_monthly_bill_inr, 20) || '?'}, load ${loadText || '?'} (numbers could not be worked into a report; read them with the customer).` }),
  };

  const { recordWebsiteLead } = require('../routes/webhooks');
  const out = recordWebsiteLead(lead);
  if (out.status >= 300) {
    console.error('[energy-desk] no-JS lead not recorded:', out.status, out.body && out.body.error);
    return res.status(500).type('html').send(page('We could not save your request', `<p>Nothing was saved, so please contact us through <a href="${SITE}/contact/">our contact page</a> — we are sorry for the trouble.</p>`));
  }
  if (report && report.ok && cfg) {
    try {
      storeManualReport(getDb(), { leadRef, inputs, report, engineVersion: engine.ENGINE_VERSION, configVersion: cfg.version, ip: clientIp(req) });
    } catch (e) {
      console.warn('[energy-desk] no-JS report not stored (the lead is):', e.message);
    }
  }
  copyToSheet(lead); // the Sheet feeds the website mailer; never blocks the visitor
  return res.redirect(303, thanks(out.body && out.body.lead_no));
});

// Body-parser refusals (over 32 kb, malformed JSON) answer here with their own
// status, instead of falling through to the app-wide handler as a 500.
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err && (err.status || err.statusCode);
  if (status === 413) return res.status(413).json({ error: 'Request too large.' });
  if (status === 400) return res.status(400).json({ error: 'Malformed request.' });
  console.error('[energy-desk] error:', err && err.message);
  return res.status(500).json({ error: 'Something went wrong.' });
});

module.exports = router;
