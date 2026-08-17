// Tally Bill SLA escalation cron (spec §6 / acceptance criterion 5).
//
//   at  80% of the stage SLA → reminder to the stage OWNER
//   at 100%                  → escalate to the reporting manager
//   at 150%                  → escalate to the Director
//
// Runs every 15 minutes. That cadence matters: the Stage 4 approval SLA is only
// 4 business hours, so 80% of it is ~3h12m — an hourly tick would routinely
// deliver the "you're running out of time" reminder after the deadline passed.
//
// Dedup: tally_bill_escalations has UNIQUE(bill_id, stage_key, level), so a
// re-run — or a redeploy mid-day — can never double-send. Levels are also
// back-filled: a bill discovered already past 150% records 80 and 100 as sent
// rather than firing three mails at once for the same bill.
//
// Bills On Hold are skipped entirely — their clock is paused, so escalating
// would blame the owner for time the business deliberately stopped.
//
// Skip via ERP_DISABLE_TALLY_SLA_CRON=1.

const { getDb } = require('../db/schema');
const { istToday } = require('../lib/istDate');
const push = require('../lib/push');
const sla = require('../lib/tallySla');

const TICK_MS = 15 * 60 * 1000;
const LEVELS = [80, 100, 150];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function ownerIdFor(db, ownerKey, bill) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(`tally_owner_${ownerKey}`);
    if (row?.value) return Number(row.value);
  } catch (e) { /* fall through */ }
  return bill.created_by || null;
}

// Who hears about a breach at each level.
//   80  → the stage owner
//   100 → the owner's reporting manager (users.manager_id — the org edge
//         maintained in Admin → Users), else the configured manager seat,
//         else the Director
//   150 → the Director / admins
function recipientsFor(db, level, ownerId, bill) {
  if (level === 80) return [ownerId];

  const directorId = ownerIdFor(db, 'director', bill);
  if (level === 100) {
    let managerId = null;
    try { managerId = ownerId ? (db.prepare('SELECT manager_id FROM users WHERE id=?').get(ownerId)?.manager_id || null) : null; }
    catch (e) { managerId = null; }
    if (!managerId) {
      // Configured seat fallback. ownerIdFor would fall back to created_by
      // when unset, which for the manager seat means escalating to the
      // uploader — so only honour a real configured value here.
      try { managerId = Number(db.prepare("SELECT value FROM app_settings WHERE key='tally_owner_manager'").get()?.value) || null; }
      catch (e) { managerId = null; }
    }
    return [managerId || directorId, ownerId].filter(Boolean);
  }

  // 150% — Director plus every admin, so it cannot be sat on.
  let admins = [];
  try {
    admins = db.prepare(
      "SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0").all().map(r => r.id);
  } catch (e) { admins = []; }
  return [directorId, ...admins, ownerId].filter(Boolean);
}

const LEVEL_WORD = { 80: 'due soon', 100: 'BREACHED', 150: 'CRITICALLY OVERDUE' };

function runOnce() {
  const db = getDb();
  let sent = 0, scanned = 0, skippedHold = 0;

  const bills = db.prepare(`
    SELECT * FROM tally_bills
     WHERE status NOT IN ('closed','rejected')`).all();
  if (!bills.length) return { scanned: 0, sent: 0 };

  const ctx = sla.makeCtx(db);
  const nowMs = Date.now();

  // Both tables grow forever; scope every scan to the OPEN bills fetched above
  // so a year of closed history doesn't get re-read every 15 minutes.
  const billIds = bills.map(b => b.id);
  const holdsBy = {};
  const seen = new Set();
  for (let i = 0; i < billIds.length; i += 400) {
    const chunk = billIds.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const h of db.prepare(
      `SELECT bill_id, from_at, to_at FROM tally_bill_holds WHERE bill_id IN (${ph})`).all(...chunk)) {
      (holdsBy[h.bill_id] = holdsBy[h.bill_id] || []).push(h);
    }
    for (const r of db.prepare(
      `SELECT bill_id, stage_key, level FROM tally_bill_escalations WHERE bill_id IN (${ph})`).all(...chunk)) {
      seen.add(`${r.bill_id}|${r.stage_key}|${r.level}`);
    }
  }

  const record = db.prepare(`
    INSERT OR IGNORE INTO tally_bill_escalations (bill_id, stage_key, level, notified_user_id, channel)
    VALUES (?,?,?,?,?)`);
  const insNotif = db.prepare(`
    INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
    VALUES (?,?,?,?,?,'in_app',?)`);

  for (const bill of bills) {
    scanned++;
    if (bill.status === 'on_hold') { skippedHold++; continue; }

    const stageKey = sla.currentStageKey(bill);
    if (!stageKey) continue;

    const stage = sla.computeStage(stageKey, bill, holdsBy[bill.id] || [], ctx, nowMs);
    if (!stage || stage.completed_at) continue;

    const ownerId = ownerIdFor(db, stage.owner_key, bill);

    // Everything crossed but not yet ledgered. Only the HIGHEST level actually
    // notifies — lower ones are back-filled silently, so a bill discovered at
    // 160% sends one Director escalation, not three stacked mails.
    const due = LEVELS.filter(l => stage.pct >= l && !seen.has(`${bill.id}|${stageKey}|${l}`));
    if (!due.length) continue;
    const notifyLevel = due[due.length - 1];

    for (const level of due) {
      seen.add(`${bill.id}|${stageKey}|${level}`);

      const recipients = level === notifyLevel
        ? [...new Set(recipientsFor(db, level, ownerId, bill))].filter(Boolean)
        : [];
      // Always ledger the breach even with no one to tell — otherwise a bill
      // with no configured owner would re-fire this branch every 15 minutes.
      record.run(bill.id, stageKey, level, recipients[0] || null, recipients.length ? 'in_app,push' : 'none');
      if (!recipients.length) continue;

      const title = `${bill.register_no} — ${stage.label} ${LEVEL_WORD[level]} (${stage.pct}% of SLA)`;
      const body = `${bill.vendor_name} · Rs ${num(bill.bill_amount).toLocaleString('en-IN')}`
        + ` · due ${stage.due_at || '—'} UTC`
        + (stage.delay > 0 ? ` · late by ${stage.delay} ${stage.unit}` : '');
      const link = `/tally-bills?bill=${bill.id}`;

      for (const uid of recipients) {
        try { insNotif.run(uid, 'tally_bill_sla', title, body, link, `tally-esc-${bill.id}-${stageKey}-${level}`); }
        catch (e) { /* one bad recipient must not stop the sweep */ }
      }
      try { push.notifyMany(recipients, { title, body, url: link }); } catch (e) { /* non-fatal */ }

      // Email goes through the configurable trigger engine so mam can retarget
      // recipients in Admin → Email Triggers without a code change.
      try {
        require('../lib/emailRules').fireEmailEvent('tally_bill.sla_breach', {
          register_no: bill.register_no,
          bill_no: bill.bill_number,
          vendor: bill.vendor_name,
          project: bill.project_name || '',
          amount: bill.bill_amount,
          stage: stage.label,
          level: String(level),
          pct: String(stage.pct),
          due_at: stage.due_at || '',
          delay: String(stage.delay),
          date: istToday(),
          owner_email: ownerId ? (db.prepare('SELECT email FROM users WHERE id=?').get(ownerId)?.email || null) : null,
          director_email: (() => {
            const d = ownerIdFor(db, 'director', bill);
            return d ? (db.prepare('SELECT email FROM users WHERE id=?').get(d)?.email || null) : null;
          })(),
        });
      } catch (e) { /* mail is best-effort */ }

      sent++;
    }
  }

  if (sent) console.log(`[tally-sla] scanned ${scanned}, escalations sent ${sent}, on-hold skipped ${skippedHold}`);
  return { scanned, sent, skippedHold };
}

function scheduleTallySlaCron() {
  if (process.env.ERP_DISABLE_TALLY_SLA_CRON === '1') {
    console.log('[tally-sla] disabled via ERP_DISABLE_TALLY_SLA_CRON');
    return;
  }
  // Boot catch-up after 90 s (lets the DB finish migrations first), then every
  // 15 min. Dedup makes both safe to repeat.
  setTimeout(() => {
    try { runOnce(); } catch (e) { console.error('[tally-sla] boot run failed:', e.message); }
  }, 90 * 1000);
  setInterval(() => {
    try { runOnce(); } catch (e) { console.error('[tally-sla] tick failed:', e.message); }
  }, TICK_MS);
  console.log('[tally-sla] escalation cron scheduled (every 15 min)');
}

module.exports = { scheduleTallySlaCron, runOnce };
