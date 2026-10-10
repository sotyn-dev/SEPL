import { useEffect, useState } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';

export default function TemplateAssignmentPicker({ employee, templates, onSaved, onClose }) {
  const [selected, setSelected] = useState(employee.template_ids || (employee.template_id ? [employee.template_id] : []));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const options = [...templates, ...(employee.templates || []).filter(t => !templates.some(option => option.id === t.id))]
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = options.filter(t => t.name.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [saving, onClose]);
  const toggle = id => setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const response = await api.put(`/scoring/assignments/${employee.user_id}`, { template_ids: selected });
      const ids = response.data.template_ids;
      onSaved(employee.user_id, options.filter(t => ids.includes(t.id)));
      toast.success('Templates saved');
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save templates. Please try again.');
    } finally { setSaving(false); }
  };
  return (
    <Modal isOpen onClose={() => { if (!saving) onClose(); }} title={`Templates for ${employee.name}`}>
      <p className="text-sm text-gray-500 mb-4">Select one or more templates. Their KPIs will appear together in this employee’s Performance.</p>
      <input autoFocus className="input w-full mb-3" aria-label="Search templates" placeholder="Search templates…"
        value={query} onChange={event => setQuery(event.target.value)} />
      <div className="flex items-center justify-between mb-2 text-xs">
        <span className="font-semibold text-blue-800" aria-live="polite">{selected.length} selected</span>
        <button type="button" disabled={saving || !selected.length} onClick={() => setSelected([])}
          className="text-gray-500 hover:text-blue-700 disabled:opacity-40">Clear selection</button>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
        {visible.map(template => (
          <label key={template.id} className={`flex items-center gap-3 px-3 py-3 cursor-pointer hover:bg-blue-50 ${selected.includes(template.id) ? 'bg-blue-50 text-blue-900' : 'text-gray-700'}`}>
            <input type="checkbox" className="w-4 h-4 accent-blue-700" checked={selected.includes(template.id)}
              disabled={saving} onChange={() => toggle(template.id)} />
            <span className="flex-1 text-sm">{template.name}{template.active === 0 && <span className="ml-2 text-xs text-gray-400">Inactive</span>}</span>
            {template.kpi_count != null && <span className="text-xs text-gray-400">{template.kpi_count} KPIs</span>}
          </label>
        ))}
        {!visible.length && <p className="p-5 text-center text-sm text-gray-400">No templates found.</p>}
      </div>
      {!selected.length && <p className="mt-3 text-xs text-amber-700">Saving will leave this employee with no assigned templates.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-4 pt-4 border-t flex justify-end gap-2">
        <button type="button" className="btn btn-secondary text-sm" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary text-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save templates'}</button>
      </div>
    </Modal>
  );
}
