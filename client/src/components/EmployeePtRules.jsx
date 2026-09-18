import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { STATES } from '../data/indiaLocations';

export default function EmployeePtRules() {
  const [rules, setRules] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api.get('/hr/professional-tax-rules').then(r => { setRules(r.data); setLoaded(true); })
      .catch(() => setError('Could not load professional tax slabs.'));
  };
  useEffect(load, []);
  const change = (i, key, value) => setRules(rows => rows.map((r, n) => n === i ? { ...r, [key]: value } : r));
  const save = async () => {
    setSaving(true);
    try { await api.put('/hr/professional-tax-rules', { rules }); toast.success('PT slabs saved'); }
    catch (e) { toast.error(e.response?.data?.error || 'Could not save PT slabs'); }
    finally { setSaving(false); }
  };
  return <section className="card p-4 space-y-3">
    <h4 className="font-semibold text-sm text-red-700">Employee Professional Tax Slabs</h4>
    <p className="text-xs text-gray-600">Configure approved slabs for the Employee form estimate. No rates are prefilled. These settings do not alter payroll net pay.</p>
    <p className="text-xs text-gray-500">Salary ranges include the minimum and exclude the maximum. Leave maximum blank for no upper limit. A specific calendar month overrides an all-month slab for that range. Effective months are inclusive.</p>
    {error && <p className="text-sm text-red-600" role="alert">{error} <button type="button" className="underline" onClick={load}>Retry</button></p>}
    {!loaded && !error && <p className="text-sm">Loading slabs…</p>}
    {loaded && <>
      {!rules.length && <p className="text-sm text-gray-500">No slabs configured.</p>}
      {rules.map((r, i) => <fieldset key={i} disabled={saving} className="border rounded-lg p-3">
        <legend className="text-xs px-1">Slab {i + 1}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="label">State<select className="select" value={r.state} onChange={e => change(i, 'state', e.target.value)}>
            <option value="">Select state</option>{STATES.map(s => <option key={s}>{s}</option>)}</select></label>
          {[['min_salary', 'Salary minimum (Rs)'], ['max_salary', 'Salary maximum (exclusive)'], ['amount', 'PT amount (Rs/month)']].map(([key, label]) => <label key={key} className="label">{label}
            <input type="number" min="0" step="0.01" className="input" value={r[key] ?? ''} onChange={e => change(i, key, e.target.value)} /></label>)}
          <label className="label">Calendar month<select className="select" value={r.month} onChange={e => change(i, 'month', Number(e.target.value))}>
            <option value={0}>All months</option>{Array.from({ length: 12 }, (_, n) => <option key={n} value={n + 1}>{new Date(2026, n, 1).toLocaleString('en', { month: 'long' })}</option>)}</select></label>
          <label className="label">Effective from<input type="month" className="input" value={r.effective_from} onChange={e => change(i, 'effective_from', e.target.value)} /></label>
          <label className="label">Effective through (optional)<input type="month" className="input" value={r.effective_to || ''} onChange={e => change(i, 'effective_to', e.target.value)} /></label>
          <button type="button" className="btn btn-secondary self-end" onClick={() => setRules(rows => rows.filter((_, n) => n !== i))}>Remove slab {i + 1}</button>
        </div>
      </fieldset>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={saving} className="btn btn-secondary" onClick={() => setRules(rows => [...rows, { state: '', min_salary: 0, max_salary: '', amount: '', month: 0, effective_from: new Date().toISOString().slice(0, 7), effective_to: '' }])}>Add PT slab</button>
        <button type="button" disabled={saving} className="btn btn-primary" onClick={save}>{saving ? 'Saving…' : 'Save PT slabs'}</button>
      </div>
    </>}
  </section>;
}
