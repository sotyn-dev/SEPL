// SOP-09 RACI & Role Delegation Modal (owner: Project Manager — Adarsh Kumar)
// Allows dynamically assigning employees to SOP-09 roles & gates:
// HR / Manpower (Ruksana), PM (Adarsh Kumar), Department Head (Ambuj),
// Purchase (Awadhesh Kumar Sharma), CRM (Lovely Sharma), Machinery (Ajmer), Accounts (Pooja Kaplesh).
import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiUsers, FiCheck, FiShield, FiRotateCcw, FiLock, FiInfo } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

export default function SiteWorkRaciModal({ onClose, onSaved }) {
  const { user, isAdmin } = useAuth();
  const canModify = Boolean(isAdmin || user?.permissions?.dpr?.includes('approve') || user?.permissions?.dpr?.includes('create'));

  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/dpr/raci')
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
      .catch(() => toast.error('Could not load SOP-09 RACI roles'));
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
    if (!window.confirm('Reset all SOP-09 roles back to standard defaults (HR: Ruksana, PM: Adarsh Kumar, Head: Ambuj, etc.)?')) return;
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
      await api.put('/dpr/raci', { assignments: form });
      toast.success('SOP-09 RACI roles updated successfully');
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
      <Modal isOpen onClose={onClose} title="SOP-09 RACI & Role Settings" wide>
        <div className="py-8 text-center text-sm text-gray-400">Loading SOP-09 RACI role assignments…</div>
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
    <Modal isOpen onClose={onClose} title="SOP-09 · Workflow Roles & Dynamic RACI Matrix" wide>
      <form onSubmit={save} className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 flex items-start gap-2.5">
          <FiShield className="text-indigo-600 mt-0.5 shrink-0 text-base" />
          <div className="flex-1">
            <span className="font-semibold text-slate-900 block mb-0.5">Dynamic Role Delegation (Transfer Anytime):</span>
            Assign which employee is Responsible, Accountable, Consulted, or Informed for each site work stage and hindrance category.
            Any role can transfer to anyone at any time. When transferred, all auto-created PMS tasks, RAG escalations, and 15-minute standup alerts immediately route to the new assignee.
          </div>
          {!canModify && (
            <span className="inline-flex items-center gap-1 text-[11px] bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-medium shrink-0">
              <FiLock size={11} /> View Only
            </span>
          )}
        </div>

        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
          {Object.entries(data.raci || {}).map(([key, role]) => {
            const current = form[key] || {};
            const assignedUser = data.users.find(u => String(u.id) === String(current.user_id));
            const isHr = key === 'hr_lead';

            return (
              <div key={key} className={`p-3 hover:bg-slate-50/70 transition-colors ${isHr ? 'bg-amber-50/40 border-l-4 border-amber-500' : ''}`}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${RACI_BADGES[role.raci_type] || 'bg-gray-100 text-gray-800'}`}>
                        {role.raci_type} — {role.raci_type === 'R' ? 'Responsible' : role.raci_type === 'A' ? 'Accountable' : role.raci_type === 'C' ? 'Consulted' : 'Informed'}
                      </span>
                      <span className="font-semibold text-xs text-slate-900">{role.role_name}</span>
                      <span className="text-[11px] text-slate-400">({role.stage_label})</span>
                      {isHr && (
                        <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold border border-amber-200">
                          HR Responsibility
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 leading-snug">{role.description}</p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                      <span>Default: <b>{role.default_name}</b></span>
                      {assignedUser && (
                        <span className="text-emerald-700 font-medium bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                          Active: {assignedUser.name} ({assignedUser.role || assignedUser.department || 'Staff'})
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="w-full md:w-72 shrink-0">
                    <label className="block text-[11px] text-slate-500 font-medium mb-1">
                      Assigned Employee
                    </label>
                    <select
                      className="input input-sm text-xs w-full bg-white border border-slate-300 rounded"
                      value={current.user_id || ''}
                      onChange={(e) => handleChange(key, 'user_id', e.target.value)}
                      disabled={!canModify || busy}
                    >
                      <option value="">Default ({role.default_name})</option>
                      {data.users.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.name} {u.department ? `· ${u.department}` : ''} ({u.role})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
          <button
            type="button"
            onClick={handleResetDefaults}
            disabled={!canModify || busy}
            className="btn btn-secondary text-xs flex items-center gap-1.5 text-slate-600 hover:text-slate-800"
          >
            <FiRotateCcw size={13} /> Reset to System Defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="btn btn-secondary text-xs"
            >
              Cancel
            </button>
            {canModify && (
              <button
                type="submit"
                disabled={busy}
                className="btn btn-primary text-xs flex items-center gap-1.5"
              >
                <FiCheck size={14} /> {busy ? 'Saving Delegation…' : 'Save RACI Roles'}
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
