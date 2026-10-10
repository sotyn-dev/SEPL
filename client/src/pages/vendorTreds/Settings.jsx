import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiPlus, FiTrash2 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../../api';
import { useAuth } from '../../context/AuthContext';
import { LoadState, RemoteSelect, Value } from '../../components/vendorTreds/Common';
import { useRemote } from '../../components/vendorTreds/hooks';
import { History } from '../../components/vendorTreds/Forms';
import { BASE, errorMessage, label, money } from '../../components/vendorTreds/model';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function targetText(key, value) {
  if (value == null || value === '') return 'Not configured';
  if (/_paise$/.test(key)) return money(value, true);
  const text = Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return /percent$/.test(key) ? `${text}%` : text;
}

function TargetTable({ targets = {} }) {
  return <div className="overflow-x-auto rounded-lg border"><table className="w-full text-xs"><thead className="bg-slate-50"><tr><th className="text-left p-2">KPI</th><th className="text-left p-2">Target</th><th className="text-left p-2 whitespace-nowrap">Weeks 1–2</th><th className="text-left p-2 whitespace-nowrap">Week 3 onward</th></tr></thead><tbody>{Object.entries(targets).map(([key, value]) => {
    const phased = typeof value === 'object' && value !== null;
    return <tr key={key} className="border-t"><td className="p-2">{label(key.replace(/_paise$/, ''))}</td><td className="p-2">{phased ? '—' : targetText(key, value)}</td><td className="p-2">{phased ? targetText(key, value.weeks_1_2) : '—'}</td><td className="p-2">{phased ? targetText(key, value.week_3_onward) : '—'}</td></tr>;
  })}</tbody></table>{!Object.keys(targets).length && <p className="p-3 text-xs text-slate-500">No targets configured.</p>}</div>;
}

function SettingsVersion({ version, ownerName }) {
  const reminders = version.reminders || version.reminder_config;
  return <details className="border rounded-lg p-3 text-sm"><summary className="cursor-pointer font-medium">Effective from <Value field={{ type: 'date' }} value={version.effective_from} /></summary><div className="space-y-4 mt-4">
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3"><div><dt className="text-xs text-slate-500">Program start</dt><dd className="mt-1">{version.program_start_date ? <Value field={{ type: 'date' }} value={version.program_start_date} /> : 'Not configured'}</dd></div><div><dt className="text-xs text-slate-500">Week starts on</dt><dd className="mt-1">{DAYS[version.week_start] || 'Not configured'}</dd></div><div><dt className="text-xs text-slate-500">Working days</dt><dd className="mt-1">{version.working_days?.length ? version.working_days.map(day => DAYS[day]).join(', ') : 'Not configured'}</dd></div></dl>
    <div><h5 className="text-xs font-semibold mb-2">Responsible owners</h5><p className="text-xs">{version.responsible_owner_ids?.length ? version.responsible_owner_ids.map(ownerName).join(', ') : 'None configured'}</p></div>
    <div><h5 className="text-xs font-semibold mb-2">Team targets</h5><TargetTable targets={version.targets} /></div>
    {Object.entries(version.owner_overrides || {}).map(([id, values]) => <div key={id}><h5 className="text-xs font-semibold mb-2">Targets for {ownerName(id)}</h5><TargetTable targets={values.targets || values} /></div>)}
    {reminders && <div><h5 className="text-xs font-semibold mb-2">Reminder rules</h5><dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">{Object.entries(reminders).map(([key, value]) => <div className="flex justify-between gap-3 border rounded p-2" key={key}><dt className="text-slate-500">{label(key)}</dt><dd><Value value={value} /></dd></div>)}</dl></div>}
  </div></details>;
}

function Targets({ values, template, onChange, disabled }) {
  const update = (key, phase, text) => {
    const amount = text === '' ? null : /_paise$/.test(key) ? Math.round(Number(text) * 100) : Number(text);
    onChange({ ...values, [key]: phase ? { ...(values[key] || {}), [phase]: amount } : amount });
  };
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{Object.entries(template || values || {}).map(([key, original]) => <div key={key} className="border rounded-xl p-3"><p className="text-sm font-medium text-slate-800">{label(key.replace(/_paise$/, ''))}{/_paise$/.test(key) ? ' (₹)' : /percent$/.test(key) ? ' (%)' : ''}</p><div className={typeof original === 'object' && original !== null ? 'grid grid-cols-2 gap-3 mt-2' : 'mt-2'}>{(typeof original === 'object' && original !== null ? ['weeks_1_2', 'week_3_onward'] : [null]).map(phase => {
    const value = phase ? values[key]?.[phase] : values[key];
    return <label key={phase || 'target'} className="block"><span className="text-xs text-slate-500">{phase === 'weeks_1_2' ? 'Weeks 1–2' : phase ? 'Week 3 onward' : 'Target'}</span><input type="number" min="0" step={/_paise$/.test(key) ? '0.01' : /percent$/.test(key) ? '0.01' : '1'} disabled={disabled} className="input mt-1" value={value == null ? '' : /_paise$/.test(key) ? (value / 100) : value} placeholder="Not applicable" onChange={event => update(key, phase, event.target.value)} /></label>;
  })}</div></div>)}</div>;
}

function SettingsEditor({ data, onSaved }) {
  const current = data.record || data.effective || data;
  const { canEdit, isAdmin } = useAuth();
  const editable = canEdit('vendor_treds_settings');
  const [ownerNames, setOwnerNames] = useState(() => Object.fromEntries((data.owner_names || []).map(owner => [owner.id, owner.name])));
  const ownerName = id => ownerNames[id] || `Employee #${id}`;
  const rememberOwner = row => { if (row) setOwnerNames(previous => ({ ...previous, [row.id]: row.name || row.label })); };
  const [form, setForm] = useState(() => ({ ...current, effective_from: current.as_of || '', targets: { ...(current.targets || {}) }, owner_overrides: { ...(current.owner_overrides || {}) }, responsible_owner_ids: [...(current.responsible_owner_ids || [])] }));
  const [owner, setOwner] = useState(null); const [overrideOwner, setOverrideOwner] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (key, value) => setForm(v => ({ ...v, [key]: value }));
  const save = async event => {
    event.preventDefault(); setBusy(true); setError('');
    const payload = Object.fromEntries(['effective_from', 'program_start_date', 'week_start', 'working_days', 'targets', 'owner_overrides', 'responsible_owner_ids', 'reminders', 'reminder_config'].filter(key => form[key] !== undefined).map(key => [key, form[key] === '' ? null : form[key]]));
    if (data.version != null || current.version != null) payload.version = data.version ?? current.version;
    try { await api.patch(`${BASE}/settings`, payload); toast.success('New effective settings version saved'); onSaved(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const reminderKey = form.reminder_config ? 'reminder_config' : form.reminders ? 'reminders' : null;
  return <form onSubmit={save} className="space-y-4">
    <div className="card p-4 space-y-4"><div className="flex flex-wrap justify-between items-center gap-2"><h3 className="font-semibold text-slate-800">Targets & Program Settings</h3>{isAdmin() && <Link to="/admin/roles" className="btn btn-secondary">Roles & Permissions</Link>}</div><p className="text-xs text-slate-500">Targets apply from their effective date. Actual KPI achievements come from transactions.</p>
      {error && <p role="alert" className="bg-red-50 border border-red-200 text-red-700 p-3 rounded text-sm">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"><label><span className="label">New version effective from *</span><input type="date" className="input" value={form.effective_from || ''} min={current.as_of || undefined} required disabled={!editable || busy} onChange={event => set('effective_from', event.target.value)} /></label><label><span className="label">Program start date</span><input type="date" className="input" value={form.program_start_date || ''} disabled={!editable || busy} onChange={event => set('program_start_date', event.target.value)} /></label><label><span className="label">Week starts on</span><select className="select" value={form.week_start ?? ''} disabled={!editable || busy} onChange={event => set('week_start', Number(event.target.value))}><option value="">Select…</option>{DAYS.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label></div>
      <fieldset><legend className="label">Working days</legend><div className="flex flex-wrap gap-4">{DAYS.map((day, index) => <label key={day} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={(form.working_days || []).includes(index)} disabled={!editable || busy} onChange={event => set('working_days', event.target.checked ? [...(form.working_days || []), index] : form.working_days.filter(value => value !== index))} />{day}</label>)}</div></fieldset>
      <Targets values={form.targets} onChange={targets => set('targets', targets)} disabled={!editable || busy} />
    </div>
    <div className="card p-4 space-y-3"><h4 className="font-semibold text-slate-800">Responsible Owners</h4><p className="text-xs text-slate-500">Choose the employees whose registration and funding targets apply.</p>{editable && <div className="flex flex-col sm:flex-row gap-2"><div className="flex-1"><RemoteSelect entity="users" label="Responsible owner" value={owner} onChange={setOwner} onSelected={rememberOwner} /></div><button type="button" disabled={!owner || busy} className="btn btn-secondary inline-flex items-center gap-1" onClick={() => { set('responsible_owner_ids', [...new Set([...form.responsible_owner_ids, Number(owner)])]); setOwner(null); }}><FiPlus />Add owner</button></div>}<div className="flex flex-wrap gap-2">{form.responsible_owner_ids.map(id => <span key={id} className="inline-flex gap-2 items-center text-xs border rounded-lg p-2">{ownerName(id)}{editable && <button type="button" aria-label={`Remove ${ownerName(id)}`} onClick={() => set('responsible_owner_ids', form.responsible_owner_ids.filter(value => value !== id))}><FiTrash2 /></button>}</span>)}</div></div>
    <div className="card p-4 space-y-4"><h4 className="font-semibold text-slate-800">Owner Target Overrides</h4>{editable && <div className="flex flex-col sm:flex-row gap-2"><div className="flex-1"><RemoteSelect entity="users" label="Owner override" value={overrideOwner} onChange={setOverrideOwner} onSelected={rememberOwner} /></div><button type="button" className="btn btn-secondary" disabled={!overrideOwner || busy} onClick={() => { set('owner_overrides', { ...form.owner_overrides, [overrideOwner]: form.owner_overrides[overrideOwner] || { ...form.targets } }); setOverrideOwner(null); }}>Add override</button></div>}{Object.entries(form.owner_overrides).map(([id, values]) => <details key={id} className="border rounded-xl p-3"><summary className="cursor-pointer text-sm font-medium">{ownerName(id)}</summary><div className="mt-3 space-y-3"><Targets values={values.targets || values} template={form.targets} disabled={!editable || busy} onChange={next => set('owner_overrides', { ...form.owner_overrides, [id]: next })} />{editable && <button type="button" className="text-xs text-red-700" onClick={() => { const next = { ...form.owner_overrides }; delete next[id]; set('owner_overrides', next); }}>Remove override and use team targets</button>}</div></details>)}</div>
    {reminderKey && <div className="card p-4"><h4 className="font-semibold text-slate-800 mb-3">Reminder Rules</h4><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{Object.entries(form[reminderKey]).map(([key, value]) => <label key={key}><span className="label">{label(key)}</span>{typeof value === 'boolean' ? <input type="checkbox" checked={value} disabled={!editable || busy} onChange={event => set(reminderKey, { ...form[reminderKey], [key]: event.target.checked })} /> : <input type="number" className="input" min="0" value={value ?? ''} disabled={!editable || busy} onChange={event => set(reminderKey, { ...form[reminderKey], [key]: event.target.value === '' ? null : Number(event.target.value) })} />}</label>)}</div></div>}
    {editable && <div className="flex justify-end"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save new effective version'}</button></div>}
    <div className="card p-4"><h4 className="font-semibold text-slate-800">Settings Versions</h4><div className="space-y-2 mt-3">{(data.versions || []).map((version, index) => <SettingsVersion key={version.effective_from || index} version={version} ownerName={ownerName} />)}</div>{data.history && <div className="mt-4"><History rows={data.history} /></div>}</div>
  </form>;
}

export default function Settings({ revision, onRefresh }) {
  const { data, loading, error } = useRemote(`${BASE}/settings`, {}, revision);
  return <><LoadState loading={loading} error={error} onRetry={onRefresh} />{data && !loading && !error && <SettingsEditor key={`${revision}-${data.version || ''}`} data={data} onSaved={onRefresh} />}</>;
}
