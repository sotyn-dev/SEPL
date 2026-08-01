import { useEffect } from 'react';
import { FiArrowRight, FiClock, FiInfo, FiLock } from 'react-icons/fi';
import { ACTIONS, TURNOVER_REASONS, EXIT_STATUSES, resolveAction } from '../constants/employeeChangeCodes';
import { fmtDate } from '../utils/datetime';

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
//   meta         { action_code, reason_code, reason, effective_date }
//   setMeta      updater
//   canSeeSalary bool — masks the pay figure for non-holders
//   today        'YYYY-MM-DD' — caps the effective date
//   users        [{id,name,username,email}] — resolves the Linked user chip from an id to a name
//   docLabels    [string] — KYC docs replaced alongside this edit (display-only:
//                a doc swap isn't a tracked field, so it never drives the
//                action logic below — just shown so the one shared Reason is
//                visibly known to cover it too)
export default function EmployeeChangeCard({ changes, docLabels = [], statusTo, meta, setMeta, canSeeSalary, today, users = [] }) {
  const changedKeys = changes.map((c) => c.key);
  const isExit = changedKeys.includes('status') && EXIT_STATUSES.includes(String(statusTo || '').toLowerCase());

  // The Action control: LOCKED to "Multiple changes" the moment >1 tracked field
  // has moved (server enforces this too — see resolveActionCode). This is the
  // fix for picking "Status Change" then also editing roster and forgetting to
  // update the dropdown, which used to silently mislabel the roster change.
  // Only a true single-field edit gets an editable dropdown. A doc-only edit
  // (no tracked field) has no action concept — the whole Action/Effective-date
  // row is skipped for it below.
  const { locked, value: derivedAction } = resolveAction(changedKeys);

  // Keep meta.action_code in sync with the derived value whenever the change
  // SHAPE moves between single-field and multi-field (or between which single
  // field), so a stale pick from a moment ago never lingers into a new shape.
  useEffect(() => {
    if (!changes.length) return;
    if (locked) {
      setMeta((m) => (m.action_code === derivedAction ? m : { ...m, action_code: derivedAction }));
    } else if (!meta.action_code) {
      setMeta((m) => ({ ...m, action_code: derivedAction }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedKeys.join('|'), locked, derivedAction]);

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
    const show = (x) => (x == null || x === '' ? '—' : String(x));
    return { label: c.label, from: show(c.from), to: show(c.to) };
  };

  return (
    <div className="rounded-xl border border-l-4 border-blue-400 bg-blue-50 p-3 space-y-3" role="region" aria-label="Change details">
      {/* Header — fixed, same every time (see file header note) */}
      <div className="flex items-start gap-2 font-semibold text-blue-700">
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

      {/* Inputs — Action · (Turnover reason) · Reason · Effective date. Action/
          Effective-date only apply when a tracked field actually moved — a
          doc-only edit has no timeline row, so no action/effective concept. */}
      <div className="grid grid-cols-2 gap-3">
        {changes.length > 0 && (
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
              <label className="label flex items-center gap-1"><FiClock size={11} /> Effective date</label>
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
