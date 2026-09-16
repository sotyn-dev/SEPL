import { useState } from 'react';
import { FiPlus, FiSearch, FiPackage } from 'react-icons/fi';

export default function EmployeeAssets({ form, change, options, disabled, loading, error, retry }) {
  const [selecting, setSelecting] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const equipment = options.equipment || [];
  const vehicles = options.vehicles || [];
  const all = [...equipment, ...vehicles.map(a => ({ ...a, category: 'Vehicle' }))];
  const current = all.filter(a => form.user_id && Number(a.current_user_id) === Number(form.user_id) && a.status === 'issued');
  const equipmentIds = form.equipment_asset_ids ?? current.filter(a => a.category !== 'Vehicle').map(a => a.id);
  const vehicleIds = form.vehicle_asset_id === undefined ? current.filter(a => a.category === 'Vehicle').map(a => a.id) : form.vehicle_asset_id ? [form.vehicle_asset_id] : [];
  const ids = [...equipmentIds, ...vehicleIds];
  const assigned = all.filter(a => ids.includes(a.id));
  const eligible = all.filter(a => !ids.includes(a.id) && ((a.status === 'available' && (!a.current_user_id || Number(a.current_user_id) === Number(form.user_id))) || current.some(c => c.id === a.id)));
  const filtered = eligible.filter(a => (!category || (a.category || 'Other') === category) && `${a.asset_no} ${a.name} ${a.serial_no || ''} ${a.mobile_number || ''} ${a.carrier || ''}`.toLowerCase().includes(search.toLowerCase()));
  const assign = a => {
    if (a.category === 'Vehicle') change('vehicle_asset_id', a.id);
    else change('equipment_asset_ids', [...equipmentIds, a.id]);
  };
  const remove = a => {
    if (a.category === 'Vehicle') change('vehicle_asset_id', null);
    else change('equipment_asset_ids', equipmentIds.filter(id => id !== a.id));
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-600">{assigned.length} asset{assigned.length === 1 ? '' : 's'} assigned</p>
      {!disabled && <button type="button" className="btn btn-secondary inline-flex gap-2 items-center" disabled={!form.user_id || loading || !!error} onClick={() => setSelecting(!selecting)}><FiPlus />{selecting ? 'Close asset selector' : 'Assign asset'}</button>}
    </div>
    {!form.user_id && <p className="em-notice">Choose a Linked login user in Employment before assigning equipment.</p>}
    {error && <p className="em-error" role="alert">{error} <button type="button" className="underline" onClick={retry}>Retry</button></p>}
    {loading ? <p role="status" className="text-sm text-slate-500">Loading company assets…</p> : !assigned.length && <div className="em-empty"><FiPackage size={26} /><h4>No assets assigned</h4><p>Equipment is optional. Assign it when it is issued to the employee.</p></div>}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {assigned.map(a => <article key={a.id} className="em-asset">
        <div className="flex justify-between gap-2"><span className="em-eyebrow">{a.category || 'Other'}</span><span className="em-pill">{current.some(c => c.id === a.id) ? 'Assigned' : 'Pending save'}</span></div>
        <h4 className="mt-3 font-semibold text-slate-900">{a.name}</h4><p className="text-xs text-slate-500 mt-1">{a.asset_no}</p>
        <p className="text-xs text-slate-500 mt-1">{[a.serial_no, a.mobile_number, a.carrier].filter(Boolean).join(' · ')}</p>
        {!disabled && <button type="button" className="text-xs text-red-700 mt-4" onClick={() => remove(a)}>Return / remove</button>}
      </article>)}
    </div>
    {selecting && !disabled && <div className="em-asset-picker">
      <h4 className="font-semibold text-sm mb-3">Available company assets</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="em-label"><span className="inline-flex gap-1 items-center"><FiSearch /> Search assets</span><input className="input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, tag, serial or SIM number" /></label>
        <label className="em-label">Asset category<select className="select" value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{[...new Set(all.map(a => a.category || 'Other'))].sort().map(c => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="mt-3 max-h-64 overflow-y-auto">
        {!filtered.length && <p className="text-sm text-slate-500 p-3">No eligible assets match. Add or return equipment in Company Assets.</p>}
        {filtered.slice(0, 50).map(a => <div key={a.id} className="flex items-center gap-3 justify-between border-b border-slate-200 py-3"><div className="min-w-0"><p className="font-medium text-sm break-words">{a.name}</p><p className="text-xs text-slate-500">{a.category} · {a.asset_no}</p></div><button type="button" className="btn btn-secondary" aria-label={`Assign ${a.asset_no}`} onClick={() => assign(a)}>Assign</button></div>)}
        {filtered.length > 50 && <p className="text-xs text-slate-500 py-2">Showing 50 of {filtered.length}. Refine your search.</p>}
      </div>
    </div>}
    <p className="text-xs text-slate-500">Changes take effect when you save. Issue and return history is retained in Company Assets. Assigning another vehicle replaces the current vehicle.</p>
  </div>;
}
