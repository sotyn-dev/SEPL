import { useEffect, useState } from 'react';
import { FiAlertTriangle, FiArrowRight, FiClock, FiInfo, FiLock } from 'react-icons/fi';
import { ACTIONS, TURNOVER_REASONS, EXIT_STATUSES, SALARY_REASON_CODES, resolveAction } from '../constants/employeeChangeCodes';
import { fmtDate } from '../utils/datetime';
import api from '../api';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => { if (!m) return ''; const [y, mo] = m.split('-'); return `${MONTH_NAMES[Number(mo) - 1]} ${y}`; };

// Two separate things, in one fixed style (never a per-scenario colour switch —
// that was tried on this card and rejected, dme 2026-08-01):
//   · finalisedThrough — why earlier dates are greyed out. Quiet, informational.
//     A finalised month is frozen, so it simply isn't selectable.
//   · backdated — the real cost of a back-dated date, shown only once one is
//     actually picked. Payroll has no per-month salary: it reads the single live
//     figure whenever Finalise runs, so this amount lands on EVERY still-open
//     month, not just the one named. Derived from values already in hand (no
//     fetch), so unlike the check it replaced it cannot silently fail to appear.
const LockNote = ({ finalisedThrough, backdated, field }) => {
  if (!finalisedThrough && !backdated) return null;
  return (
    <div className={`flex items-start gap-1.5 text-[11px] rounded-lg ${backdated ? 'bg-amber-50 border border-amber-200 text-amber-800 px-2 py-1.5' : 'text-gray-500'}`}>
      <FiAlertTriangle size={12} className={`mt-0.5 shrink-0 ${backdated ? '' : 'text-amber-500'}`} />
      <span>
        {backdated
          ? <>This is a past month. Payroll uses one live {field} figure, so it will apply to <strong>every month not yet finalised</strong> — including the current one — until you change it back. Set it back after finalising that month.</>
          : <>Payroll is finalised through {monthLabel(finalisedThrough)} — a closed month is never recalculated, so earlier dates can't be picked.</>}
      </span>
    </div>
  );
};

// The Contextual Change Card — the editor's single reason-capture surface.
// Renders whenever a tracked field moved AND/OR a KYC doc was replaced. No
// modal, no popup: everything (what changed, the action, the reason, the
// effective date) lives inline in the Edit modal right after the field grid.
//
// One fixed header/color always (dme 2026-08-01: the old per-scenario
// red/amber/green/blue/slate + reworded title was a jarring permutation
// matrix — same box every time is calmer and just as informative via chips).
//
// Props:
//   changes      [{key,label,money,from,to}]  — the live diff (already computed)
//   statusTo     the new status value (for exit-reason gating)
//   meta         { action_code, reason_code, reason, effective_date,
//                  salary_effective_date, salary_action, salary_reason_code,
//                  status_effective_date }
//   setMeta      updater
//   canSeeSalary bool — masks the pay figure for non-holders
//   today        'YYYY-MM-DD' — caps the shared effective date (the isolated
//                salary/status dates are floored at the payroll-lock boundary
//                instead, and are allowed to be forward-dated)
//   users        [{id,name,username,email}] — resolves the Linked user chip from an id to a name
//   employees    [{id,name,designation}] — resolves the Reports To chip from an id to a name
//   employeeId   the employee being edited — drives the payroll-lock-info fetch below
//   docLabels    [string] — KYC docs replaced alongside this edit (display-only:
//                a doc swap isn't a tracked field, so it never drives the
//                action logic below — just shown so the one shared Reason is
//                visibly known to cover it too)
export default function EmployeeChangeCard({ changes, docLabels = [], statusTo, meta, setMeta, canSeeSalary, today, users = [], employees = [], employeeId }) {
  const changedKeys = changes.map((c) => c.key);
  const isExit = changedKeys.includes('status') && EXIT_STATUSES.includes(String(statusTo || '').toLowerCase());

  // Salary, status AND confirmation_status each get their own isolated block
  // (below) — all excluded from the shared Action's field count, so e.g. a
  // promotion (designation+salary) doesn't swallow salary's own revision/
  // correction distinction into "Multiple changes", and a status+salary edit
  // with nothing else doesn't need the shared Action block at all.
  const sharedActionKeys = changedKeys.filter((k) => k !== 'salary' && k !== 'status' && k !== 'confirmation_status');

  // The Action control: LOCKED to "Multiple changes" the moment >1 (shared)
  // tracked field has moved (server enforces this too — see resolveActionCode).
  // This is the fix for picking a single action then also editing roster and
  // forgetting to update the dropdown, which used to silently mislabel the
  // roster change. Only a true single-field edit gets an editable dropdown.
  const { locked, value: derivedAction } = resolveAction(sharedActionKeys);

  // Keep meta.action_code in sync with the derived value whenever the change
  // SHAPE moves between single-field and multi-field (or between which single
  // field), so a stale pick from a moment ago never lingers into a new shape.
  useEffect(() => {
    if (!sharedActionKeys.length) return;
    if (locked) {
      setMeta((m) => (m.action_code === derivedAction ? m : { ...m, action_code: derivedAction }));
    } else if (!meta.action_code) {
      setMeta((m) => ({ ...m, action_code: derivedAction }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedActionKeys.join('|'), locked, derivedAction]);

  // The employee's payroll-lock boundary — fetched ONCE per employee (not per
  // keystroke). Drives the `min` on both isolated date inputs below, so an
  // already-finalised month can't be picked. Replaces an earlier debounced
  // per-date warning that could silently fail to render if the request hiccuped.
  const [lock, setLock] = useState(null);
  useEffect(() => {
    if (!employeeId) { setLock(null); return; }
    api.get(`/hr/employees/${employeeId}/payroll-lock-info`)
      .then((r) => setLock(r.data)).catch(() => setLock(null));
  }, [employeeId]);
  // The floor: only a FINALISED month is barred (frozen figures, never
  // recalculated). undefined = nothing finalised, any date allowed — the normal
  // case in production. Back-dating into an open past month is permitted on
  // purpose; the caution below states what it costs. Server enforces the same
  // rule (minEffectiveDate in hr.js).
  const minEff = (lock && lock.min_effective_date) || undefined;
  // Normally today. Differs only when payroll is finalised through the current
  // month or later, pushing the floor past today.
  const defaultEff = minEff && today < minEff ? minEff : today;
  // Is a chosen date in a month earlier than the current one? Derived purely
  // from values already in hand — no fetch, so it cannot fail to appear.
  const currentMonth = today.slice(0, 7);
  const isBackdated = (d) => !!d && d.slice(0, 7) < currentMonth;
  // Mirror the shown value into meta so the payload matches the display, and lift
  // any date sitting below a newly-known floor up to it.
  useEffect(() => {
    const below = (d) => !d || (minEff && d < minEff);
    setMeta((m) => {
      const next = { ...m };
      let dirty = false;
      if (changedKeys.includes('salary') && below(m.salary_effective_date)) {
        next.salary_effective_date = defaultEff; dirty = true;
      }
      if (changedKeys.includes('status') && below(m.status_effective_date)) {
        next.status_effective_date = defaultEff; dirty = true;
      }
      return dirty ? next : m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minEff, defaultEff, changedKeys.includes('salary'), changedKeys.includes('status')]);

  if (!changes.length && !docLabels.length) return null;

  const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;
  const fmtChip = (c) => {
    if (c.money) return canSeeSalary
      ? { label: c.label, from: money(c.from), to: money(c.to) }
      : { label: 'Compensation change', from: '••', to: '••' };
    if (c.key === 'join_date') {
      const show = (x) => (x ? fmtDate(x) : '—');
      return { label: c.label, from: show(c.from), to: show(c.to) };
    }
    if (c.key === 'user_id') {
      const show = (x) => { const u = users.find((u) => u.id === x); return u ? u.name : '—'; };
      return { label: c.label, from: show(c.from), to: show(c.to) };
    }
    if (c.key === 'reports_to_employee_id') {
      const show = (x) => { const e = employees.find((e) => e.id === x); return e ? e.name : '—'; };
      return { label: c.label, from: show(c.from), to: show(c.to) };
    }
    if (c.key === 'probation_end_date') {
      const show = (x) => (x ? fmtDate(x) : '—');
      return { label: c.label, from: show(c.from), to: show(c.to) };
    }
    const show = (x) => (x == null || x === '' ? '—' : String(x));
    return { label: c.label, from: show(c.from), to: show(c.to) };
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3" role="region" aria-label="Change details">
      {/* Header — fixed, same every time (see file header note) */}
      <div className="flex items-start gap-2 font-semibold text-gray-700">
        <FiInfo className="mt-0.5 shrink-0" size={16} />
        <div>
          <div className="text-sm">Recording this change</div>
          {isExit && <div className="text-[11px] font-normal opacity-80">Their login will be disabled.</div>}
        </div>
      </div>

      {/* Change chips — names the exact fields being changed (the proximity) */}
      <div className="flex flex-wrap gap-2">
        {changes.map((c) => {
          const chip = fmtChip(c);
          return (
            <span key={c.key} className="inline-flex items-center gap-1.5 bg-white/70 border border-black/5 rounded-full px-2.5 py-1 text-[11px]">
              <span className="font-semibold text-gray-500 uppercase tracking-wide text-[9px]">{chip.label}</span>
              <span className="text-gray-500">{chip.from}</span>
              <FiArrowRight size={11} className="text-gray-400" />
              <span className="font-semibold text-gray-800">{chip.to}</span>
            </span>
          );
        })}
        {docLabels.map((label) => (
          <span key={label} className="inline-flex items-center gap-1.5 bg-white/70 border border-black/5 rounded-full px-2.5 py-1 text-[11px]">
            <span className="font-semibold text-gray-500 uppercase tracking-wide text-[9px]">{label}</span>
            <span className="font-semibold text-gray-800">Replaced</span>
          </span>
        ))}
      </div>

      {/* Salary — its own isolated date + Pay Revision/Correction classifier.
          Payroll is the only thing that reads employees.salary unconditionally
          (even for salary_exempt employees — they still get the full flat
          figure every month), so its timing gets absolute, always-visible
          treatment rather than sharing the generic Effective date below. */}
      {changedKeys.includes('salary') && (
        <div className="bg-white/70 border border-black/5 rounded p-2.5 space-y-2">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="w-full font-semibold text-sm">
              Salary Change
            </div>
            <div className="w-1/2">
              <label className="label flex items-center gap-1"><FiClock size={11} /> Effective from</label>
              <input
                className="input"
                type="date"
                min={minEff}
                value={meta.salary_effective_date || defaultEff}
                onChange={(e) => setMeta((m) => ({ ...m, salary_effective_date: e.target.value }))}
              />
            </div>
            <div className="w-[45%]">
              <label className="label">Reason</label>
              <select
                className="select"
                value={meta.salary_action === 'correction' ? 'correction' : (meta.salary_reason_code || '')}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) setMeta((m) => ({ ...m, salary_action: '', salary_reason_code: '' }));
                  else if (v === 'correction') setMeta((m) => ({ ...m, salary_action: 'correction', salary_reason_code: '' }));
                  else setMeta((m) => ({ ...m, salary_action: 'revision', salary_reason_code: v }));
                }}>
                <option value="">Select…</option>
                {SALARY_REASON_CODES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                <option value="correction">Correction</option>
              </select>
            </div>
          </div>
          <LockNote
            finalisedThrough={lock && lock.finalised_through}
            backdated={isBackdated(meta.salary_effective_date || defaultEff)}
            field="salary"
          />
        </div>
      )}

      {/* Status — its own isolated date. finalise() only ever selects
          status='active' employees, so this date decides which month an
          employee drops out of/into a payroll run. No action-type control
          here — unlike salary, status's action is already unambiguous. */}
      {changedKeys.includes('status') && (
        <div className="bg-white/70 border border-black/5 rounded-lg p-2.5 space-y-2">
          <div className="w-full font-semibold text-sm">
              Status Change
          </div>
          <div>
            <label className="label flex items-center gap-1"><FiClock size={11} /> Effective from</label>
            <input
              className="input"
              type="date"
              min={minEff}
              value={meta.status_effective_date || defaultEff}
              onChange={(e) => setMeta((m) => ({ ...m, status_effective_date: e.target.value }))}
            />
          </div>
          <LockNote
            finalisedThrough={lock && lock.finalised_through}
            backdated={isBackdated(meta.status_effective_date || defaultEff)}
            field="status"
          />
        </div>
      )}

      {/* Confirmation — its own isolated date, unlike salary/status NOT capped
          at today and NOT floored against the payroll lock (probation
          confirmations are routinely dated forward — "confirmed w.e.f. the
          1st" — and this doesn't drive payroll figures, so there's nothing
          to lock against). */}
      {changedKeys.includes('confirmation_status') && (
        <div className="bg-white/70 border border-black/5 rounded-lg p-2.5 space-y-2">
          <div className="w-full font-semibold text-sm">
              Confirmation Change
          </div>
          <div>
            <label className="label flex items-center gap-1"><FiClock size={11} /> Effective from</label>
            <input
              className="input"
              type="date"
              value={meta.confirmation_effective_date || today}
              onChange={(e) => setMeta((m) => ({ ...m, confirmation_effective_date: e.target.value }))}
            />
          </div>
        </div>
      )}

      {/* Inputs — Action · (Turnover reason) · Reason · Effective date. Action/
          Effective-date cover everything EXCEPT salary/status (their own
          blocks above) — only rendered when some other field changed too.
          A doc-only edit has no timeline row, so no action/effective concept either. */}
      <div className="grid grid-cols-2 gap-3">
        {sharedActionKeys.length > 0 && (
          <>
            <div>
              <label className="label">Action</label>
              {locked ? (
                <div className="input flex items-center gap-1.5 bg-gray-100 text-gray-600 cursor-not-allowed" title="Multiple fields changed — the action is recorded per field, not as one label">
                  <FiLock size={11} className="text-gray-400" /> {meta.action_code || derivedAction}
                </div>
              ) : (
                <select className="select" value={meta.action_code || ''} onChange={(e) => setMeta((m) => ({ ...m, action_code: e.target.value }))}>
                  {!meta.action_code && <option value="">Select…</option>}
                  {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="label flex items-center gap-1" title={changedKeys.includes('salary') || changedKeys.includes('status') ? 'Effective date for changes other than salary/status' : 'Effective date'}>
                <FiClock size={11} /> Effective date
              </label>
              <input
                className="input"
                type="date"
                max={today}
                value={meta.effective_date || today}
                onChange={(e) => setMeta((m) => ({ ...m, effective_date: e.target.value }))}
              />
              <p className="text-[10px] text-gray-500 mt-0.5">{(meta.effective_date || today) === today ? '(today)' : '(backdated)'}</p>
            </div>
          </>
        )}

        {isExit && (
          <div>
            <label className="label">Turnover reason</label>
            <select className="select" value={meta.reason_code || ''} onChange={(e) => setMeta((m) => ({ ...m, reason_code: e.target.value }))}>
              <option value="">Select…</option>
              {TURNOVER_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        )}

        <div className={'col-span-2'}>
          <label className="label">Reason <span className="text-red-500">*</span></label>
          <textarea
            className="input"
            rows={2}
            placeholder="Why is this change being made? (required — appears in the HR report)"
            value={meta.reason || ''}
            onChange={(e) => setMeta((m) => ({ ...m, reason: e.target.value }))}
          />
        </div>
      </div>
    </div>
  );
}
