import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import toast from 'react-hot-toast';
import { TYPES, PRIORITIES } from './constants';

const empty = {
  title: '',
  description: '',
  type: 'enhancement',
  priority: 'medium',
};

export default function CreateModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(empty);
  }, [open]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (submit) => {
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/system-requirements', {
        ...form,
        submit,
      });
      toast.success(submit ? 'Submitted — Waiting (priority IT manager)' : 'Draft saved');
      onCreated?.(data);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="New requirement" wide>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600">Title *</label>
          <input className="input w-full mt-1" value={form.title} onChange={e => set('title', e.target.value)} placeholder="Short clear title" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Description</label>
          <textarea
            className="input w-full mt-1 min-h-[110px]"
            value={form.description}
            onChange={e => set('description', e.target.value)}
            placeholder="What is needed and why? Include ERP module / department context here if relevant."
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-600">Type</label>
            <select className="input w-full mt-1" value={form.type} onChange={e => set('type', e.target.value)}>
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">Priority</label>
            <select className="input w-full mt-1" value={form.priority} onChange={e => set('priority', e.target.value)}>
              {PRIORITIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
          On <strong>Submit</strong>, status becomes <strong>Waiting</strong> and the ticket goes to the <strong>Priority IT manager</strong> (first in Settings).
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
        <button type="button" disabled={saving} onClick={() => save(false)} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50">Save draft</button>
        <button type="button" disabled={saving} onClick={() => save(true)} className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">Submit</button>
      </div>
    </Modal>
  );
}
