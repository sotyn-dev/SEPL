import { useEffect, useRef } from 'react';
import { FiArrowRight, FiAlertTriangle, FiClock, FiInfo } from 'react-icons/fi';
import { ACTIONS, TURNOVER_REASONS, EXIT_STATUSES, suggestAction } from '../constants/employeeChangeCodes';

// The Contextual Change Card — the editor's single reason-capture surface.
// Renders ONLY when a tracked field has moved. No modal, no popup: everything
// (what changed, how weighty, the action, the reason, the effective date) lives
// inline in the Edit modal right after the field grid.
//
// Props:
//   changes      [{key,label,money,from,to}]  — the live diff (already computed)
//   statusTo     the new status value (for exit-reason gating)
//   meta         { action_code, reason_code, reason, effective_date }
//   setMeta      updater
//   canSeeSalary bool — masks the pay figure for non-holders
//   today        'YYYY-MM-DD' — caps the effective date
export default function EmployeeChangeCard({ changes, statusTo, meta, setMeta, canSeeSalary, today }) {
  const reasonRef = useRef(null);
  const changedKeys = changes.map((c) => c.key);
  const isExit = changedKeys.includes('status') && EXIT_STATUSES.includes(String(statusTo || '').toLowerCase());

  // Auto-suggest the action the first time the diff appears / changes shape,
  // unless the user has already picked one.
  useEffect(() => {
    if (!meta.action_code && changes.length) {
      setMeta((m) => ({ ...m, action_code: suggestAction(changedKeys) }));
    }
    // move focus to the reason box when the card first appears
    if (changes.length && reasonRef.current && !meta.reason) reasonRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedKeys.join('|')]);

  if (!changes.length) return null;

  // ── Context-aware header, by dominant action (severity order) ───────────────
  const st = String(statusTo || '').toLowerCase();
  let tone, Icon, title, subtitle;
  if (changedKeys.includes('status') && st === 'terminated') {
    tone = 'red'; Icon = FiAlertTriangle; title = 'Terminating this employee';
    subtitle = 'Their login will be disabled.';
  } else if (changedKeys.includes('status') && st === 'inactive') {
    tone = 'amber'; Icon = FiAlertTriangle; title = 'Marking this employee inactive';
    subtitle = 'Their login will be disabled.';
  } else if (changedKeys.includes('status') && (st === 'active' || st === 'training')) {
    tone = 'green'; Icon = FiInfo; title = 'Reactivating this employee';
    subtitle = 'Their login will be re-enabled.';
  } else if (changedKeys.length === 1 && changedKeys[0] === 'salary') {
    tone = 'blue'; Icon = FiInfo; title = 'Revising compensation';
  } else if (changedKeys.every((k) => k === 'designation' || k === 'department')) {
    tone = 'blue'; Icon = FiInfo; title = 'Changing role / department';
  } else {
    tone = 'slate'; Icon = FiInfo; title = `Recording ${changes.length} change${changes.length > 1 ? 's' : ''}`;
  }

  const TONES = {
    red:   'border-red-400 bg-red-50',
    amber: 'border-amber-400 bg-amber-50',
    green: 'border-emerald-400 bg-emerald-50',
    blue:  'border-blue-400 bg-blue-50',
    slate: 'border-slate-300 bg-slate-50',
  };
  const HEAD = {
    red: 'text-red-700', amber: 'text-amber-800', green: 'text-emerald-700',
    blue: 'text-blue-700', slate: 'text-slate-700',
  };
  const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;
  const fmtChip = (c) => {
    if (c.money) return canSeeSalary
      ? { label: c.label, from: money(c.from), to: money(c.to) }
      : { label: 'Compensation change', from: '••', to: '••' };
    const show = (x) => (x == null || x === '' ? '—' : String(x));
    return { label: c.label, from: show(c.from), to: show(c.to) };
  };

  return (
    <div className={`col-span-2 rounded-lg border-l-4 p-3 space-y-3 ${TONES[tone]}`} role="region" aria-label="Change details">
      {/* Header */}
      <div className={`flex items-start gap-2 font-semibold ${HEAD[tone]}`}>
        <Icon className="mt-0.5 shrink-0" size={16} />
        <div>
          <div className="text-sm">{title}</div>
          {subtitle && <div className="text-[11px] font-normal opacity-80">{subtitle}</div>}
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
      </div>

      {/* Inputs — Action · (Turnover reason) · Reason · Effective date */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Action</label>
          <select className="select" value={meta.action_code || ''} onChange={(e) => setMeta((m) => ({ ...m, action_code: e.target.value }))}>
            {!meta.action_code && <option value="">Select…</option>}
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
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

        {isExit && (
          <div>
            <label className="label">Turnover reason</label>
            <select className="select" value={meta.reason_code || ''} onChange={(e) => setMeta((m) => ({ ...m, reason_code: e.target.value }))}>
              <option value="">Select…</option>
              {TURNOVER_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        )}

        <div className={isExit ? '' : 'col-span-2'}>
          <label className="label">Reason <span className="text-red-500">*</span></label>
          <textarea
            ref={reasonRef}
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
