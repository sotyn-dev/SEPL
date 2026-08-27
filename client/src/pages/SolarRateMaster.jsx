import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiSave, FiExternalLink, FiUpload, FiImage } from 'react-icons/fi';
import api from '../api';

// Owns these three solar_settings keys — kept out of the generic
// key-value SettingsEditor below so there's one obvious place to edit them.
const BRANDING_KEYS = ['company_name', 'company_tagline', 'logo_url'];

function BrandingEditor() {
  const [vals, setVals] = useState({ company_name: '', company_tagline: '', logo_url: '' });
  const [dirty, setDirty] = useState({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const load = () => api.get('/solar/settings').then((r) => {
    const next = { company_name: '', company_tagline: '', logo_url: '' };
    for (const row of r.data || []) if (row.key in next) next[row.key] = row.value || '';
    setVals(next); setDirty({});
  });
  useEffect(() => { load(); }, []);

  const set = (k, v) => { setVals((p) => ({ ...p, [k]: v })); setDirty((p) => ({ ...p, [k]: true })); };
  const save = async (k) => {
    try { await api.put(`/solar/settings/${k}`, { value: vals[k] }); setDirty((p) => ({ ...p, [k]: false })); toast.success('Saved'); }
    catch { toast.error('Save failed'); }
  };

  const uploadLogo = async (file) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast.error('Logo must be under 4 MB');
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const { data } = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.put('/solar/settings/logo_url', { value: data.url });
      setVals((p) => ({ ...p, logo_url: data.url }));
      toast.success('Logo uploaded');
    } catch { toast.error('Upload failed'); }
    finally { setUploading(false); }
  };

  return (
    <div className="card p-4 space-y-4 max-w-lg">
      <p className="text-[11px] text-gray-500">Shown on quotations, the design basis report and the DISCOM application summary — replaces the hardcoded company name.</p>
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
          {vals.logo_url ? <img src={vals.logo_url} alt="Logo" className="max-w-full max-h-full object-contain" /> : <FiImage className="text-gray-300" size={24} />}
        </div>
        <div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => uploadLogo(e.target.files?.[0])} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn btn-secondary text-xs flex items-center gap-1">
            <FiUpload size={13} /> {uploading ? 'Uploading…' : vals.logo_url ? 'Replace logo' : 'Upload logo'}
          </button>
          <p className="text-[10px] text-gray-400 mt-1">PNG/JPG, up to 4 MB.</p>
        </div>
      </div>
      {[['company_name', 'Company name'], ['company_tagline', 'Tagline (optional)']].map(([k, label]) => (
        <label key={k} className="block">
          <span className="label">{label}</span>
          <div className="flex gap-2">
            <input className="input-compact w-full" value={vals[k]} onChange={(e) => set(k, e.target.value)} />
            <button onClick={() => save(k)} className={`px-3 rounded ${dirty[k] ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-300'}`}><FiSave size={13} /></button>
          </div>
        </label>
      ))}
    </div>
  );
}

// Engineering factors (mount/array/state multipliers) — NOT a rate master.
function FactorsEditor() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/solar/factors').then((r) => setRows(r.data || [])); }, []);
  const patch = (i, k, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v, _dirty: true } : r));
  const save = async (r, i) => {
    try { await api.put(`/solar/factors/${r.id}`, { val1: r.val1, val2: r.val2, val3: r.val3, val4: r.val4, val5: r.val5 }); patch(i, '_dirty', false); toast.success('Saved'); }
    catch { toast.error('Save failed'); }
  };
  // state's val4/val5 (tariff, subsidy top-up) start blank on every state —
  // deliberately not pre-filled with guessed figures. 0/blank means "not
  // configured", and the quotation falls back to asking the salesperson
  // for the customer's real per-unit rate instead of assuming one.
  const labels = {
    mount: ['struct ×', 'area m²/kWp', '', '', ''],
    array: ['struct ×', 'yield ×', '', '', ''],
    state: ['yield kWh/kWp', 't-min °C', 't-max °C', 'typical tariff ₹/unit', 'subsidy top-up ₹'],
  };
  return (
    <div className="card p-4 overflow-x-auto">
      <p className="text-[11px] text-gray-500 mb-2">State tariff &amp; subsidy top-up are optional starting points — quotes always let the salesperson override with the customer's actual bill rate.</p>
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]"><th className="p-2">Kind</th><th className="p-2">Name</th><th className="p-2">Val 1</th><th className="p-2">Val 2</th><th className="p-2">Val 3</th><th className="p-2">Val 4</th><th className="p-2">Val 5</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.kind}</td><td className="p-2 font-medium">{r.name}</td>
              {[0, 1, 2, 3, 4].map((j) => (
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
  useEffect(() => { api.get('/solar/settings').then((r) => setRows((r.data || []).filter((x) => !BRANDING_KEYS.includes(x.key)))); }, []);
  const patch = (i, v) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, value: v, _dirty: true } : r));
  const save = async (r, i) => { try { await api.put(`/solar/settings/${r.key}`, { value: r.value }); setRows((rs) => rs.map((x, idx) => idx === i ? { ...x, _dirty: false } : x)); toast.success('Saved'); } catch { toast.error('Save failed'); } };
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
  const [active, setActive] = useState('factors');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Settings</h1>
        <p className="text-xs text-gray-500">Engineering factors &amp; global settings that drive the solar engine. Equipment rates live in the shared Item Master.</p>
      </div>
      <div className="card p-3 bg-blue-50/40 border-l-4 border-blue-300 text-xs flex items-center justify-between gap-2 flex-wrap">
        <span>Equipment rates live in the <b>Solar Material Master</b>; labour in the <b>Solar Labour Master</b>. This page is only the engine config.</span>
        <div className="flex gap-2">
          <Link to="/solar-material-master" className="btn btn-secondary text-xs flex items-center gap-1 whitespace-nowrap"><FiExternalLink size={13} /> Material Master</Link>
          <Link to="/solar-labour-master" className="btn btn-secondary text-xs flex items-center gap-1 whitespace-nowrap"><FiExternalLink size={13} /> Labour Master</Link>
        </div>
      </div>
      <div className="flex gap-2">
        {[['factors', 'Engineering Factors'], ['settings', 'Global Settings'], ['branding', 'Branding']].map(([k, l]) => (
          <button key={k} onClick={() => setActive(k)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${active === k ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>{l}</button>))}
      </div>
      {active === 'factors' ? <FactorsEditor /> : active === 'settings' ? <SettingsEditor /> : <BrandingEditor />}
    </div>);
}
