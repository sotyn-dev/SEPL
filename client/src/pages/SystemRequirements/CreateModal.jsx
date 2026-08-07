import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import toast from 'react-hot-toast';
import { FiPaperclip, FiTrash2 } from 'react-icons/fi';
import { TYPES, PRIORITIES, DESC_HARD_LIMIT, descLengthHint, clipToLimit } from './constants';

const empty = {
  title: '',
  description: '',
  type: 'enhancement',
  priority: 'medium',
};

export default function CreateModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(empty);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(empty);
    setFiles([]);
  }, [open]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (submit) => {
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
    if ((form.description || '').length > DESC_HARD_LIMIT) {
      toast.error(`Description max ${DESC_HARD_LIMIT} characters`);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/system-requirements', {
        ...form,
        description: form.description || null,
        submit,
      });
      let uploaded = 0;
      let failed = 0;
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          await api.post(`/system-requirements/${data.id}/attachments`, fd);
          uploaded += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed) toast.error(`${failed} file(s) failed to upload`);
      else if (uploaded) toast.success(submit ? 'Submitted with attachments' : 'Draft saved with attachments');
      else toast.success(submit ? 'Submitted — Waiting / Backlog (priority IT manager)' : 'Draft saved');
      onCreated?.(data);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const descHint = descLengthHint(form.description);

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
            maxLength={DESC_HARD_LIMIT}
            onChange={e => set('description', clipToLimit(e.target.value, DESC_HARD_LIMIT))}
            placeholder="What is needed and why? Include ERP module / department context here if relevant."
          />
          <p className={`text-[11px] mt-1 ${descHint.tone === 'warn' ? 'text-amber-700' : 'text-gray-400'}`}>
            {descHint.text}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Attachments</label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-dashed border-gray-300 cursor-pointer hover:bg-gray-50">
              <FiPaperclip size={12} /> Add files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  setFiles(prev => [...prev, ...e.target.files]);
                  e.target.value = '';
                }}
              />
            </label>
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full px-2 py-1">
                {f.name}
                <button type="button" className="text-gray-500 hover:text-red-600" onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}>
                  <FiTrash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1">Images, PDF, zip, docs — max 25 MB each (no video).</p>
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
          On <strong>Submit</strong>, status becomes <strong>Waiting / Backlog</strong> and the ticket goes to the <strong>Priority IT manager</strong> (first in Settings).
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
