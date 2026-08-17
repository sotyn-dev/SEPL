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

module.exports = router;
