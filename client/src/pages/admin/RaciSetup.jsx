// RACI & SLA setup (mam 2026-06-25). Admin assigns Responsible / Accountable /
// Consulted / Informed + an SLA (hours) per workflow step, per module. The
// system then flags who is late and by how much on each record (for scoring).
import { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiClock, FiSave } from 'react-icons/fi';

export default function RaciSetup() {
  const [modules, setModules] = useState([]);
  const [module, setModule] = useState('payables');
  const [users, setUsers] = useState([]);
  const [steps, setSteps] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/raci/modules').then(r => setModules(r.data || [])).catch(() => {});
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
  }, []);
  const load = useCallback((m) => { api.get(`/raci/config/${m}`).then(r => setSteps(r.data.steps || [])).catch(() => setSteps([])); }, []);
  useEffect(() => { if (module) load(module); }, [module, load]);

  const setField = (i, k, v) => setSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/raci/config/${module}`, {
        steps: steps.map(s => ({
          step_key: s.key,
          responsible_id: s.responsible_id || null, accountable_id: s.accountable_id || null,
          consulted_id: s.consulted_id || null, informed_id: s.informed_id || null,
          sla_hours: s.sla_hours === '' || s.sla_hours == null ? 24 : +s.sla_hours,
        })),
      });
      toast.success('RACI & SLA saved'); load(module);
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const RoleSelect = ({ i, field, label, tint }) => (
    <div>
      <label className={`label text-[10px] ${tint}`}>{label}</label>
      <select className="input text-xs" value={steps[i]?.[field] || ''} onChange={e => setField(i, field, e.target.value ? +e.target.value : null)}>
        <option value="">— pick —</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </div>
  );

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold flex items-center gap-2"><FiClock /> RACI &amp; SLA Setup</h1>
      <p className="text-sm text-gray-500 mb-4">Assign <b>R</b>esponsible / <b>A</b>ccountable / <b>C</b>onsulted / <b>I</b>nformed and an <b>SLA (hours)</b> per step. The system then flags who is late and by how much on every record — ready for scoring.</p>

      <div className="flex items-center gap-2 mb-4">
        <span className="label mb-0">Module</span>
        <select className="input w-80" value={module} onChange={e => setModule(e.target.value)}>
          {modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      <div className="space-y-2">
        {steps.length === 0 && <div className="text-sm text-gray-400 py-6 text-center">No steps for this module yet.</div>}
        {steps.map((s, i) => (
          <div key={s.key} className="border rounded-lg p-3 bg-white">
            <div className="font-semibold text-sm mb-2 text-gray-800">{s.label}</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <RoleSelect i={i} field="responsible_id" label="Responsible" tint="text-emerald-600" />
              <RoleSelect i={i} field="accountable_id" label="Accountable" tint="text-blue-600" />
              <RoleSelect i={i} field="consulted_id" label="Consulted" tint="text-amber-600" />
              <RoleSelect i={i} field="informed_id" label="Informed" tint="text-gray-500" />
              <div>
                <label className="label text-[10px] text-rose-600">SLA (hours)</label>
                <input type="number" min="0" step="any" className="input text-xs" value={s.sla_hours ?? ''} onChange={e => setField(i, 'sla_hours', e.target.value === '' ? '' : +e.target.value)} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <button onClick={save} disabled={saving || steps.length === 0} className="btn btn-primary mt-4 flex items-center gap-2"><FiSave size={16} /> {saving ? 'Saving…' : 'Save RACI & SLA'}</button>
    </div>
  );
}
