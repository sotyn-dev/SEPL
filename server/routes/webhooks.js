const express = require('express');
const cors = require('cors');
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const { notifyMany } = require('../lib/push');

const router = express.Router();

// Allow cross-origin requests from the public website (dev and prod)
router.use(cors());

// Secret key for website webhook ingestion. Can be set in .env as WEBSITE_WEBHOOK_SECRET
const WEBHOOK_SECRET = process.env.WEBSITE_WEBHOOK_SECRET || 'sepl_website_lead_secret_2026';

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

// Helper to estimate numeric value from text like "₹5 Crore - ₹10 Crore" or "5000000"
function parseEstimatedValue(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw >= 0 ? raw : 0;
  const str = String(raw).toLowerCase().trim();
  const crMatch = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:cr|crore)/i);
  if (crMatch) {
    return Math.round(parseFloat(crMatch[1]) * 10000000);
  }
  const lkMatch = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:lakh|lac|l)/i);
  if (lkMatch) {
    return Math.round(parseFloat(lkMatch[1]) * 100000);
  }
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return (!isNaN(num) && num > 0) ? num : 0;
}

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
router.post('/website-lead', (req, res) => {
  const b = req.body || {};

  // 1. Verify Secret Key
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const providedSecret = req.headers['x-webhook-secret'] ||
                         req.headers['x-api-key'] ||
                         bearerToken ||
                         req.query.secret ||
                         b.secret ||
                         b.webhook_secret;

  if (WEBHOOK_SECRET && providedSecret !== WEBHOOK_SECRET) {
    return res.status(401).json({
      error: 'Unauthorized. Invalid or missing x-webhook-secret header.',
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
    projectDetails ? `• Project Details:\n${projectDetails}` : null,
  ].filter(Boolean);

  const remarks = remarksList.join('\n');

  // 6. Project Name
  const projectName = companyName
    ? `${companyName} - ${isRfq ? 'Preliminary BOQ' : (serviceNeeded || 'Quote Enquiry')}`
    : `${clientName} - ${isRfq ? 'Preliminary BOQ' : (serviceNeeded || 'Quote Enquiry')}`;

  const db = getDb();

  try {
    const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });

    const r = db.prepare(`
      INSERT INTO sales_funnel (
        lead_no, client_name, company_name, phone, email,
        category, lead_type, lead_kind,
        project_name, project_location, city,
        estimated_value, tentative_timeline, sub_trades_scope, building_category,
        remarks, source, assigned_sc,
        current_stage, stage_entered_at,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?, 'Website', 'Nancy', 'lead_capture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

    // 7. Audit Log (SOP-01.1 Lead Entry Format)
    try {
      db.prepare(`
        INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_name, notes)
        VALUES (?, 'lead_capture', 'create', 'ERP (Nancy)', ?)
      `).run(leadId, `Auto-captured via securedengineers.com (${formTitle}) · SOP-01.1 Lead Entry Format (Assigned: Nancy)`);
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

    // 8b. Automated Thank-You Message to Client (SOP-01.1)
    if (email) {
      try {
        const { sendEmail } = require('../lib/email');
        sendEmail({
          to: email,
          subject: `Enquiry Received: ${projectName} — Secured Engineers Pvt Ltd`,
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
              <div style="background-color: #1e40af; color: #ffffff; padding: 20px; text-align: center;">
                <h2 style="margin: 0; font-size: 20px;">Secured Engineers Pvt. Ltd.</h2>
                <p style="margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Thank you for getting in touch</p>
              </div>
              <div style="padding: 24px;">
                <p>Dear <strong>${clientName}</strong>,</p>
                <p>We have successfully received your enquiry regarding <strong>${projectName}</strong> (Ref: <strong>${leadNo}</strong>).</p>
                <p>Our Sales Coordinator has received your details and our team will get in touch with you promptly.</p>
                <br>
                <p style="margin: 0; font-size: 13px;">Warm regards,</p>
                <p style="margin: 4px 0 0 0; font-weight: bold; font-size: 14px;">Secured Engineers Team</p>
              </div>
            </div>
          `,
          text: `Dear ${clientName},\n\nThank you for reaching out to Secured Engineers. We have received your enquiry for ${projectName} (Ref: ${leadNo}). Our team will be in touch shortly.`,
        }).catch(err => console.warn('[webhook] thank-you email non-fatal:', err.message));
      } catch (_) {}
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
