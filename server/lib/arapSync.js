// Cash Flow Tracker <- Collections + Payables auto-feed (mam 2026-09-03).
//
// The tracker used to be a hand-keyed / Excel-imported sheet. Mam's CR: the
// Finance module keeps Cheques, Payables and Collections, the old "Cash Flow"
// page goes, and the AR/AP Tracker — renamed "Cash Flow Tracker" — stops being
// typed in and builds itself from the two modules that already hold the money:
//
//   AR side <- receivables (Collections)  : what clients still owe us
//   AP side <- payment_requests (Payables): what we still have to pay out
//
// Mam chose "auto-fed but still editable": a synced row can be corrected by
// Finance, and the moment they touch an amount or a date that field is PINNED
// (manual_planned / manual_date) so the next sync never stomps their number.
// Everything else keeps tracking the source. The mandatory-remark rule and the
// change log apply exactly as before — including to the sync itself, so every
// automatic move is attributable.
//
// Amounts: the source modules are in RUPEES, the tracker is in LAKHS (mam's
// choice) — so everything crossing this boundary is divided by 1,00,000.
const { istToday } = require('./istDate');

const LAKH = 100000;
const toL = (rupees) => Math.round(((+rupees || 0) / LAKH) * 100) / 100;

const numEq = (a, b) => (a == null ? null : +a) === (b == null ? null : +b);

// ── AR: what Collections says is still coming in ───────────────────────
//
// Expected date = the latest promised date from a follow-up (that is the real
// commitment Finance chased), else the invoice due date, else today.
// Expected amount = whatever is still outstanding on the invoice.
function arSources(db) {
  const promised = `(SELECT f.promised_date FROM collection_follow_ups f
                      WHERE f.receivable_id = r.id
                        AND f.promised_date IS NOT NULL AND TRIM(f.promised_date) <> ''
                      ORDER BY f.follow_up_date DESC, f.id DESC LIMIT 1)`;
  // Live rows + any row we already synced (so a settled invoice can be closed
  // out on the grid instead of hanging there as a phantom receipt).
  const rows = db.prepare(`
    SELECT r.id, r.client_name, r.project_name, r.invoice_number,
           COALESCE(r.outstanding_amount,0) AS outstanding,
           COALESCE(r.invoice_amount,0)     AS invoice_amount,
           r.due_date, ${promised} AS promised_date
      FROM receivables r
     WHERE COALESCE(r.outstanding_amount,0) > 0
        OR r.id IN (SELECT source_id FROM arap_entries WHERE source='collections')`).all();
  const today = istToday();
  return rows.map(r => ({
    kind: 'AR',
    source: 'collections',
    source_id: r.id,
    party: String(r.client_name || '').trim() || 'Unknown client',
    due_date: String(r.promised_date || r.due_date || today).slice(0, 10),
    planned: toL(r.outstanding),
    note: [r.invoice_number ? `Inv ${r.invoice_number}` : null, r.project_name || null]
      .filter(Boolean).join(' · ') || null,
    live: (+r.outstanding || 0) > 0,
    cancelled: false,
  }));
}

// ── AP: what Payables says is still going out ──────────────────────────
//
// In-flight requests (anything not finally released and not rejected) are the
// future outflow. `final_approved` means Payment Release happened — the money
// has moved, so that row closes as done. `rejected` closes as cancelled.
function apSources(db) {
  const rows = db.prepare(`
    SELECT id, request_no, employee_name, vendor_name, driver_vendor_name,
           site_name, category, purpose, required_by_date, created_at, status,
           COALESCE(approved_amount, amount, 0) AS amount
      FROM payment_requests
     WHERE status NOT IN ('final_approved','rejected')
        OR id IN (SELECT source_id FROM arap_entries WHERE source='payables')`).all();
  const today = istToday();
  return rows.map(r => ({
    kind: 'AP',
    source: 'payables',
    source_id: r.id,
    party: String(r.vendor_name || r.driver_vendor_name || r.employee_name || '').trim() || 'Unknown payee',
    due_date: String(r.required_by_date || String(r.created_at || '').slice(0, 10) || today).slice(0, 10),
    planned: toL(r.amount),
    note: [r.request_no || null, r.category || null, r.site_name || null,
           r.purpose ? String(r.purpose).slice(0, 60) : null].filter(Boolean).join(' · ') || null,
    live: r.status !== 'final_approved' && r.status !== 'rejected',
    cancelled: r.status === 'rejected',
  }));
}

// One sync pass. Returns a small report so the UI can say what moved.
// `logChange` is injected by the route so the change log stays in one place.
function syncArap(db, logChange, user) {
  const sysUser = user || { id: null, name: 'Auto-sync' };
  const report = { created: 0, updated: 0, closed: 0, cancelled: 0, skipped: 0 };

  const excluded = new Set(
    db.prepare('SELECT source, source_id FROM arap_sync_excluded').all()
      .map(r => `${r.source}#${r.source_id}`));

  const findRow = db.prepare('SELECT * FROM arap_entries WHERE source=? AND source_id=?');
  const insert = db.prepare(`
    INSERT INTO arap_entries (kind, party, due_date, planned, actual, status, note,
                              source, source_id, source_amount, source_date, synced_at,
                              created_by, created_by_name)
    VALUES (?,?,?,?,NULL,'planned',?,?,?,?,?,CURRENT_TIMESTAMP,?,?)`);
  const touch = db.prepare('UPDATE arap_entries SET synced_at=CURRENT_TIMESTAMP WHERE id=?');

  const apply = (src) => {
    if (excluded.has(`${src.source}#${src.source_id}`)) { report.skipped++; return; }
    const cur = findRow.get(src.source, src.source_id);

    // Never invent a row for something that is already settled — the tracker
    // is a forecast, not an archive. Only live sources get seeded.
    if (!cur) {
      if (!src.live) { report.skipped++; return; }
      const info = insert.run(src.kind, src.party, src.due_date, src.planned, src.note,
                              src.source, src.source_id, src.planned, src.due_date,
                              sysUser.id, sysUser.name || 'Auto-sync');
      const row = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(info.lastInsertRowid);
      logChange(db, row, 'created', '',
                `${src.kind} · ${src.party} · ${src.due_date} · ₹${src.planned}L`,
                `Auto-synced from ${src.source === 'collections' ? 'Collections' : 'Payables'}`, sysUser);
      report.created++;
      return;
    }

    // A row Finance already closed by hand is left alone entirely.
    if (cur.status === 'done' || cur.status === 'cancelled') { touch.run(cur.id); report.skipped++; return; }

    const why = `Auto-sync from ${src.source === 'collections' ? 'Collections' : 'Payables'}`;
    const sets = [], args = [];
    const change = (field, oldV, newV) => { sets.push(`${field}=?`); args.push(newV); logChange(db, cur, field, oldV, newV, why, sysUser); };

    // What we will remember as "what the source last told us". Kept even after
    // the row closes, because it is the figure that actually moved.
    let nextSrcAmount = src.planned, nextSrcDate = src.due_date;

    if (src.cancelled) {
      // Rejected payable -> the outflow is never happening.
      change('status', cur.status, 'cancelled');
      if (!numEq(cur.actual, 0)) change('actual', cur.actual, 0);
      report.cancelled++;
    } else if (!src.live) {
      // Settled: invoice fully collected (AR) or payment released (AP).
      change('status', cur.status, 'done');
      // AR closes at zero outstanding, so the money that landed is the LAST
      // outstanding we were forecasting. AP closes carrying its released
      // amount, which is truer than the pre-release figure.
      const landed = src.kind === 'AP'
        ? src.planned
        : (cur.source_amount != null ? +cur.source_amount : +cur.planned || 0);
      if (!numEq(cur.actual, landed)) change('actual', cur.actual, landed);
      nextSrcAmount = landed;
      nextSrcDate = cur.source_date || src.due_date;
      report.closed++;
    } else {
      // Still live. Move a field ONLY when the SOURCE itself moved — never
      // merely because the row differs from the source. That distinction is
      // what lets "Roll overdue" push an unpaid receipt to the next collection
      // day without the next sync yanking it back to the invoice date, while a
      // genuinely new promised date from Collections still comes through.
      const srcDateMoved = !cur.source_date || src.due_date !== cur.source_date;
      const srcAmtMoved = !numEq(cur.source_amount, src.planned);
      if (!cur.manual_date && srcDateMoved && src.due_date && src.due_date !== cur.due_date) {
        change('due_date', cur.due_date, src.due_date);
      }
      if (!cur.manual_planned && srcAmtMoved && !numEq(cur.planned, src.planned)) {
        change('planned', cur.planned, src.planned);
      }
      if (sets.length) report.updated++;
    }

    // Party / note follow the source silently — they are labels, not money.
    if (src.party && src.party !== cur.party) { sets.push('party=?'); args.push(src.party); }
    if ((src.note || '') !== (cur.note || '')) { sets.push('note=?'); args.push(src.note); }

    // Always record what the source says, even when a pin stopped us applying
    // it — that is how the page can show "Collections says X, you set Y".
    sets.push('source_amount=?'); args.push(nextSrcAmount);
    sets.push('source_date=?'); args.push(nextSrcDate);
    sets.push('synced_at=CURRENT_TIMESTAMP', 'updated_at=CURRENT_TIMESTAMP');
    db.prepare(`UPDATE arap_entries SET ${sets.join(', ')} WHERE id=?`).run(...args, cur.id);
  };

  const sources = [...arSources(db), ...apSources(db)];
  db.transaction(() => { for (const s of sources) apply(s); })();
  return report;
}

module.exports = { syncArap, toL };
