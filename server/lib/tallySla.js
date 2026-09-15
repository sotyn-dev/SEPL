// Tally Bill SLA engine — the clock behind the bill lifecycle
// (Upload → Task Creation → Task Completion → Approval → Payment).
//
// Spec (Director change request, 2026-08-13 §6):
//   • Working days  = Mon–Sat, excluding company holidays.
//   • Business hrs  = 09:30–18:30 IST.  The clock PAUSES outside them.
//   • The clock also pauses while a bill is On Hold; hold time is logged
//     separately and pushes the due time out by exactly as much.
//   • Every stage stores Start / Due / Actual / Delay / On-Time.
//   • Escalation fires at 80% / 100% / 150% of the stage SLA.
//
// ── Why this file does its own date math ─────────────────────────────
// lib/businessHours.js already exists, but it (a) hardcodes 09:00–17:00,
// (b) uses local-time getters, and (c) doesn't know about holidays.  The
// VPS stores timestamps in UTC (see utils/datetime.js), so local-time
// getters would silently compute the wrong window there.  Rather than
// change businessHours.js — Rental Tools depends on its exact behaviour —
// this engine works in explicit IST civil time via a fixed +05:30 offset
// (India has no DST, so the offset is exact).
//
// EVERYTHING is measured in BUSINESS MINUTES so one uniform engine can
// answer "80% of SLA?" for both a 4-hour SLA and a 2-working-day SLA:
//   1 working day = the length of the business window = 540 min (9h).
// Stage 5 is the exception — the spec calls for 7 CALENDAR days — so it
// is measured on wall-clock and flagged `calendar: true`.

const { getDb } = require('../db/schema');

const IST_OFFSET_MIN = 330;          // +05:30, no DST
const MS_MIN = 60000;
const MS_DAY = 86400000;
const SUNDAY = 0;
const SATURDAY = 6;

// Runaway guard for the day-walking loops.  A bill sitting open for ~5
// years is a data problem, not a reason to spin the event loop.
const MAX_DAYS_WALK = 2000;

// ─── Settings ────────────────────────────────────────────────────────
// Every §11 "open decision" lands here as an admin-editable value with
// the spec's own stated default, so none of them blocks the build.
const DEFAULTS = {
  stage2_days: 2,               // §11.1 — 2 working days from T0, regardless of task count
  stage3_days: 2,               // §11.2 — 2 working days for ALL tasks combined
  stage4_hours: 4,              // §4    — 4 business hours
  payment_days: 7,              // §11.4 — 7 days from T3
  payment_basis: 'calendar',    // §11.4 — 'calendar' | 'working'
  work_start: '09:30',          // §6
  work_end: '18:30',            // §6
  saturday_working: 1,          // §11.5 — Mon–Sat per §6
  second_approval_threshold: 0, // §11.3 — ₹ over bill amount that may be approved
                                //          without Director sign-off (0 = any excess escalates)
};

const SETTING_KEYS = Object.keys(DEFAULTS).map(k => `tally_${k}`);

function parseHhMm(s, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return fallbackMin;
  const min = (+m[1]) * 60 + (+m[2]);
  return min >= 0 && min <= 24 * 60 ? min : fallbackMin;
}

function getConfig(db = getDb()) {
  const cfg = { ...DEFAULTS };
  try {
    const ph = SETTING_KEYS.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT key, value FROM app_settings WHERE key IN (${ph})`).all(...SETTING_KEYS)) {
      const k = r.key.replace(/^tally_/, '');
      if (!(k in cfg)) continue;
      cfg[k] = typeof DEFAULTS[k] === 'number' ? Number(r.value) : r.value;
    }
  } catch (e) { /* settings table missing on a very old DB — defaults stand */ }
  // Coerce anything a bad write could have left non-numeric.
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'number' && !Number.isFinite(cfg[k])) cfg[k] = DEFAULTS[k];
  }
  if (cfg.payment_basis !== 'working') cfg.payment_basis = 'calendar';
  return cfg;
}

function saveConfig(db, patch) {
  const up = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  );
  const written = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    up.run(`tally_${k}`, String(patch[k]));
    written[k] = patch[k];
  }
  return written;
}

// ─── IST civil-time helpers ──────────────────────────────────────────
// An "IST day index" is the number of whole days since 1970-01-01 IST.
// 1970-01-01 was a Thursday (getUTCDay 4), hence the +4 in dow().
const istDayIndex = (ms) => Math.floor((ms + IST_OFFSET_MIN * MS_MIN) / MS_DAY);
const dayStartMs  = (dayIdx) => dayIdx * MS_DAY - IST_OFFSET_MIN * MS_MIN;  // UTC ms of IST midnight
const dowOf       = (dayIdx) => (((dayIdx + 4) % 7) + 7) % 7;
const dayIsoOf    = (dayIdx) => new Date(dayIdx * MS_DAY).toISOString().slice(0, 10);

// Parse a SQLite timestamp as UTC.  CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS'
// with no zone marker; without the Z, Date.parse reads it as LOCAL time and the
// whole SLA silently shifts by the host offset.  Same helper the RACI board uses.
function tsMs(s) {
  if (s == null) return null;
  if (s instanceof Date) return s.getTime();
  if (typeof s === 'number') return s;
  let str = String(s).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T') + 'Z';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str = str + 'T00:00:00Z';
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

// Write back in the same 'YYYY-MM-DD HH:MM:SS' UTC shape the rest of the DB uses,
// so a stored due-time sorts and compares against CURRENT_TIMESTAMP columns.
const toSqlUtc = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace('T', ' '));

// ─── Holiday master ──────────────────────────────────────────────────
// Reuses procurement_holidays (seeded with 2026 Indian public holidays and
// already admin-editable) instead of standing up a second company calendar —
// one holiday master, two consumers.
function loadHolidays(db) {
  try {
    return new Set(db.prepare('SELECT holiday_date FROM procurement_holidays').all().map(r => r.holiday_date));
  } catch (e) {
    return new Set();   // table not created yet (route not loaded) — treat as no holidays
  }
}

// ─── Working-time context ────────────────────────────────────────────
// Build once per request/cron tick and thread through, so a list of 500
// bills does one holiday query instead of 500.
//
// Holidays are stored as INTEGER IST day-indexes, not ISO strings: the
// day-walking loops below call isWorkingDay once per day of a stage's
// elapsed window, for every bill on a register page — with string dates
// each call would allocate a Date + ISO string (hang-audit finding #16).
// As integers the check is pure arithmetic + one Set lookup.
function makeCtx(db = getDb(), cfg = null) {
  const c = cfg || getConfig(db);
  const startMin = parseHhMm(c.work_start, 570);
  const endMin = parseHhMm(c.work_end, 1110);
  const holidayIdx = new Set();
  for (const iso of loadHolidays(db)) {
    const t = Date.parse(iso + 'T00:00:00Z');           // holiday_date is a civil IST date
    if (!Number.isNaN(t)) holidayIdx.add(Math.floor(t / MS_DAY));
  }
  return {
    cfg: c,
    holidayIdx,
    startMin,
    endMin,
    perDay: Math.max(1, endMin - startMin),   // business minutes in one working day
    saturdayWorking: !!Number(c.saturday_working),
  };
}

function isWorkingDay(dayIdx, ctx) {
  const dow = dowOf(dayIdx);
  if (dow === SUNDAY) return false;
  if (dow === SATURDAY && !ctx.saturdayWorking) return false;
  return !ctx.holidayIdx.has(dayIdx);
}

// Business minutes actually elapsed between two instants.
function businessMinutesBetween(startMs, endMs, ctx) {
  if (startMs == null || endMs == null || endMs <= startMs) return 0;
  let total = 0;
  const firstDay = istDayIndex(startMs);
  const lastDay = istDayIndex(endMs);
  const stopDay = Math.min(lastDay, firstDay + MAX_DAYS_WALK);
  for (let d = firstDay; d <= stopDay; d++) {
    if (!isWorkingDay(d, ctx)) continue;
    const base = dayStartMs(d);
    const winOpen = base + ctx.startMin * MS_MIN;
    const winClose = base + ctx.endMin * MS_MIN;
    const from = Math.max(winOpen, startMs);
    const to = Math.min(winClose, endMs);
    if (to > from) total += (to - from) / MS_MIN;
  }
  return total;
}

// Roll an instant forward to the next moment inside the business window.
// Already inside → unchanged.
function clampToBusiness(ms, ctx) {
  let d = istDayIndex(ms);
  for (let i = 0; i <= MAX_DAYS_WALK; i++, d++) {
    if (!isWorkingDay(d, ctx)) continue;
    const base = dayStartMs(d);
    const winOpen = base + ctx.startMin * MS_MIN;
    const winClose = base + ctx.endMin * MS_MIN;
    if (ms <= winOpen) return winOpen;      // before opening (or a skipped day) → this day's open
    if (ms < winClose) return ms;           // already inside the window
    // after close → fall through to the next working day
  }
  return ms;
}

// Add N business minutes to an instant, skipping nights, Sundays and holidays.
function addBusinessMinutes(startMs, minutes, ctx) {
  let cur = clampToBusiness(startMs, ctx);
  let left = Math.max(0, minutes);
  if (left === 0) return cur;
  let d = istDayIndex(cur);
  for (let i = 0; i <= MAX_DAYS_WALK; i++, d++) {
    if (!isWorkingDay(d, ctx)) continue;
    const base = dayStartMs(d);
    const winOpen = base + ctx.startMin * MS_MIN;
    const winClose = base + ctx.endMin * MS_MIN;
    const from = Math.max(winOpen, cur);
    const avail = (winClose - from) / MS_MIN;
    if (avail <= 0) continue;
    if (left <= avail) return from + left * MS_MIN;
    left -= avail;
    cur = winClose;
  }
  return cur;
}

// Add N calendar or working days to an instant (Stage 5 / payment-expected date).
function addDaysByBasis(startMs, days, ctx) {
  if (ctx.cfg.payment_basis === 'working') {
    let d = istDayIndex(startMs), added = 0;
    for (let i = 0; i < MAX_DAYS_WALK && added < days; i++) {
      d++;
      if (isWorkingDay(d, ctx)) added++;
    }
    // keep the same clock time on the target day
    const timeOfDay = startMs - dayStartMs(istDayIndex(startMs));
    return dayStartMs(d) + timeOfDay;
  }
  return startMs + days * MS_DAY;
}

// ─── Hold handling ───────────────────────────────────────────────────
// `holds` = [{ from_at, to_at }]; an open hold (to_at null) runs to `now`.
// Business minutes the bill spent on hold inside [a, b].
function heldBusinessMinutes(holds, a, b, ctx, nowMs) {
  if (!holds || !holds.length || a == null || b == null) return 0;
  let total = 0;
  for (const h of holds) {
    const from = tsMs(h.from_at);
    const to = tsMs(h.to_at) ?? nowMs;
    if (from == null) continue;
    const lo = Math.max(from, a);
    const hi = Math.min(to, b);
    if (hi > lo) total += businessMinutesBetween(lo, hi, ctx);
  }
  return total;
}

// Same, on wall-clock ms — used by the calendar-based Stage 5.
function heldCalendarMs(holds, a, b, nowMs) {
  if (!holds || !holds.length || a == null || b == null) return 0;
  let total = 0;
  for (const h of holds) {
    const from = tsMs(h.from_at);
    const to = tsMs(h.to_at) ?? nowMs;
    if (from == null) continue;
    const lo = Math.max(from, a);
    const hi = Math.min(to, b);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

// ─── Stage model ─────────────────────────────────────────────────────
// One row per stage: who owns it, when its clock starts, and how long it gets.
// `owner` is a stage KEY, not a person — routes/tallyBills.js resolves it to a
// configured user so nothing here is hardcoded to a name (spec §2).
const STAGES = [
  { key: 'task_creation',   n: 2, label: 'PMS Task Creation',   owner: 'coordinator',   startField: 't0_uploaded_at',       doneField: 't1_tasks_created_at',   dueField: 't1_due_at' },
  { key: 'task_completion', n: 3, label: 'PMS Task Completion', owner: 'executor',      startField: 't1_tasks_created_at',  doneField: 't2_tasks_completed_at', dueField: 't2_due_at' },
  { key: 'approval',        n: 4, label: 'Approval + Release',  owner: 'coordinator',   startField: 't2_tasks_completed_at', doneField: 't3_approved_at',       dueField: 't3_due_at' },
  { key: 'payment',         n: 5, label: 'Payment Received',    owner: 'site_engineer', startField: 't3_approved_at',       doneField: 't4_closed_at',          dueField: 't4_due_at' },
];

const STAGE_BY_KEY = Object.fromEntries(STAGES.map(s => [s.key, s]));

// SLA budget for a stage, in business minutes (or calendar ms for Stage 5).
function slaFor(stageKey, ctx) {
  const c = ctx.cfg;
  switch (stageKey) {
    case 'task_creation':   return { minutes: c.stage2_days * ctx.perDay, calendar: false };
    case 'task_completion': return { minutes: c.stage3_days * ctx.perDay, calendar: false };
    case 'approval':        return { minutes: c.stage4_hours * 60,        calendar: false };
    case 'payment':         return { days: c.payment_days, calendar: ctx.cfg.payment_basis === 'calendar' };
    default:                return { minutes: 0, calendar: false };
  }
}

// Green / Amber / Red per §7.  Amber starts at the 80% reminder point so the
// grid colour and the escalation email agree on what "getting late" means.
function ragFor(pct, done, onTime) {
  if (done) return onTime ? 'green' : 'red';
  if (pct >= 100) return 'red';
  if (pct >= 80) return 'amber';
  return 'green';
}

// Compute one stage's full clock. Returns null when the stage hasn't started.
function computeStage(stageKey, bill, holds, ctx, nowMs = Date.now()) {
  const st = STAGE_BY_KEY[stageKey];
  if (!st) return null;
  const start = tsMs(bill[st.startField]);
  if (start == null) return null;                       // stage not reached yet

  const done = tsMs(bill[st.doneField]);
  const end = done ?? nowMs;
  const sla = slaFor(stageKey, ctx);

  let elapsed, budget, dueMs, unit;
  if (sla.calendar) {
    // Stage 5 on wall-clock days, minus any time parked on hold.
    unit = 'days';
    const held = heldCalendarMs(holds, start, end, nowMs);
    elapsed = Math.max(0, (end - start - held) / MS_DAY);
    budget = sla.days;
    dueMs = addDaysByBasis(start, sla.days, ctx) + heldCalendarMs(holds, start, nowMs, nowMs);
  } else {
    unit = 'hours';
    const held = heldBusinessMinutes(holds, start, end, ctx, nowMs);
    elapsed = Math.max(0, (businessMinutesBetween(start, end, ctx) - held) / 60);
    budget = sla.minutes / 60;
    // Due time is pushed out by exactly the business minutes spent on hold.
    dueMs = addBusinessMinutes(start, sla.minutes + heldBusinessMinutes(holds, start, nowMs, ctx, nowMs), ctx);
  }

  const pct = budget > 0 ? (elapsed / budget) * 100 : 0;
  const onTime = done != null ? elapsed <= budget : null;
  const delay = elapsed > budget ? elapsed - budget : 0;

  return {
    key: stageKey,
    stage_no: st.n,
    label: st.label,
    owner_key: st.owner,
    unit,
    start_at: toSqlUtc(start),
    due_at: toSqlUtc(dueMs),
    completed_at: done ? toSqlUtc(done) : null,
    elapsed: round2(elapsed),
    budget: round2(budget),
    // "Days Elapsed" for the grid — business days for stages 2-4, calendar for 5.
    elapsed_days: round2(unit === 'days' ? elapsed : elapsed / (ctx.perDay / 60)),
    budget_days: round2(unit === 'days' ? budget : budget / (ctx.perDay / 60)),
    delay: round2(delay),
    pct: Math.round(pct),
    on_time: onTime,
    overdue: !done && pct >= 100,
    rag: ragFor(pct, done != null, onTime),
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Which stage is the bill sitting in right now?  Terminal states have none.
function currentStageKey(bill) {
  if (bill.status === 'closed' || bill.status === 'rejected') return null;
  if (!bill.t1_tasks_created_at) return 'task_creation';
  if (!bill.t2_tasks_completed_at) return 'task_completion';
  if (!bill.t3_approved_at) return 'approval';
  return 'payment';
}

// Full SLA picture for one bill: every started stage + a rolled-up "where is it
// now" block the Bill Register renders directly.
function billSla(bill, holds, ctx, nowMs = Date.now()) {
  const stages = {};
  for (const s of STAGES) {
    const c = computeStage(s.key, bill, holds, ctx, nowMs);
    if (c) stages[s.key] = c;
  }
  const curKey = currentStageKey(bill);
  const cur = curKey ? stages[curKey] : null;
  const onHold = bill.status === 'on_hold';

  const t0 = tsMs(bill.t0_uploaded_at);
  const closed = tsMs(bill.t4_closed_at);
  const totalDays = t0 == null ? 0 : ((closed ?? nowMs) - t0) / MS_DAY;

  // Hold time is reported separately (§6) rather than folded into any stage figure.
  const holdMinutes = heldBusinessMinutes(holds, t0, closed ?? nowMs, ctx, nowMs);

  return {
    stages,
    current_stage: curKey,
    current_stage_label: cur ? cur.label : (bill.status === 'closed' ? 'Closed' : bill.status === 'rejected' ? 'Rejected' : '—'),
    current_owner_key: cur ? cur.owner_key : null,
    days_in_stage: cur ? cur.elapsed_days : 0,
    due_at: cur ? cur.due_at : null,
    // A held bill shows its own colour — the clock is stopped, so amber/red
    // would wrongly read as "someone is sitting on it".
    rag: onHold ? 'hold' : (cur ? cur.rag : (bill.status === 'closed' ? 'green' : 'grey')),
    pct: cur ? cur.pct : 0,
    overdue: onHold ? false : !!(cur && cur.overdue),
    total_days_since_upload: round2(totalDays),
    hold_hours: round2(holdMinutes / 60),
    on_hold: onHold,
  };
}

// Ageing bucket for the §7.2 report.
function ageingBucket(days) {
  if (days <= 3) return '0-3';
  if (days <= 7) return '4-7';
  if (days <= 15) return '8-15';
  return '15+';
}

module.exports = {
  DEFAULTS, STAGES, STAGE_BY_KEY,
  getConfig, saveConfig, makeCtx,
  tsMs, toSqlUtc, istDayIndex, dayIsoOf, isWorkingDay,
  businessMinutesBetween, addBusinessMinutes, addDaysByBasis, clampToBusiness,
  heldBusinessMinutes, heldCalendarMs,
  computeStage, currentStageKey, billSla, slaFor, ageingBucket, ragFor,
};
