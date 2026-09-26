// SOP-06 RACI & Role Configuration Modal
// Allows dynamically assigning employees to SOP-06 gates:
// S1/S2 Drafting Engineer, S3 Senior Pre-Check, S4 Client Dispatch,
// S5 50% Reminder, S5 80% Escalation, S6 GFC Site Release.
import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiUsers, FiCheck, FiShield, FiRotateCcw, FiLock } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

export default function DrawingRaciModal({ onClose, onSaved }) {
  const { isAdmin } = useAuth();
  const canModify = Boolean(isAdmin);

  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/drawing-tracker/raci')
      .then(r => {
        setData(r.data);
        const init = {};
        for (const [k, v] of Object.entries(r.data.raci || {})) {
          init[k] = {
            user_id: v.user_id ? String(v.user_id) : '',
            custom_name: v.user_id ? '' : (v.is_custom ? v.assigned_name : ''),
          };
        }
        setForm(init);
      })
      .catch(() => toast.error('Could not load RACI roles'));
  }, []);

  const handleChange = (roleKey, field, val) => {
    setForm(prev => ({
      ...prev,
      [roleKey]: {
        ...prev[roleKey],
        [field]: val,
        ...(field === 'user_id' && val ? { custom_name: '' } : {})
      }
    }));
  };

  const handleResetDefaults = () => {
    if (!window.confirm('Reset all roles back to standard SOP-06 defaults (MD Asad, Ambuj, Lovely, PM, Rajat sir)?')) return;
    const def = {};
    for (const k of Object.keys(data?.raci || {})) {
      def[k] = { user_id: '', custom_name: '' };
    }
    setForm(def);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!canModify) return;
    setBusy(true);
    try {
      await api.put('/drawing-tracker/raci', { assignments: form });
      toast.success('SOP-06 RACI roles updated successfully');
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save RACI roles');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <Modal isOpen onClose={onClose} title="SOP-06 RACI & Role Settings" wide>
        <div className="py-8 text-center text-sm text-gray-400">Loading RACI assignments…</div>
      </Modal>
    );
  }

  const RACI_BADGES = {
    R: 'bg-blue-100 text-blue-800 border-blue-300',
    A: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    C: 'bg-amber-100 text-amber-800 border-amber-300',
    I: 'bg-purple-100 text-purple-800 border-purple-300',
  };

  return (
    <Modal isOpen onClose={onClose} title="SOP-06 · Workflow Roles & RACI Delegation Matrix" wide>
      <form onSubmit={save} className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 flex items-start gap-2.5">
          <FiShield className="text-slate-600 mt-0.5 shrink-0 text-base" />
          <div className="flex-1">
            <span className="font-semibold text-slate-900 block mb-0.5">Dynamic Role Delegation (Future-Proof):</span>
            Assign which employee is Responsible, Accountable, or Informed for each drawing approval gate.
            Changing an employee here updates the action cards, filter pills, and routes all in-app and push notifications directly to the new assignee.
          </div>
          {!canModify && (
            <span className="inline-flex items-center gap-1 text-[11px] bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-medium shrink-0">
              <FiLock size={11} /> View Only (Admin Required to Edit)
            </span>
          )}
        </div>

        <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden bg-white max-h-[60vh] overflow-y-auto">
          {Object.entries(data.raci || {}).map(([key, role]) => {
            const curVal = form[key] || {};
            return (
              <div key={key} className="p-3.5 hover:bg-gray-50/50 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="min-w-0 md:w-1/2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-red-600">{role.stage_label}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${RACI_BADGES[role.raci_type] || 'bg-gray-100'}`} title={
                      role.raci_type === 'R' ? 'Responsible (Performs work)' :
                      role.raci_type === 'A' ? 'Accountable (Gatekeeper / Sign-off)' :
                      role.raci_type === 'C' ? 'Consulted (Provides input)' : 'Informed (Notified)'
                    }>
                      {role.raci_type} · {role.raci_type === 'R' ? 'Responsible' : role.raci_type === 'A' ? 'Accountable' : role.raci_type === 'C' ? 'Consulted' : 'Informed'}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-800 mt-0.5">{role.role_name}</div>
                  <p className="text-[11px] text-gray-500 mt-0.5">{role.description}</p>
                  <div className="text-[11px] text-slate-400 mt-1">
                    Standard Default: <span className="font-medium text-slate-600">{role.default_name}</span>
                  </div>
                </div>

                <div className="md:w-1/2 flex flex-col sm:flex-row gap-2">
                  <div className="flex-1">
                    <label className="text-[11px] font-medium text-gray-500 block mb-0.5">Assigned Employee</label>
                    <select
                      className="select text-xs w-full bg-white disabled:bg-gray-50 disabled:text-gray-500"
                      disabled={!canModify}
                      value={curVal.user_id || ''}
                      onChange={e => handleChange(key, 'user_id', e.target.value)}
                    >
                      <option value="">— Standard Default ({role.default_name}) —</option>
                      {(data.users || []).map(u => (
                        <option key={u.id} value={u.id}>
                          {u.name} {u.department ? `(${u.department})` : `[${u.role}]`}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!curVal.user_id && (
                    <div className="sm:w-40">
                      <label className="text-[11px] font-medium text-gray-500 block mb-0.5">Or Custom Name</label>
                      <input
                        type="text"
                        className="input text-xs w-full disabled:bg-gray-50 disabled:text-gray-500"
                        disabled={!canModify}
                        placeholder={role.default_name}
                        value={curVal.custom_name || ''}
                        onChange={e => handleChange(key, 'custom_name', e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t text-xs text-gray-500 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span>* Changes take effect immediately across all drawing views.</span>
            {canModify && (
              <button
                type="button"
                onClick={handleResetDefaults}
                className="text-gray-500 hover:text-red-600 inline-flex items-center gap-1 text-[11px] underline ml-2"
                title="Reset all assignments back to standard SOP-06 defaults"
              >
                <FiRotateCcw size={11} /> Reset to Standard Defaults
              </button>
            )}
          </div>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="btn btn-secondary text-sm">
              {canModify ? 'Cancel' : 'Close'}
            </button>
            {canModify && (
              <button type="submit" disabled={busy} className="btn btn-primary text-sm flex items-center gap-1">
                <FiCheck size={14} /> {busy ? 'Saving…' : 'Save RACI Roles'}
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
