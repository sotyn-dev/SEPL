// Public HR endpoints — NO AUTHENTICATION REQUIRED.
//
// Mam (2026-05-22 Phase 1 Batch D, module #9 - "Offer acceptance
// via link"): candidate clicks a link in the offer email, lands on
// /offer/:token, sees the offer letter inline, and clicks Accept
// or Decline.  No SEPL login required.
//
// Security model:
//   • Token is a random 32-byte base64url string (~256 bits of
//     entropy) → not brute-forceable.
//   • Token is single-use: lookup must match AND status must be
//     'offer_sent' to allow a response.  Once accepted/declined,
//     subsequent POSTs return 409 'Offer already responded to'.
//   • Sensitive fields (salary, internal notes) ARE exposed in the
//     GET response because that's the whole point — candidate
//     needs to see the offer to decide.  We do NOT expose any
//     other candidate's data.
//
// Mounted at /api/public/offer/* — must come BEFORE the global
// auth middleware in server/index.js (or be its own router so it
// doesn't inherit hr.js's authMiddleware).

const express = require('express');
const { getDb } = require('../db/schema');
const router = express.Router();
const personalFields = require('../../shared/employeeMaster.json').fields.filter(f => ['date_of_birth', 'gender', 'blood_group', 'emergency_contact_name', 'emergency_contact_phone', 'guardian_title', 'guardian_relation', 'guardian_name'].includes(f.key));

// ── GET /api/public/offer/:token ─────────────────────────────────
// Returns just enough for the public offer page to render the
// letter and show Accept / Decline buttons.
router.get('/offer/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(400).json({ error: 'Invalid offer link' });
  const c = getDb().prepare(
    `SELECT id, name, email, phone, address,
            position, offered_position, offered_salary, joining_date,
            reporting_to, salary_breakup, offer_sent_at, status,
            offer_accepted_at, offer_declined_at, offer_response_note
       FROM candidates WHERE offer_token = ?`
  ).get(token);
  if (c) return res.json({ ok: true, offer: c });

  // Fallback (audit 2026-08-17): the HR SYSTEM module issues its own tokens
  // from hr_offers.accept_token but reuses this same /offer/:token page —
  // every new-style offer link showed "Offer not found" to the candidate
  // (and the module's own accept API sits behind login). Map an hr_offers
  // row to the exact shape the public page renders.
  const ho = hrSystemOffer(token);
  if (!ho) return res.status(404).json({ error: 'Offer not found or has been revoked' });
  if (ho.err) return res.status(410).json({ error: ho.err });
  res.json({ ok: true, offer: ho });
});

// hr_offers → public-page shape. Returns null (not found / not public),
// {err} (expired), or the offer object.
function hrSystemOffer(token) {
  const db = getDb();
  let o;
  try {
    // NB: the live hr_candidates table's name column is full_name
    // (older installs may have `name` — COALESCE at the JS level below).
    o = db.prepare(
      `SELECT o.id, o.candidate_id, o.offered_position, o.offered_salary,
              o.joining_date, o.status, o.responded_at, o.expiry_date, o.sent_at,
              c.full_name, c.email, c.phone, c.current_role
         FROM hr_offers o JOIN hr_candidates c ON c.id = o.candidate_id
        WHERE o.accept_token = ?`
    ).get(token);
  } catch (_) { return null; /* hr_offers tables not created yet */ }
  if (!o) return null;
  // draft was never sent; withdrawn is revoked — both invisible publicly.
  if (o.status === 'draft' || o.status === 'withdrawn') return null;
  const { istToday } = require('../lib/istDate');
  const expired = o.status === 'expired' ||
    (o.status === 'sent' && o.expiry_date && o.expiry_date < istToday());
  if (expired) return { err: 'This offer has expired. Please contact HR for a fresh offer letter.' };
  return {
    id: o.id, name: o.full_name, email: o.email, phone: o.phone, address: null,
    position: o.current_role, offered_position: o.offered_position,
    offered_salary: o.offered_salary, joining_date: o.joining_date,
    reporting_to: null, salary_breakup: null, offer_sent_at: o.sent_at,
    status: o.status,
    offer_accepted_at: o.status === 'accepted' ? o.responded_at : null,
    offer_declined_at: o.status === 'declined' ? o.responded_at : null,
    offer_response_note: null,
    _source: 'hr_system',
  };
}

// ── POST /api/public/offer/:token/respond ────────────────────────
// Body: { decision: 'accept' | 'decline', note?: '...' }
// Marks the candidate accepted or rejected.  Idempotency: if the
// candidate has already responded, returns 409 with the previous
// decision so the public page can show a clear message.
router.post('/offer/:token/respond', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(400).json({ error: 'Invalid offer link' });
  const { decision, note } = req.body || {};
  if (!['accept','decline'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be accept or decline' });
  }
  const db = getDb();
  const c = db.prepare('SELECT id, status, offer_accepted_at, offer_declined_at FROM candidates WHERE offer_token = ?').get(token);
  if (!c) return respondHrSystemOffer(db, token, decision, note, res);
  if (c.offer_accepted_at) return res.status(409).json({ error: 'This offer was already accepted', responded_at: c.offer_accepted_at });
  if (c.offer_declined_at) return res.status(409).json({ error: 'This offer was already declined', responded_at: c.offer_declined_at });
  if (!['offer_sent','accepted','onboarded','rejected'].includes(c.status)) {
    return res.status(409).json({ error: 'This offer is no longer active' });
  }

  const isAccept = decision === 'accept';
  const newStatus = isAccept ? 'accepted' : 'rejected';
  const nowField  = isAccept ? 'offer_accepted_at' : 'offer_declined_at';
  db.prepare(`UPDATE candidates SET
                ${nowField} = CURRENT_TIMESTAMP,
                offer_response_note = ?,
                status = ?
              WHERE id = ?`)
    .run(note || null, newStatus, c.id);

  // Log to candidate_events (best-effort — we have no req.user here,
  // so user_id stays NULL; user_name is the candidate's own name).
  try {
    const name = db.prepare('SELECT name FROM candidates WHERE id=?').get(c.id)?.name;
    db.prepare(`INSERT INTO candidate_events
                  (candidate_id, event_type, to_status, note, user_name)
                VALUES (?,?,?,?,?)`)
      .run(c.id, isAccept ? 'offer_accepted' : 'offer_declined', newStatus,
           `Candidate ${isAccept ? 'accepted' : 'declined'} via public link${note ? ' — ' + note : ''}`,
           `${name || 'Candidate'} (via offer link)`);
  } catch (e) { console.warn('[publicHr] event log skipped:', e.message); }

  res.json({ ok: true, decision, status: newStatus });
});

// POST fallback for HR SYSTEM offers (hr_offers.accept_token) — mirrors the
// module's own (auth-locked) accept logic: only a 'sent' offer may respond,
// accept flips the candidate to 'joined', response is idempotent (409 after).
function respondHrSystemOffer(db, token, decision, note, res) {
  let o;
  try {
    o = db.prepare('SELECT * FROM hr_offers WHERE accept_token = ?').get(token);
  } catch (_) { o = null; }
  if (!o || o.status === 'draft' || o.status === 'withdrawn') {
    return res.status(404).json({ error: 'Offer not found' });
  }
  if (o.status === 'accepted') return res.status(409).json({ error: 'This offer was already accepted', responded_at: o.responded_at });
  if (o.status === 'declined') return res.status(409).json({ error: 'This offer was already declined', responded_at: o.responded_at });
  const { istToday } = require('../lib/istDate');
  if (o.status === 'expired' || (o.expiry_date && o.expiry_date < istToday())) {
    return res.status(409).json({ error: 'This offer has expired. Please contact HR.' });
  }
  if (o.status !== 'sent') return res.status(409).json({ error: 'This offer is no longer active' });

  const isAccept = decision === 'accept';
  const newStatus = isAccept ? 'accepted' : 'declined';
  db.prepare(`UPDATE hr_offers SET status=?, responded_at=CURRENT_TIMESTAMP,
                notes = COALESCE(notes,'') || ?
              WHERE id=?`)
    .run(newStatus, note ? `\n[Candidate ${newStatus}] ${String(note).slice(0, 500)}` : '', o.id);
  if (isAccept) db.prepare("UPDATE hr_candidates SET status='joined', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.candidate_id);

  try {
    db.prepare(`INSERT INTO hr_candidate_activity (candidate_id, activity_type, to_status, note)
                VALUES (?,?,?,?)`)
      .run(o.candidate_id, isAccept ? 'offer_accepted' : 'offer_declined',
           isAccept ? 'joined' : null,
           `Candidate ${newStatus} via public offer link${note ? ' — ' + String(note).slice(0, 200) : ''}`);
  } catch (e) { console.warn('[publicHr] hr_system activity log skipped:', e.message); }

  res.json({ ok: true, decision, status: newStatus });
}

// ── Employee self-fill (2026-08-17) ──────────────────────────────
// HR shares /employee-fill/<token>; the employee fills their own details
// with no login (same trust model as the offer link: the token IS the
// identity). Single-use + 7-day expiry, enforced here.

function liveFillLink(db, token) {
  if (!token || String(token).length < 16) return { err: [400, 'Invalid link'] };
  const link = db.prepare('SELECT * FROM employee_fill_links WHERE token=?').get(String(token));
  if (!link) return { err: [404, 'This link is not valid or has been replaced by a newer one'] };
  // A standing new-joiner link (multi_use) serves every joiner — never consumed.
  if (link.used_at && !link.multi_use) return { err: [409, 'Details were already submitted through this link. Ask HR for a fresh link if something needs correcting.'] };
  const expired = db.prepare("SELECT 1 ok FROM employee_fill_links WHERE id=? AND expires_at IS NOT NULL AND expires_at < datetime('now')").get(link.id);
  if (expired) return { err: [410, 'This link has expired. Ask HR to send a fresh one.'] };
  return { link };
}

router.get('/employee-fill/:token/ifsc/:code', (req, res, next) => {
  const { err } = liveFillLink(getDb(), req.params.token);
  if (err) return res.status(err[0]).json({ error: err[1] });
  next();
}, require('../lib/ifscLookup'));

router.get('/employee-fill/:token', (req, res) => {
  const db = getDb();
  const { link, err } = liveFillLink(db, req.params.token);
  if (err) return res.status(err[0]).json({ error: err[1] });
  let employee = null;
  if (link.employee_id) {
    const e = db.prepare(`SELECT name, phone, email, designation, department, join_date,
                                 date_of_birth, gender, blood_group, emergency_contact_name, emergency_contact_phone, guardian_title, guardian_relation, guardian_name, aadhar_file, pan_file, qualification_file, permanent_address, permanent_pin, current_address, current_pin, same_as_permanent, aadhaar_last4, pan_number, bank_account_no
                            FROM employees WHERE id=?`).get(link.employee_id);
    if (!e) return res.status(404).json({ error: 'This link is no longer valid' });
    // Prefill basics; docs only as has-flags (never leak stored file URLs publicly)
    employee = {
      ...Object.fromEntries(personalFields.map(f => [f.key, e[f.key]])),
      name: e.name, phone: e.phone, email: e.email,
      designation: e.designation, department: e.department, join_date: e.join_date,
      permanent_address: e.permanent_address, permanent_pin: e.permanent_pin, current_address: e.current_address, current_pin: e.current_pin, same_as_permanent: e.same_as_permanent,
      has_aadhaar_number: !!e.aadhaar_last4, has_pan_number: !!e.pan_number, has_bank_details: !!e.bank_account_no,
      has_aadhar: !!e.aadhar_file, has_pan: !!e.pan_file, has_qualification: !!e.qualification_file,
    };
  }
  res.json({ ok: true, mode: link.employee_id ? 'update' : 'create', employee });
});

router.post('/employee-fill/:token', (req, res) => {
  const db = getDb();
  const { link, err } = liveFillLink(db, req.params.token);
  if (err) return res.status(err[0]).json({ error: err[1] });

  const b = req.body || {};
  const s = (v, max = 200) => (v === undefined || v === null) ? undefined : String(v).trim().slice(0, max);
  // Uploaded docs must be OUR uploads (from the token-scoped public upload
  // endpoint) — an arbitrary external URL is rejected.
  const doc = (v) => {
    const u = s(v, 500);
    if (u === undefined || u === '') return undefined;
    return u.startsWith('/uploads/') ? u : undefined;
  };
  const vals = {
    name: s(b.name), phone: s(b.phone, 20), email: s(b.email),
    designation: s(b.designation), department: s(b.department),
    join_date: s(b.join_date, 10),
    aadhar_file: doc(b.aadhar_file), pan_file: doc(b.pan_file), qualification_file: doc(b.qualification_file),
  };

  const address = {};
  for (const key of ['permanent_address','permanent_pin','current_address','current_pin']) {
    if (b[key] === undefined || b[key] === null || b[key] === '') continue;
    if (typeof b[key] !== 'string' || b[key].length > 2000) return res.status(400).json({ error: 'Enter a valid address' });
    address[key] = b[key].trim();
    if (key.endsWith('_pin') && address[key] && !/^[1-9][0-9]{5}$/.test(address[key])) return res.status(400).json({ error: 'PIN codes must be six digits and cannot start with zero' });
  }
  if ('same_as_permanent' in b) {
    if (![0,1,true,false].includes(b.same_as_permanent)) return res.status(400).json({error:'Invalid address selection'});
    address.same_as_permanent = b.same_as_permanent ? 1 : 0;
  }
  // Explicit allowlist: self-fill cannot write salary, permissions or login links.
  const formats = {
    aadhaar_last4: [/^[0-9]{4}$/, 'Enter only the last four Aadhaar digits'],
    pan_number: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN number'],
    bank_ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code'],
    bank_account_no: [/^[0-9]{6,20}$/, 'Bank account number must contain 6 to 20 digits'],
  };
  for (const key of ['aadhaar_last4','pan_number','bank_ifsc','bank_name','bank_branch','bank_account_no']) {
    if (b[key] == null || b[key] === '') continue;
    if (typeof b[key] !== 'string' || b[key].length > 200) return res.status(400).json({error:'Enter valid bank and identity details'});
    const value = ['pan_number','bank_ifsc'].includes(key) ? b[key].trim().toUpperCase() : b[key].trim();
    if (!value) continue;
    if (formats[key] && !formats[key][0].test(value)) return res.status(400).json({error:formats[key][1]});
    address[key] = value;
  }
  for (const field of personalFields) {
    const raw = b[field.key];
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 200) return res.status(400).json({error: `Enter a valid ${field.label}`});
    const value = raw.trim();
    if (!value) continue;
    if (field.options && !field.options.some(([option]) => option === value)) return res.status(400).json({error: `Select a valid ${field.label}`});
    if (field.key === 'emergency_contact_phone' && !/^[0-9]{10}$/.test(value)) return res.status(400).json({error:'Emergency contact phone must contain 10 digits'});
    if (field.key === 'date_of_birth') {
      const date = new Date(value + 'T00:00:00Z');
      const today = require('../lib/istDate').istToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value || value > today) return res.status(400).json({error:'Enter a valid date of birth'});
    }
    address[field.key] = value;
  }
  let employeeId = link.employee_id;
  try {
    if (employeeId) {
      const existing = db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId);
      if (!existing) return res.status(404).json({ error: 'This link is no longer valid' });
      // Update only what was actually filled — blank/omitted keeps stored value.
      const pick = (k) => (vals[k] !== undefined && vals[k] !== '') ? vals[k] : existing[k];
      db.prepare(`UPDATE employees SET name=?, phone=?, email=?, designation=?, department=?,
                     join_date=?, aadhar_file=?, pan_file=?, qualification_file=?
                   WHERE id=?`)
        .run(pick('name'), pick('phone'), pick('email'), pick('designation'), pick('department'),
             pick('join_date'), pick('aadhar_file'), pick('pan_file'), pick('qualification_file'), employeeId);
    } else {
      // New joiner — same mandate as HR's own create form: identity + all 3 docs.
      if (!vals.name || vals.name.length < 2) return res.status(400).json({ error: 'Please enter your full name' });
      if (!vals.phone || vals.phone.replace(/\D/g, '').length < 6) return res.status(400).json({ error: 'Please enter a valid phone number' });
      if (!vals.aadhar_file)        return res.status(400).json({ error: 'Please upload your Aadhar card' });
      if (!vals.pan_file)           return res.status(400).json({ error: 'Please upload your PAN card' });
      if (!vals.qualification_file) return res.status(400).json({ error: 'Please upload your highest qualification certificate' });
      // Duplicate guard: same mobile number already in the directory → don't
      // create a second row (and never let a public link OVERWRITE an existing
      // employee) — the person contacts HR instead. Compare on the LAST 10
      // DIGITS so '+91 90000 00101', '090000 00101' and '9000000101' all
      // match the same stored number.
      const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
      const mine = last10(vals.phone);
      if (mine.length === 10) {
        const dupe = db.prepare('SELECT id, phone FROM employees').all()
          .find(e => last10(e.phone) === mine);
        if (dupe) return res.status(409).json({ error: 'This mobile number is already registered with HR. Please contact HR to update your details.' });
      }
      const { istToday } = require('../lib/istDate');
      const r = db.prepare(`INSERT INTO employees (name, phone, email, designation, department, join_date,
                              aadhar_file, pan_file, qualification_file)
                            VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(vals.name, vals.phone, vals.email || '', vals.designation || '', vals.department || '',
             vals.join_date || istToday(), vals.aadhar_file, vals.pan_file, vals.qualification_file);
      employeeId = r.lastInsertRowid;
    }
    const existingAddress = db.prepare('SELECT permanent_address,permanent_pin,same_as_permanent FROM employees WHERE id=?').get(employeeId);
    if (address.same_as_permanent ?? existingAddress.same_as_permanent) {
      address.current_address = address.permanent_address ?? existingAddress.permanent_address;
      address.current_pin = address.permanent_pin ?? existingAddress.permanent_pin;
    }
    const addressKeys = Object.keys(address);
    if (addressKeys.length) db.prepare(`UPDATE employees SET ${addressKeys.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...addressKeys.map(key => address[key] ?? null),employeeId);
    // Single-use links are consumed; a standing (multi_use) new-joiner link
    // stays live for the next joiner — only the latest submitter name is noted.
    if (link.multi_use) {
      db.prepare('UPDATE employee_fill_links SET submitted_name=? WHERE id=?').run(vals.name || null, link.id);
    } else {
      db.prepare('UPDATE employee_fill_links SET used_at=CURRENT_TIMESTAMP, submitted_name=? WHERE id=?')
        .run(vals.name || null, link.id);
    }
  } catch (e) {
    console.error('[publicHr] employee-fill failed:', e.message);
    return res.status(500).json({ error: 'Could not save your details — please contact HR' });
  }

  try {
    require('../middleware/audit').logAuditEvent({
      user: { id: null, name: `${vals.name || 'Employee'} (self-fill link)`, role: 'public' },
      action: link.employee_id ? 'SELF_FILL_UPDATE' : 'SELF_FILL_CREATE',
      entity_type: 'employees', entity_id: employeeId,
      entity_label: `Employee details submitted via self-fill link (shared by user #${link.created_by})`,
      method: 'POST', path: req.originalUrl, body: vals,
    });
  } catch (_) {}
  try {
    const { notify } = require('../lib/push');
    notify(link.created_by, {
      title: `📝 Employee details received`,
      body: `${vals.name || 'An employee'} submitted their details via your self-fill link`,
      url: '/employees',
    });
  } catch (_) {}

  res.json({ ok: true, mode: link.employee_id ? 'updated' : 'created' });
});

module.exports = router;
