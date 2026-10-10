import { useState } from 'react';
import Modal from './Modal';

export function ScoreMetricSettings({ value, onChange }) {
  const automatic = value.data_source?.startsWith('auto:');
  const type = value.metric_type || 'number';
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
    <label>Measurement
      <select aria-label="Measurement" className="select mt-1 text-xs" value={type} onChange={e => onChange({
        metric_type: e.target.value,
        ...(e.target.value !== 'hours' && value.actual_mode === 'dates' ? { actual_mode: 'manual' } : {}),
        ...(e.target.value === 'hours' ? { direction: 'lower_better' } : {}),
      })}>
        <option value="number">Number / count</option><option value="amount">Amount</option><option value="hours">Time in hours</option>
      </select>
    </label>
    <label>Plan entry
      <select aria-label="Plan entry" className="select mt-1 text-xs" value={value.planned_mode || 'source'} onChange={e => onChange({ planned_mode: e.target.value })}>
        <option value="source" disabled={value.actual_mode === 'dates'}>{automatic ? 'From source / template target' : 'Template target'}</option>
        <option value="manual">Enter manually each week</option>
      </select>
    </label>
    <label>Actual entry
      <select aria-label="Actual entry" className="select mt-1 text-xs" value={!automatic && value.actual_mode !== 'dates' ? 'manual' : value.actual_mode || 'source'} onChange={e => onChange({
        actual_mode: e.target.value,
        ...(e.target.value === 'dates' ? { metric_type: 'hours', planned_mode: 'manual', direction: 'lower_better' } : {}),
      })}>
        {automatic && <option value="source">Automatic from SOTYN</option>}
        <option value="manual">Manual value</option>
        <option value="dates">Manual date/time → hours</option>
      </select>
    </label>
    {type === 'hours' && value.actual_mode === 'dates' && <label>Timing method
      <select aria-label="Timing method" className="select mt-1 text-xs" value={value.time_basis || 'elapsed'} onChange={e => onChange({ time_basis: e.target.value })}>
        <option value="elapsed">Start → response (elapsed hours)</option>
        <option value="delay">Planned → actual (late hours)</option>
      </select>
    </label>}
    <p className="sm:col-span-2 text-gray-500 leading-relaxed">
      {value.actual_mode === 'dates' ? 'Enter both date/times manually: the start or planned time, and the actual response time. SOTYN calculates Actual hours. Plan is the allowed hours; late hours are 0 for an early or on-time response.'
        : type === 'amount' ? 'Plan and Actual are amounts. You can also record their dates in the weekly scorecard.'
          : 'Choose Plan and Actual independently. Manual entry keeps the source available for switching back to automatic.'}
    </p>
  </div>;
}

export function ScoreMetricDates({ kpi, readOnly, onSave }) {
  const [open, setOpen] = useState(false);
  const [plannedAt, setPlannedAt] = useState('');
  const [actualAt, setActualAt] = useState('');
  const [saving, setSaving] = useState(false);
  const timed = kpi.actual_mode === 'dates';
  const late = kpi.time_basis === 'delay';
  if (!timed && kpi.metric_type !== 'amount') return null;
  const show = () => {
    const normalize = value => !value ? '' : timed && value.length === 10 ? `${value}T00:00` : value;
    setPlannedAt(normalize(kpi.planned_at)); setActualAt(normalize(kpi.actual_at)); setOpen(true);
  };
  const start = plannedAt ? Date.parse(`${plannedAt.length === 10 ? plannedAt + 'T00:00' : plannedAt}:00+05:30`) : null;
  const end = actualAt ? Date.parse(`${actualAt.length === 10 ? actualAt + 'T00:00' : actualAt}:00+05:30`) : null;
  const hours = start != null && end != null ? Math.round((end - start) / 36000) / 100 : null;
  const invalid = timed && actualAt && (!plannedAt || (!late && hours < 0));
  return <>
    <button type="button" onClick={show} className="block mt-1 text-[11px] text-blue-700 hover:underline">
      {timed ? 'Start / actual time' : 'Plan / actual dates'}
    </button>
    <Modal isOpen={open} onClose={() => { if (!saving) setOpen(false); }} title={`${kpi.metric_name} · ${timed ? 'Date / time' : 'Dates'}`}>
      <form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); if (readOnly || invalid || saving) return;
        setSaving(true);
        try { if (await onSave({ planned_at: plannedAt || null, actual_at: actualAt || null })) setOpen(false); }
        finally { setSaving(false); }
      }}>
        <p className="text-sm text-gray-500">{timed ? 'Times are in India Standard Time (IST). Plan is the allowed hours; Actual is calculated from these dates.' : 'Dates are saved with this selected week’s planned and actual amounts.'}</p>
        <label className="block text-sm">{timed ? (late ? 'Planned response date / time' : 'Lead received / start date / time') : 'Planned amount due date'}
          <input className="input mt-1" type={timed ? 'datetime-local' : 'date'} value={timed ? plannedAt : plannedAt.slice(0, 10)} disabled={readOnly || saving} onChange={e => setPlannedAt(e.target.value)} />
        </label>
        <label className="block text-sm">{timed ? 'Actual response date / time' : 'Actual amount received / completed date'}
          <input className="input mt-1" type={timed ? 'datetime-local' : 'date'} value={timed ? actualAt : actualAt.slice(0, 10)} disabled={readOnly || saving} onChange={e => setActualAt(e.target.value)} />
        </label>
        {timed && <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{hours == null ? 'Pick both date/times to calculate Actual hours.' : `Actual: ${late ? Math.max(0, hours) : hours} ${late ? 'late ' : ''}hours`}</p>}
        {invalid && <p role="alert" className="text-sm text-red-700">Enter the start time first. The actual response cannot be earlier than the start.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setOpen(false)}>Close</button>
          {!readOnly && <button className="btn btn-primary" disabled={saving || invalid}>{saving ? 'Saving…' : 'Save dates'}</button>}
        </div>
      </form>
    </Modal>
  </>;
}
