import { useEffect, useState } from 'react';
import { FiMessageSquare } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../api';
import Modal from './Modal';
import { fmtDateTime } from '../utils/datetime';

export function PmsFollowupSummary({ task, onOpen }) {
  return (
    <div className="space-y-1.5 text-xs">
      {task.followup_remark ? (
        <>
          <p className="whitespace-pre-wrap break-words line-clamp-3" title={task.followup_remark}>{task.followup_remark}</p>
          <p className="text-[10px] text-gray-500">{task.followup_remark_by} · {fmtDateTime(task.followup_remark_at)}</p>
        </>
      ) : <p className="text-gray-400">No remarks yet</p>}
      {(task.can_add_followup_remark || task.followup_remark_count > 0) && (
        <button type="button" onClick={() => onOpen(task)}
          className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium"
          aria-label={`Follow-up remarks for PMS-${String(task.id).padStart(4, '0')}`}>
          <FiMessageSquare size={13} />
          {task.can_add_followup_remark ? 'Add remark' : 'View history'}
          {task.followup_remark_count > 0 && <span className="rounded-full bg-blue-50 px-1.5 text-[10px]">{task.followup_remark_count}</span>}
        </button>
      )}
    </div>
  );
}

export default function PmsFollowupRemarks({ task, onClose, onSaved }) {
  const [remarks, setRemarks] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.get(`/pms-tasks/${task.id}/followup-remarks`)
      .then(r => { if (active) setRemarks(r.data); })
      .catch(e => { if (active) setError(e.response?.data?.error || 'Could not load remarks'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [task.id, reload]);

  const save = async e => {
    e.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      const r = await api.post(`/pms-tasks/${task.id}/followup-remarks`, { remark: draft.trim() });
      setRemarks(previous => [r.data, ...previous]);
      setDraft('');
      onSaved(task.id, r.data);
      toast.success('Follow-up remark saved');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save the remark');
    } finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={() => { if (!saving) onClose(); }} title={`Follow-up remarks · PMS-${String(task.id).padStart(4, '0')}`}>
      <div className="space-y-4">
        <div className="rounded-lg bg-gray-50 p-3 text-sm">
          <p className="font-medium">{task.project_name_live || task.project_name_snapshot || 'PMS Task'}</p>
          <p className="mt-1 text-gray-600 whitespace-pre-wrap break-words">{task.description || task.title}</p>
        </div>
        {task.can_add_followup_remark && (
          <form onSubmit={save} className="space-y-2">
            <label className="label" htmlFor="pms-followup-remark">Follow-up remark</label>
            <textarea id="pms-followup-remark" className="input" rows={3} maxLength={2000} required
              placeholder="Add the latest update or next action…" value={draft}
              onChange={e => setDraft(e.target.value)} disabled={saving} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-400">{draft.length}/2,000</span>
              <button type="submit" className="btn btn-primary" disabled={saving || loading || !!error || !draft.trim()}>
                {saving ? 'Saving…' : 'Save remark'}
              </button>
            </div>
          </form>
        )}
        <div className="border-t pt-3">
          <h4 className="font-semibold text-sm mb-3">Remark history</h4>
          {loading ? <p className="text-sm text-gray-500">Loading remarks…</p>
            : error ? <div className="text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => setReload(n => n + 1)}>Retry</button></div>
            : !remarks.length ? <p className="text-sm text-gray-400">No follow-up remarks yet.</p>
            : <ol className="space-y-3">{remarks.map(remark => (
              <li key={remark.id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex flex-wrap justify-between gap-1 text-xs">
                  <span className="font-medium text-gray-800">{remark.author_name}</span>
                  <span className="text-gray-500">{fmtDateTime(remark.created_at)}</span>
                </div>
                <p className="mt-2 text-sm whitespace-pre-wrap break-words">{remark.remark}</p>
              </li>
            ))}</ol>}
        </div>
      </div>
    </Modal>
  );
}
