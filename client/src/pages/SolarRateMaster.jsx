import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiPlus, FiSave, FiTrash2 } from 'react-icons/fi';
import api from '../api';

// Column config per rate table (matches server RATE_TABLES whitelist).
const TABS = [
  { key: 'panels', label: 'Panels', cols: [
    { k: 'brand' }, { k: 'model' }, { k: 'technology' }, { k: 'wattage_wp', t: 'number', w: 90 },
    { k: 'cell_content', sel: ['Non-DCR', 'DCR'] }, { k: 'purchase_rate_per_wp', t: 'number', label: '₹/Wp', w: 90 },
    { k: 'gst', t: 'number', w: 70 }, { k: 'tier', t: 'number', w: 60 } ] },
  { key: 'inverters', label: 'Inverters', cols: [
    { k: 'brand' }, { k: 'model' }, { k: 'rated_kw', t: 'number', w: 90 }, { k: 'type' },
    { k: 'purchase_rate_per_w', t: 'number', label: '₹/W', w: 90 }, { k: 'gst', t: 'number', w: 70 } ] },
  { key: 'structure', label: 'Structure', cols: [
    { k: 'make_label' }, { k: 'material' }, { k: 'galvanization_micron', t: 'number', w: 90 },
    { k: 'purchase_rate_per_wp', t: 'number', label: '₹/Wp', w: 90 }, { k: 'gst', t: 'number', w: 70 } ] },
  { key: 'cables', label: 'Cables', cols: [
    { k: 'brand' }, { k: 'application', sel: ['DC String', 'AC LT'] }, { k: 'size_sqmm', t: 'number', w: 90 },
    { k: 'conductor' }, { k: 'purchase_rate_per_m', t: 'number', label: '₹/m', w: 90 }, { k: 'gst', t: 'number', w: 70 } ] },
  { key: 'bos', label: 'BOS', cols: [
    { k: 'category' }, { k: 'description' }, { k: 'brand' }, { k: 'unit', w: 70 },
    { k: 'purchase_rate', t: 'number', label: '₹/unit', w: 100 }, { k: 'gst', t: 'number', w: 70 } ] },
  { key: 'labour', label: 'Labour', cols: [
    { k: 'activity' }, { k: 'unit', w: 90 }, { k: 'rate', t: 'number', w: 100 }, { k: 'gst', t: 'number', w: 70 } ] },
];

function EditableTable({ tab }) {
  const [rows, setRows] = useState([]);
  const load = () => api.get(`/solar/${tab.key}`).then((r) => setRows(r.data || [])).catch(() => toast.error('Load failed'));
  useEffect(() => { load(); }, [tab.key]); // eslint-disable-line

  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const saveRow = async (r, i) => {
    try {
      const body = {}; tab.cols.forEach((c) => (body[c.k] = r[c.k]));
      if (r.id) await api.put(`/solar/${tab.key}/${r.id}`, body);
      else { const res = await api.post(`/solar/${tab.key}`, body); patch(i, 'id', res.data.id); }
      patch(i, '_dirty', false); toast.success('Saved');
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const del = async (r, i) => {
    if (r.id && !confirm('Delete this rate row?')) return;
    if (r.id) { try { await api.delete(`/solar/${tab.key}/${r.id}`); } catch { toast.error('Delete failed'); return; } }
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  };
  const addRow = () => setRows((rs) => [...rs, { _dirty: true, active: 1 }]);

  return (
    <div className="card p-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]">
          {tab.cols.map((c) => <th key={c.k} className="p-2">{c.label || c.k.replace(/_/g, ' ')}</th>)}<th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || `new${i}`} className="border-t">
              {tab.cols.map((c) => (
                <td key={c.k} className="p-1" style={c.w ? { width: c.w } : undefined}>
                  {c.sel
                    ? <select className="input-compact w-full" value={r[c.k] ?? ''} onChange={(e) => patch(i, c.k, e.target.value)}>
                        {c.sel.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                    : <input className="input-compact w-full" type={c.t || 'text'} value={r[c.k] ?? ''} onChange={(e) => patch(i, c.k, c.t === 'number' ? e.target.value : e.target.value)} />}
                </td>))}
              <td className="p-1 whitespace-nowrap">
                <button onClick={() => saveRow(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`} title="Save"><FiSave size={13} /></button>
                <button onClick={() => del(r, i)} className="px-2 py-1 text-red-500" title="Delete"><FiTrash2 size={13} /></button>
              </td>
            </tr>))}
        </tbody>
      </table>
      <button onClick={addRow} className="btn btn-secondary text-xs mt-3 flex items-center gap-1"><FiPlus size={13} /> Add row</button>
    </div>);
}

function FactorsEditor() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/solar/factors').then((r) => setRows(r.data || [])); }, []);
  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const save = async (r, i) => {
    try { await api.put(`/solar/factors/${r.id}`, { val1: r.val1, val2: r.val2, val3: r.val3 }); patch(i, '_dirty', false); toast.success('Saved'); }
    catch { toast.error('Save failed'); }
  };
  const labels = { mount: ['struct ×', 'area m²/kWp', ''], array: ['struct ×', 'yield ×', ''], state: ['yield kWh/kWp', 't-min °C', 't-max °C'] };
  return (
    <div className="card p-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]"><th className="p-2">Kind</th><th className="p-2">Name</th><th className="p-2">Val 1</th><th className="p-2">Val 2</th><th className="p-2">Val 3</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.kind}</td><td className="p-2 font-medium">{r.name}</td>
              {[0, 1, 2].map((j) => (
                <td key={j} className="p-1">{(labels[r.kind] || [])[j] !== '' ? (
                  <input className="input-compact w-24" type="number" value={r[`val${j + 1}`] ?? ''} onChange={(e) => patch(i, `val${j + 1}`, e.target.value)} placeholder={(labels[r.kind] || [])[j]} />) : null}</td>))}
              <td className="p-1"><button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button></td>
            </tr>))}
        </tbody>
      </table>
    </div>);
}

function SettingsEditor() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/solar/settings').then((r) => setRows(r.data || [])); }, []);
  const patch = (i, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, value: v, _dirty: true } : r));
  const save = async (r, i) => { try { await api.put(`/solar/settings/${r.key}`, { value: r.value }); patch(i, r.value); setRows((rs) => rs.map((x, idx) => idx === i ? { ...x, _dirty: false } : x)); toast.success('Saved'); } catch { toast.error('Save failed'); } };
  return (
    <div className="card p-4">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]"><th className="p-2">Key</th><th className="p-2">Value</th><th className="p-2">Unit</th><th className="p-2">Note</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className="border-t">
              <td className="p-2 font-medium">{r.key}</td>
              <td className="p-1"><input className="input-compact w-28" value={r.value ?? ''} onChange={(e) => patch(i, e.target.value)} /></td>
              <td className="p-2 text-gray-500">{r.unit}</td><td className="p-2 text-gray-500">{r.note}</td>
              <td className="p-1"><button onClick={() => save(r, i)} className={`px-2 py-1 rounded ${r._dirty ? 'bg-blue-700 text-white' : 'text-gray-300'}`}><FiSave size={13} /></button></td>
            </tr>))}
        </tbody>
      </table>
    </div>);
}

export default function SolarRateMaster() {
  const [active, setActive] = useState('panels');
  const tabObj = TABS.find((t) => t.key === active);
  const allTabs = [...TABS, { key: 'factors', label: 'Factors' }, { key: 'settings', label: 'Settings' }];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Rate Master</h1>
        <p className="text-xs text-gray-500">Purchase (cost) rates ex-GST that drive the Solar Quotation engine. Edits apply to new quotes immediately.</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {allTabs.map((t) => (
          <button key={t.key} onClick={() => setActive(t.key)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${active === t.key ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>{t.label}</button>))}
      </div>
      {active === 'factors' ? <FactorsEditor /> : active === 'settings' ? <SettingsEditor /> : <EditableTable tab={tabObj} />}
    </div>);
}
