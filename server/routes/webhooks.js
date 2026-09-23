const express = require('express');
const cors = require('cors');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const { notifyMany } = require('../lib/push');
const { rateLimit } = require('../lib/rateLimit');
const { clientIp } = require('../lib/clientIp');
const { isAllowedWebsiteOrigin, websiteRefOf, parseEstimatedValue } = require('../lib/websiteLead');

const router = express.Router();

// Allow cross-origin requests from the public website (dev and prod)
router.use(cors());

// Secret for callers that can actually hold one — server to server.
//
// There is deliberately NO fallback value. A default written into the source is
// not a secret: this route shipped with one, the website appended it to the URL
// in every page's JavaScript, and from 21 Sep 2026 it was readable by anyone who
// opened View Source (found 22 Sep 2026). Unset, this path is simply closed, and
// browser traffic is accepted by the website rule below instead. Rotate by
// setting WEBSITE_WEBHOOK_SECRET on the server only, never in the site's build.
const WEBHOOK_SECRET = process.env.WEBSITE_WEBHOOK_SECRET || '';

// Does this request carry the server-to-server secret?
const withValidSecret = (req) => {
  const h = req.headers || {};
  const auth = String(h['authorization'] || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const provided = h['x-webhook-secret'] || h['x-api-key'] || bearer ||
    (req.query && req.query.secret) || (req.body && (req.body.secret || req.body.webhook_secret));
  return Boolean(WEBHOOK_SECRET) && provided === WEBHOOK_SECRET;
};

// Per-IP limits for browser traffic, the same shape routes/publicSotynLead.js
// uses. A caller with a valid secret is not limited: keyFn returns null, and
// rateLimit() lets an unidentifiable caller through rather than blocking it.
const ipKey = (req) => (withValidSecret(req) ? null : 'ip:' + clientIp(req));
// 20 per 10 minutes, not 8 (director's call, 23 Sep 2026). The limiter runs in
// FRONT of the handler, so a refused request spends the allowance too — and the
// address it spends belongs to everyone behind that NAT. A factory office is one
// address, and the website re-posts an enquiry when the reply is slow, so at 8
// three enquiries that each retried twice would lock the building out for ten
// minutes. Losing a genuine enquiry costs more than admitting a few extra posts
// a scripted flood still cannot hide in.
const websiteBurstLimit = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20, keyFn: ipKey,
  message: 'Too many enquiries from this connection — please try again in a few minutes, or send your details on WhatsApp.',
});
const websiteDayLimit = rateLimit({
  windowMs: 24 * 3600 * 1000, max: 40, keyFn: ipKey,
  message: 'Too many enquiries from this connection today — please send your details on WhatsApp.',
});

// Helper to extract a field from nested bodies (e.g. Elementor, CF7, plain JSON)
function getField(body, ...keys) {
  if (!body || typeof body !== 'object') return '';
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
      return typeof body[k] === 'string' ? body[k].trim() : body[k];
    }
    // Check inside Elementor-style fields wrapper { fields: { [name]: { value: '...' } } }
    if (body.fields && typeof body.fields === 'object') {
      const f = body.fields[k];
      if (f !== undefined && f !== null) {
        if (typeof f === 'object' && f.value !== undefined && String(f.value).trim() !== '') {
          return typeof f.value === 'string' ? f.value.trim() : f.value;
        }
        if (typeof f === 'string' && f.trim() !== '') return f.trim();
      }
    }
  }
  return '';
}

// Helper to extract scopes (handles arrays of checkboxes or comma-separated strings)
function extractScopes(body) {
  const raw = getField(body, 'scope', 'scope_required', 'scope_of_work', 'services', 'trades', 'disciplines');
  if (Array.isArray(raw)) return raw.filter(Boolean).map(s => String(s).trim()).join(', ');
  if (typeof raw === 'string' && raw.trim()) return raw.trim();

  // If checkboxes were sent as individual boolean keys:
  const recognizedTrades = [
    ['Mechanical / HVAC', ['scope_hvac', 'scope_mechanical', 'hvac', 'mechanical']],
    ['Electrical', ['scope_electrical', 'electrical']],
    ['Plumbing', ['scope_plumbing', 'plumbing']],
    ['Fire Protection', ['scope_fire', 'fire_protection', 'fire']],
    ['Low Voltage / IT / AV', ['scope_elv', 'scope_low_voltage', 'low_voltage', 'elv']],
    ['Solar EPC', ['scope_solar', 'solar', 'solar_epc']],
    ['Design & Approvals', ['scope_design', 'design_approvals']],
    ['AMC / Maintenance', ['scope_amc', 'amc_maintenance', 'amc']],
    ['Turnkey EPC', ['scope_turnkey', 'turnkey_epc']],
    ['Fire NOC Assistance', ['scope_fire_noc', 'fire_noc']],
    ['CEIG Liaison & Energisation', ['scope_ceig', 'ceig']],
    ['Testing & Commissioning', ['scope_testing', 'testing_commissioning']],
    ['Industrial Audits', ['scope_audits', 'industrial_audits']],
  ];

  const matched = [];
  for (const [label, keys] of recognizedTrades) {
    for (const k of keys) {
      if (body[k] === true || body[k] === '1' || body[k] === 'on' || body[k] === 'yes' || body[k] === label) {
        matched.push(label);
        break;
      }
    }
  }
  return matched.join(', ');
}

// parseEstimatedValue now lives in ../lib/websiteLead.js, where it can be tested.
// It also reads a band the way the band is written: "₹50 lakh – ₹1 crore" is
// ₹50 lakh, the floor. This file used to search for "crore" first wherever it
// appeared, which read that same band as ₹1 crore and doubled the enquiry.

// Health check / test endpoint for webmasters
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SEPL ERP Webhook Service',
    lead_endpoint: '/api/webhooks/website-lead',
    timestamp: new Date().toISOString(),
  });
});

router.get('/test', (req, res) => {
  res.json({
    status: 'ok',
    message: 'SEPL Webhook router is operational. Send a POST request to /api/webhooks/website-lead.',
  });
});

// POST /api/webhooks/website-lead
// Ingests leads directly into Sales Funnel Stage 1 (Lead/Tender Capture)
router.post('/website-lead', websiteBurstLimit, websiteDayLimit, (req, res) => {
  const b = req.body || {};

  // 1. Who is calling?
  //
  // Two accepted callers, and neither needs a token inside public JavaScript:
  //   • our own website, recognised by the Origin header. A browser sets that
  //     itself and a page on another site cannot forge it, so a form on
  //     securedengineers.com is admitted while a form elsewhere is not. The
  //     honeypot below, the field validation and the per-IP limits above are
  //     the rest of the defence — the same reasoning, and the same shape, as
  //     routes/publicSotynLead.js uses for the sotyn.ai forms.
  //   • server-to-server callers holding WEBSITE_WEBHOOK_SECRET.
  //
  // This is write-only either way: the route inserts one sales_funnel row and
  // returns its number. It never reads a lead back and never lists anything.
  const viaSecret = withValidSecret(req);
  const viaWebsite = isAllowedWebsiteOrigin(req.headers.origin);
  if (!viaSecret && !viaWebsite) {
    return res.status(401).json({
      error: 'Unauthorized. Post from an allowed website origin, or send a valid x-webhook-secret header.',
    });
  }

  // 2. Honeypot Anti-Spam Check (Silently drop spam without failing so bots don't adapt)
  const honeypot = getField(b, 'hp_field', 'website_url', 'honeypot', 'extra_note_hp');
  if (honeypot) {
    console.warn('[webhook] Spam bot detected via honeypot field. Dropping request silently.');
    return res.status(200).json({ success: true, message: 'Enquiry received successfully.' });
  }

  // 3. Extract Core Fields
  const clientName = getField(b, 'name', 'full_name', 'client_name', 'your_name', 'contact_name');
  if (!clientName) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  const phone = getField(b, 'phone', 'whatsapp', 'phone_whatsapp', 'mobile', 'tel', 'phone_number');
  const email = getField(b, 'email', 'email_address', 'your_email');
  const companyName = getField(b, 'company', 'company_name', 'organization', 'firm');
  const city = getField(b, 'project_city', 'city', 'location', 'project_location');
  const projectLocation = getField(b, 'project_location', 'location', 'city', 'project_city');
  const serviceNeeded = getField(b, 'service', 'service_needed', 'category', 'service_requested');
  const role = getField(b, 'role', 'your_role', 'lead_type', 'designation');
  const industry = getField(b, 'industry', 'building_category', 'industry_type', 'sector');
  const plotArea = getField(b, 'plot_area', 'built_up_area', 'area', 'built_up_plot_area');
  const powerLoad = getField(b, 'power_load', 'estimated_power_load', 'load');
  const rawProjectValue = getField(b, 'project_value', 'estimated_project_value', 'estimated_value', 'budget');
  const estimatedValue = parseEstimatedValue(rawProjectValue);
  const projectStage = getField(b, 'project_stage', 'stage');
  const tenderStage = getField(b, 'tender_stage', 'tender_selection_stage');
  const awardDate = getField(b, 'expected_award_date', 'award_date', 'expected_award_start_date', 'timeline', 'start_date', 'tentative_timeline');
  const scopes = extractScopes(b);
  const projectDetails = getField(b, 'project_details', 'details', 'message', 'remarks', 'scope_details', 'scope_size_timeline');

  // 4. Identify Form Type (Free Quote vs Preliminary BOQ)
  const isRfq = Boolean(
    b.form_type === 'rfq' ||
    b.rfq === true ||
    plotArea ||
    powerLoad ||
    tenderStage ||
    (scopes && scopes.length > 0) ||
    (rawProjectValue && String(rawProjectValue).toLowerCase().includes('5 cr'))
  );

  const formTitle = isRfq ? 'Request a Preliminary BOQ (/rfq/)' : 'Request a Free Quote';

  // 4b. The website's own reference for this submission, identical across its
  // retries. The site posts again when a reply is slow (it prefers a duplicate
  // to a lost lead), and on 22 Sep a 20-second reply produced two records for
  // one enquiry. Recognising the reference makes a repeat idempotent.
  const websiteRef = websiteRefOf(b);

  // 5. Compile Rich Remarks / Scoping Notes
  const remarksList = [
    `[Website Enquiry: ${formTitle}]`,
    companyName ? `• Company: ${companyName}` : null,
    role ? `• Submitter Role: ${role}` : null,
    serviceNeeded ? `• Service Needed: ${serviceNeeded}` : null,
    industry ? `• Industry / Building Category: ${industry}` : null,
    plotArea ? `• Built-Up / Plot Area: ${plotArea}` : null,
    powerLoad ? `• Estimated Power Load: ${powerLoad}` : null,
    rawProjectValue ? `• Project Value: ${rawProjectValue}` : null,
    projectStage ? `• Project Stage: ${projectStage}` : null,
    tenderStage ? `• Tender / Selection Stage: ${tenderStage}` : null,
    awardDate ? `• Expected Award / Start: ${awardDate}` : null,
    scopes ? `• Scopes Selected: ${scopes}` : null,
    // The reference the visitor is shown on /thank-you/. Storing it lets Sales
    // match a caller's "my reference is SEPL-2026…" to this record, and lets
    // anyone reconcile the ERP against the website's own Sheet of enquiries.
    websiteRef ? `• Website ref: ${websiteRef}` : null,
    projectDetails ? `• Project Details:\n${projectDetails}` : null,
  ].filter(Boolean);

  const remarks = remarksList.join('\n');

  // 6. Project Name
  const projectName = companyName
    ? `${companyName} - ${isRfq ? 'Preliminary BOQ' : (serviceNeeded || 'Quote Enquiry')}`
    : `${clientName} - ${isRfq ? 'Preliminary BOQ' : (serviceNeeded || 'Quote Enquiry')}`;

  const db = getDb();

  try {
    // Same submission arriving twice? Answer with the record we already have,
    // so a slow reply or a retry never becomes a second lead for Sales to work.
    if (websiteRef) {
      const seen = db.prepare(`
        SELECT lead_no FROM sales_funnel
        WHERE source = 'Website' AND remarks LIKE ?
          AND created_at >= datetime('now', '-2 days')
        ORDER BY id DESC LIMIT 1
      `).get(`%Website ref: ${websiteRef}%`);
      if (seen) {
        console.log(`[webhook] website ref ${websiteRef} already recorded as ${seen.lead_no} — not inserting again`);
        return res.status(200).json({
          success: true,
          lead_no: seen.lead_no,
          duplicate: true,
          stage: 'lead_capture',
          message: `Lead ${seen.lead_no} was already recorded for this enquiry.`,
        });
      }
    }

    const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });

    const r = db.prepare(`
      INSERT INTO sales_funnel (
        lead_no, client_name, company_name, phone, email,
        category, lead_type, lead_kind,
        project_name, project_location, city,
        estimated_value, tentative_timeline, sub_trades_scope, building_category,
        remarks, source,
        current_stage, stage_entered_at,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, 'Website', 'lead_capture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      leadNo,
      clientName,
      companyName || null,
      phone || null,
      email || null,
      serviceNeeded || (isRfq ? 'MEPF Project' : null),
      role || 'Customer',
      projectName,
      projectLocation || city || null,
      city || null,
      estimatedValue,
      awardDate || null,
      scopes || serviceNeeded || null,
      industry || null,
      remarks,
    );

    const leadId = r.lastInsertRowid;

    // 7. Audit Log
    try {
      db.prepare(`
        INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_name, notes)
        VALUES (?, 'lead_capture', 'create', 'Website Webhook', ?)
      `).run(leadId, `Auto-captured via securedengineers.com (${formTitle})`);
    } catch (auditErr) {
      console.warn('[webhook] audit log non-fatal error:', auditErr.message);
    }

    // 8. In-App Notifications (Header Bell Icon) & Web Push
    const notifTitle = `New Website Lead: ${clientName}`;
    const notifBody = `${companyName ? companyName + ' · ' : ''}${city || 'Website'} — ${formTitle} (${leadNo})`;
    const notifLink = `/leads?stage=lead_capture&search=${encodeURIComponent(leadNo)}`;

    try {
      const usersToNotify = db.prepare(`
        SELECT id FROM users
        WHERE active = 1 AND (role = 'admin' OR department IN ('Sales', 'BD', 'Marketing', 'Management'))
      `).all();

      // Write in-app notification rows for the Bell Inbox
      const insertNotif = db.prepare(`
        INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent)
        VALUES (?, 'new_lead', ?, ?, ?, 'in_app')
      `);

      for (const u of usersToNotify) {
        try {
          insertNotif.run(u.id, notifTitle, notifBody, notifLink);
        } catch (_) {}
      }

      if (usersToNotify.length > 0) {
        const userIds = usersToNotify.map(u => u.id);
        notifyMany(userIds, {
          title: `🚨 ${notifTitle}`,
          body: notifBody,
          url: notifLink,
        });
      }
    } catch (pushErr) {
      console.warn('[webhook] notification write non-fatal error:', pushErr.message);
    }

    // 9. Real-Time Socket.IO Broadcast (No-refresh instant update + live sound & banner)
    try {
      const { getIO } = require('../lib/chatSocket');
      const io = getIO();
      if (io) {
        io.emit('lead:new', {
          lead_id: leadId,
          lead_no: leadNo,
          client_name: clientName,
          company_name: companyName,
          city,
          formTitle,
          current_stage: 'lead_capture',
          stage_entered_at: new Date().toISOString(),
        });
        io.emit('notification:new', {
          type: 'new_lead',
          title: notifTitle,
          body: notifBody,
          link_url: notifLink,
          created_at: new Date().toISOString(),
        });
      }
    } catch (ioErr) {
      console.warn('[webhook] socket broadcast non-fatal error:', ioErr.message);
    }

    console.log(`[webhook] Successfully created lead ${leadNo} from website (${formTitle})`);

    return res.status(201).json({
      success: true,
      lead_no: leadNo,
      lead_id: leadId,
      stage: 'lead_capture',
      message: `Lead ${leadNo} successfully recorded in Sales Funnel Stage 1 with 1-hour SLA.`,
    });
  } catch (err) {
    console.error('[webhook] Error saving website lead:', err);
    return res.status(500).json({
      error: 'Failed to record lead in ERP. Please contact ERP administration.',
      details: err.message,
    });
  }
});

module.exports = router;
