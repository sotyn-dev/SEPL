import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import ConfirmDialog from '../../components/ConfirmDialog';
import Modal from '../../components/Modal';
import SearchableSelect from '../../components/SearchableSelect';
import { FiArrowLeft, FiPaperclip, FiTrash2 } from 'react-icons/fi';
import { fmtDate, fmtDateTime } from '../../utils/datetime';
import { useAuth } from '../../context/AuthContext';
import {
  TYPES, PRIORITIES, STATUSES, STATUS_COLORS, PRIORITY_COLORS,
  labelOf, prettyAction, commentLengthHint, lengthHint,
  DESC_HARD_LIMIT, COMMENT_HARD_LIMIT, DEV_NOTES_HARD_LIMIT, clipToLimit,
} from './constants';

const TABS = ['overview', 'discussion', 'attachments', 'development', 'timeline', 'release'];

const DEV_FIELDS = [
  ['tech_analysis', 'Technical analysis'],
  ['impl_strategy', 'Implementation strategy'],
  ['dev_notes', 'Development notes'],
  ['testing_notes', 'Testing notes'],
  ['completion_summary', 'Completion summary'],
];

/** Explicit Edit → Save / Cancel (avoids accidental onBlur saves). */
function EditableBlock({
  label,
  value,
  multiline = false,
  canEdit,
  saving,
  onSave,
  emptyText = '—',
  minHeightClass = 'min-h-[56px]',
  maxLength = null,
  lengthGuidance = null,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');

  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);

  const startEdit = () => {
    setDraft(value || '');
    setEditing(true);
  };

  const cancel = () => {
    setDraft(value || '');
    setEditing(false);
  };

  const save = async () => {
    const payload = maxLength != null ? clipToLimit(draft, maxLength) : draft;
    const ok = await onSave(payload);
    if (ok) setEditing(false);
  };

  const hint = maxLength != null
    ? lengthHint(editing ? draft : value, maxLength, lengthGuidance)
    : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="text-xs font-medium text-gray-600">{label}</label>
        {canEdit && !editing && (
          <button type="button" onClick={startEdit} className="text-xs font-medium text-red-700 hover:underline">
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          {multiline ? (
            <textarea
              className={`input w-full ${minHeightClass}`}
              value={draft}
              maxLength={maxLength || undefined}
              onChange={e => setDraft(maxLength != null ? clipToLimit(e.target.value, maxLength) : e.target.value)}
              autoFocus
            />
          ) : (
            <input
              className="input w-full"
              value={draft}
              maxLength={maxLength || undefined}
              onChange={e => setDraft(maxLength != null ? clipToLimit(e.target.value, maxLength) : e.target.value)}
              autoFocus
            />
          )}
          {hint && (
            <p className={`text-[11px] mt-1 ${hint.tone === 'warn' ? 'text-amber-700' : 'text-gray-400'}`}>
              {hint.text}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={cancel}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={`text-sm text-gray-800 whitespace-pre-wrap rounded-xl border border-gray-200 py-[10px] px-[14px] ${multiline ? minHeightClass : ''} ${!value ? 'text-gray-400' : ''}`}>
            {value || emptyText}
          </div>
          {hint && value && hint.tone === 'warn' && (
            <p className="text-[11px] mt-1 text-amber-700">{hint.text}</p>
          )}
        </>
      )}
    </div>
  );
}

function canField(data, field) {
  if (!data) return false;
  const list = data.editable_fields;
  if (Array.isArray(list)) return list.includes(field);
  return !!data.can_edit;
}

export default function SystemRequirementWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [businessOwners, setBusinessOwners] = useState([]);
  const [comment, setComment] = useState('');
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editingCommentBody, setEditingCommentBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [bizOpen, setBizOpen] = useState(false);
  const [bizOwner, setBizOwner] = useState('');
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState('');
  const [releaseDraft, setReleaseDraft] = useState({
    target_version: '',
    release_version: '',
    release_notes: '',
  });
  const [releaseDirty, setReleaseDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: row } = await api.get(`/system-requirements/${id}`);
      setData(row);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load');
      navigate('/system-requirements');
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data) return;
    setReleaseDraft({
      target_version: data.target_version || '',
      release_version: data.release_version || '',
      release_notes: data.release_notes || '',
    });
    setReleaseDirty(false);
  }, [data?.id, data?.target_version, data?.release_version, data?.release_notes]);

  useEffect(() => {
    api.get('/system-requirements/options/it-users')
      .then(r => setEmployees((r.data.rows || []).map(u => ({
        value: u.id,
        label: u.name || u.email || `#${u.id}`,
      }))))
      .catch(() => setEmployees([]));
    api.get('/system-requirements/options/business-owners')
      .then(r => setBusinessOwners((r.data.rows || []).map(u => ({
        value: u.id,
        label: u.name || u.email || `#${u.id}`,
      }))))
      .catch(() => setBusinessOwners([]));
  }, []);

  const patch = async (fields) => {
    setSaving(true);
    try {
      const { data: row } = await api.patch(`/system-requirements/${id}`, fields);
      setData(d => ({ ...d, ...row }));
      toast.success('Saved');
      return true;
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runTransition = async (action) => {
    if (action === 'request_business_approval') {
      setBizOwner('');
      setBizOpen(true);
      return;
    }
    const risky = action === 'reject' || action === 'archived' || action === 'close' || action === 'closed';
    if (risky) {
      const isBizReject = action === 'reject' && data.status === 'under_review';
      const titles = {
        reject: isBizReject ? 'Reject back to IT managers?' : 'Mark rejected?',
        close: 'Close this requirement?',
        closed: 'Close this requirement?',
        archived: 'Archive requirement?',
      };
      const messages = {
        reject: isBizReject
          ? 'Returns the ticket to Waiting for IT managers — rework or close.'
          : 'Marks the requirement rejected.',
        close: 'Closes the ticket. IT managers can reopen later if needed.',
        closed: 'Closes the ticket. IT managers can reopen later if needed.',
        archived: 'Archived items are hidden from the active list.',
      };
      setConfirm({
        title: titles[action] || 'Confirm?',
        message: messages[action] || 'Continue?',
        confirmLabel: isBizReject ? 'Reject → IT' : action === 'close' || action === 'closed' ? 'Close' : action === 'reject' ? 'Reject' : 'Archive',
        tone: 'danger',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition(action);
        },
      });
      return;
    }
    await doTransition(action);
  };

  const doTransition = async (action, extra = {}) => {
    try {
      const { data: row } = await api.post(`/system-requirements/${id}/transition`, { action, ...extra });
      setData(d => ({
        ...d,
        ...row,
        comments: d.comments,
        attachments: d.attachments,
        history: row.history || d.history,
      }));
      await load();
      toast.success(
        action === 'reassign' ? 'Reassigned'
          : action === 'request_business_approval' ? 'Sent for business approval'
            : action === 'approve_business' ? 'Approved — back to Waiting'
              : action === 'reject' ? 'Rejected — back to Waiting'
                : action === 'need_clarification' ? 'Need Clarification — with IT'
                  : 'Status updated'
      );
    } catch (e) {
      toast.error(e.response?.data?.error || 'Transition failed');
    }
  };

  const confirmBizApproval = async () => {
    if (!bizOwner) {
      toast.error('Pick one business owner');
      return;
    }
    setBizOpen(false);
    await doTransition('request_business_approval', { assignee_id: Number(bizOwner) });
  };

  const changeStatus = async (to) => {
    if (!to || to === data.status) return;
    if (!data.can_change_status) {
      toast.error('Status is locked');
      return;
    }
    if (to === 'closed') {
      setConfirm({
        title: 'Close this requirement?',
        message: 'Closes the ticket. IT managers can reopen later if needed.',
        confirmLabel: 'Close',
        tone: 'danger',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition('closed');
        },
      });
      return;
    }
    await doTransition(to);
  };

  const changeAssignee = async (v) => {
    if (!data.can_change_assignee) return;
    await patch({ assignee_id: v || null });
    await load();
  };

  const openReassign = () => {
    setReassignTo('');
    setReassignOpen(true);
  };

  const confirmReassign = async () => {
    if (!reassignTo) {
      toast.error('Pick a replacement');
      return;
    }
    setReassignOpen(false);
    await doTransition('reassign', { assignee_id: Number(reassignTo) });
  };

  const reassignRoleLabel = (role) => {
    if (role === 'business_owner') return 'business owner';
    if (role === 'it_manager') return 'IT manager';
    return 'IT manager or IT team member';
  };

  const setReleaseField = (key, value) => {
    setReleaseDraft(d => ({ ...d, [key]: value }));
    setReleaseDirty(true);
  };

  const canEditRelease = canField(data, 'target_version')
    || canField(data, 'release_version')
    || canField(data, 'release_notes');

  const saveRelease = async () => {
    const ok = await patch({
      target_version: releaseDraft.target_version || null,
      release_version: releaseDraft.release_version || null,
      release_notes: releaseDraft.release_notes || null,
    });
    if (ok) setReleaseDirty(false);
  };

  const cancelRelease = () => {
    setReleaseDraft({
      target_version: data.target_version || '',
      release_version: data.release_version || '',
      release_notes: data.release_notes || '',
    });
    setReleaseDirty(false);
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    if (comment.length > COMMENT_HARD_LIMIT) {
      toast.error(`Comment max ${COMMENT_HARD_LIMIT} characters`);
      return;
    }
    try {
      const { data: c } = await api.post(`/system-requirements/${id}/comments`, {
        body: clipToLimit(comment.trim(), COMMENT_HARD_LIMIT),
      });
      setData(d => ({ ...d, comments: [...(d.comments || []), c] }));
      setComment('');
      toast.success('Comment added');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const canManageComment = (c) => {
    if (!user || !c) return false;
    if (user.role === 'admin') return true;
    return Number(c.author_id) === Number(user.id);
  };

  const startEditComment = (c) => {
    setEditingCommentId(c.id);
    setEditingCommentBody(c.body || '');
  };

  const cancelEditComment = () => {
    setEditingCommentId(null);
    setEditingCommentBody('');
  };

  const saveComment = async (commentId) => {
    const body = clipToLimit(editingCommentBody.trim(), COMMENT_HARD_LIMIT);
    if (!body) {
      toast.error('Comment cannot be empty');
      return;
    }
    if (editingCommentBody.length > COMMENT_HARD_LIMIT) {
      toast.error(`Comment max ${COMMENT_HARD_LIMIT} characters`);
      return;
    }
    try {
      const { data: updated } = await api.patch(`/system-requirements/${id}/comments/${commentId}`, { body });
      setData(d => ({
        ...d,
        comments: (d.comments || []).map(c => (c.id === commentId ? updated : c)),
      }));
      cancelEditComment();
      toast.success('Comment updated');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to update');
    }
  };

  const removeComment = (c) => {
    setConfirm({
      title: 'Delete comment?',
      message: 'This removes the comment from the discussion.',
      confirmLabel: 'Delete',
      tone: 'danger',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.delete(`/system-requirements/${id}/comments/${c.id}`);
          setData(d => ({
            ...d,
            comments: (d.comments || []).filter(x => x.id !== c.id),
          }));
          if (editingCommentId === c.id) cancelEditComment();
          toast.success('Comment deleted');
        } catch (e) {
          toast.error(e.response?.data?.error || 'Failed to delete');
        }
      },
    });
  };

  const uploadFile = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { data: att } = await api.post(`/system-requirements/${id}/attachments`, fd);
      setData(d => ({ ...d, attachments: [att, ...(d.attachments || [])] }));
      toast.success('Uploaded');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Upload failed');
    }
  };

  const removeAttachment = (att) => {
    setConfirm({
      title: 'Remove attachment?',
      message: `Remove “${att.original_filename}”?`,
      confirmLabel: 'Remove',
      tone: 'danger',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.delete(`/system-requirements/${id}/attachments/${att.id}`);
          setData(d => ({ ...d, attachments: d.attachments.filter(a => a.id !== att.id) }));
          toast.success('Removed');
        } catch (e) {
          toast.error(e.response?.data?.error || 'Failed');
        }
      },
    });
  };

  const downloadAttachment = async (att) => {
    try {
      const r = await api.get(`/system-requirements/${id}/attachments/${att.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.original_filename || 'download';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Download failed');
    }
  };

  if (!data) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }

  const field = (key, value) => {
    if (!canField(data, key)) return;
    setData(d => ({ ...d, [key]: value }));
  };

  const statusLocked = data.status === 'under_review' || !data.can_change_status;
  const statusOpts = data.status_options?.length
    ? data.status_options
    : [{ value: data.status, label: labelOf(STATUSES, data.status) }];

  // Quick actions: business tangent (+ draft Submit). Never show Assign → Pending.
  const quickActions = (data.next_actions || []).filter(a =>
    !['assign', 'pending', 'in_progress', 'close', 'closed'].includes(a.action)
  );

  const assigneeOptions = data.status === 'under_review'
    ? [
      ...businessOwners,
      ...(data.assignee_id && !businessOwners.some(e => e.value === data.assignee_id)
        ? [{
          value: data.assignee_id,
          label: `${data.assignee_name || `#${data.assignee_id}`}${data.assignee_inactive ? ' (inactive)' : ''}`,
        }]
        : []),
    ]
    : [
      { value: '', label: 'Unassigned' },
      ...employees,
      ...(data.assignee_id && !employees.some(e => e.value === data.assignee_id)
        ? [{
          value: data.assignee_id,
          label: `${data.assignee_name || `#${data.assignee_id}`}${data.assignee_inactive ? ' (inactive)' : ''}`,
        }]
        : []),
    ];

  return (
    <div className="space-y-4 min-h-[calc(100vh-180px)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/system-requirements" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-1">
            <FiArrowLeft size={14} /> Back to board
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-mono text-gray-500">{data.req_number}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[data.status] || 'bg-gray-100 text-gray-600'}`}>
              {labelOf(STATUSES, data.status)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_COLORS[data.priority]}`}>
              {labelOf(PRIORITIES, data.priority)}
            </span>
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mt-1">{data.title}</h1>
          {data.status === 'under_review' && (
            <p className="text-sm text-amber-800 mt-1 inline-block">
              &#9888; Waiting for business approval — <strong>{data.assignee_name || 'business owner'}</strong>
              {data.business_approved_at ? ' · signed off once before' : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {quickActions.map(a => (
            <button
              key={a.action}
              type="button"
              onClick={() => runTransition(a.action)}
              className={`px-3 py-1.5 text-sm rounded-lg capitalize ${
                a.action === 'reject' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'
              }`}
            >
              {a.label || prettyAction(a.action)}
            </button>
          ))}
        </div>
      </div>

      {data.needs_reassignment && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-amber-950">
            {data.assignee_inactive ? (
              <>
                Assignee <strong>{data.assignee_name || 'Unknown'}</strong> is inactive
                {data.status ? ` · ticket is still ${labelOf(STATUSES, data.status)}` : ''}.
              </>
            ) : data.approval_pool_empty ? (
              <>No active business owners in Settings — approval is blocked.</>
            ) : (
              <>This ticket needs a new owner for the current step.</>
            )}
            {' '}Quick-assign an active {reassignRoleLabel(data.reassign_role)}.
          </div>
          {data.can_reassign && (
            <button
              type="button"
              onClick={openReassign}
              className="px-3 py-1.5 text-sm rounded-lg bg-amber-700 text-white hover:bg-amber-800"
            >
              Reassign now
            </button>
          )}
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize whitespace-nowrap border-b-2 ${
              tab === t ? 'border-red-600 text-red-700 font-medium' : 'border-transparent text-gray-500'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-4 card p-4">
            <EditableBlock
              label="Title"
              value={data.title || ''}
              canEdit={canField(data, 'title')}
              saving={saving}
              onSave={async (v) => {
                const title = String(v || '').trim();
                if (!title) {
                  toast.error('Title is required');
                  return false;
                }
                return patch({ title });
              }}
            />
            <EditableBlock
              label="Description"
              value={data.description || ''}
              multiline
              minHeightClass="min-h-[120px]"
              canEdit={canField(data, 'description')}
              saving={saving}
              emptyText="No description yet."
              maxLength={DESC_HARD_LIMIT}
              lengthGuidance="Keep it clear and concise — module / department context can go here."
              onSave={(v) => patch({ description: v || null })}
            />
          </div>
          <div className="space-y-3 card p-4">
            {/* Assignee + Status at top (Jira-style). Quick actions are business-only. */}
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600">
                    Assignee {data.status === 'under_review' ? '(business owner)' : '(IT managers + team)'}
                  </label>
                  <div className={`mt-1 ${!data.can_change_assignee || data.status === 'under_review' ? 'pointer-events-none opacity-60' : ''}`}>
                    <SearchableSelect
                      options={assigneeOptions}
                      value={data.assignee_id || ''}
                      onChange={v => changeAssignee(v || null)}
                      placeholder={
                        data.status === 'under_review'
                          ? (data.assignee_name || 'Business owner')
                          : (employees.length ? 'Assign person…' : 'No assignable users — Settings')
                      }
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600">Status</label>
                  <select
                    className="input w-full mt-1"
                    disabled={statusLocked}
                    value={data.status}
                    onChange={e => changeStatus(e.target.value)}
                  >
                    {statusOpts.map(o => (
                      <option key={o.value} value={o.value} disabled={o.disabled}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {data.status === 'under_review' && (
                <p className="text-[11px] text-amber-800 w-full">
                  Assignee and status locked during business approval — use Approve / Need Clarification / Reject
                </p>
              )}
              {data.status !== 'under_review' && (!data.can_change_assignee || !data.can_change_status) && (
                <p className="text-[11px] text-gray-400 w-full">
                  {!data.can_change_assignee && !data.can_change_status
                    ? 'Assignee and status changes are for IT managers / admin'
                    : !data.can_change_assignee
                      ? 'Only IT managers / admin can change assignee'
                      : 'Status changes are for IT / admin'}
                </p>
              )}
              {data.assignee_inactive && data.status !== 'under_review' && (
                <p className="text-xs text-amber-700 w-full">
                  Current assignee is inactive.
                  {data.can_reassign && (
                    <> <button type="button" className="underline font-medium" onClick={openReassign}>Reassign without changing status</button></>
                  )}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1 border-t border-gray-100">
              <div>
                <label className="text-xs font-medium text-gray-600">Type</label>
                <select
                  className="input w-full mt-1"
                  disabled={!canField(data, 'type')}
                  value={data.type}
                  onChange={e => { field('type', e.target.value); patch({ type: e.target.value }); }}
                >
                  {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Priority</label>
                <select
                  className="input w-full mt-1"
                  disabled={!canField(data, 'priority')}
                  value={data.priority}
                  onChange={e => { field('priority', e.target.value); patch({ priority: e.target.value }); }}
                >
                  {PRIORITIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Due date</label>
                <input
                  type="date"
                  className="input w-full mt-1"
                  disabled={!canField(data, 'due_date')}
                  value={data.due_date || ''}
                  onChange={e => { field('due_date', e.target.value); patch({ due_date: e.target.value || null }); }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Target start</label>
                <input
                  type="date"
                  className="input w-full mt-1"
                  disabled={!canField(data, 'target_start_date')}
                  value={data.target_start_date || ''}
                  onChange={e => { field('target_start_date', e.target.value); patch({ target_start_date: e.target.value || null }); }}
                />
              </div>
            </div>

            <p className="text-xs text-gray-500">
              Requested by {data.requested_by_name || '—'} · Updated {fmtDateTime(data.updated_at)}
              {saving ? ' · Saving…' : ''}
            </p>
          </div>
        </div>
      )}

      {tab === 'discussion' && (
        <div className="card p-4 space-y-4">
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {(data.comments || []).length === 0 && <p className="text-sm text-gray-400">No comments yet.</p>}
            {(data.comments || []).map(c => {
              const mine = canManageComment(c);
              const editing = editingCommentId === c.id;
              return (
                <div key={c.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="text-xs text-gray-500">
                      {c.author_name} · {fmtDateTime(c.created_at)}
                      {c.updated_at && c.updated_at !== c.created_at ? ' · edited' : ''}
                    </div>
                    {mine && !editing && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditComment(c)}
                          className="text-xs font-medium text-red-700 hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => removeComment(c)}
                          className="text-xs font-medium text-gray-500 hover:text-red-600 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {editing ? (
                    <div className="space-y-2">
                      <textarea
                        className="input w-full min-h-[70px]"
                        value={editingCommentBody}
                        maxLength={COMMENT_HARD_LIMIT}
                        onChange={e => setEditingCommentBody(clipToLimit(e.target.value, COMMENT_HARD_LIMIT))}
                        autoFocus
                      />
                      {(() => {
                        const hint = commentLengthHint(editingCommentBody);
                        return (
                          <p className={`text-[11px] ${hint.tone === 'warn' ? 'text-amber-700' : 'text-gray-400'}`}>
                            {hint.text}
                          </p>
                        );
                      })()}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => saveComment(c.id)}
                          className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditComment}
                          className="px-3 py-1.5 text-sm rounded-lg border border-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-800 whitespace-pre-wrap">{c.body}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="space-y-1">
            <div className="flex gap-2">
              <textarea
                className="input flex-1 min-h-[70px]"
                value={comment}
                maxLength={COMMENT_HARD_LIMIT}
                onChange={e => setComment(clipToLimit(e.target.value, COMMENT_HARD_LIMIT))}
                placeholder="Add a comment… (@name is fine as plain text)"
              />
              <button type="button" onClick={addComment} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white self-end">Post</button>
            </div>
            {(() => {
              const hint = commentLengthHint(comment);
              return (
                <p className={`text-[11px] ${hint.tone === 'warn' ? 'text-amber-700' : 'text-gray-400'}`}>
                  {hint.text}
                </p>
              );
            })()}
          </div>
        </div>
      )}

      {tab === 'development' && (
        <div className="card p-4 grid grid-cols-1 gap-4">
          {DEV_FIELDS.map(([key, label]) => (
            <EditableBlock
              key={key}
              label={label}
              value={data[key] || ''}
              multiline
              canEdit={canField(data, key)}
              saving={saving}
              emptyText="Not filled yet."
              maxLength={DEV_NOTES_HARD_LIMIT}
              onSave={(v) => patch({ [key]: v || null })}
            />
          ))}
        </div>
      )}

      {tab === 'timeline' && (
        <div className="card p-4">
          <ul className="space-y-3">
            {(data.history || []).map(h => (
              <li key={h.id} className="flex gap-3 text-sm">
                <div className="w-36 shrink-0 text-xs text-gray-400">{fmtDateTime(h.created_at)}</div>
                <div>
                  <div className="font-medium text-gray-800">{h.event_type.replace(/_/g, ' ')}</div>
                  <div className="text-gray-500 text-xs">
                    {h.actor_name || 'System'}
                    {h.from_status && h.to_status
                      ? ` · ${labelOf(STATUSES, h.from_status)} → ${labelOf(STATUSES, h.to_status)}`
                      : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'attachments' && (
        <div className="card p-4 space-y-4">
          {data.is_staff && (
            <label className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-dashed border-gray-300 cursor-pointer hover:bg-gray-50">
              <FiPaperclip /> Upload file
              <input type="file" className="hidden" onChange={e => uploadFile(e.target.files?.[0])} />
            </label>
          )}
          <ul className="divide-y">
            {(data.attachments || []).length === 0 && <li className="text-sm text-gray-400 py-2">No attachments.</li>}
            {(data.attachments || []).map(a => (
              <li key={a.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                <div>
                  <button
                    type="button"
                    className="text-red-700 hover:underline text-left"
                    onClick={() => downloadAttachment(a)}
                  >
                    {a.original_filename}
                  </button>
                  <div className="text-xs text-gray-400">{a.uploaded_by_name} · {fmtDate(a.created_at)}</div>
                </div>
                {data.is_staff && (
                  <button type="button" onClick={() => removeAttachment(a)} className="text-gray-400 hover:text-red-600"><FiTrash2 /></button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'release' && (
        <div className="card p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600">Target version</label>
              <input
                className="input w-full mt-1"
                disabled={!canField(data, 'target_version')}
                value={releaseDraft.target_version}
                onChange={e => setReleaseField('target_version', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Release version</label>
              <input
                className="input w-full mt-1"
                disabled={!canField(data, 'release_version')}
                value={releaseDraft.release_version}
                onChange={e => setReleaseField('release_version', e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-gray-600">Release notes</label>
              <textarea
                className="input w-full mt-1 min-h-[100px]"
                disabled={!canField(data, 'release_notes')}
                value={releaseDraft.release_notes}
                onChange={e => setReleaseField('release_notes', e.target.value)}
              />
            </div>
            <p className="text-sm text-gray-500 sm:col-span-2">
              Completed: {data.completed_at ? fmtDateTime(data.completed_at) : '—'}
            </p>
          </div>
          {canEditRelease && (
            <div className="flex gap-2 pt-3 border-t border-gray-100">
              <button
                type="button"
                disabled={saving || !releaseDirty}
                onClick={saveRelease}
                className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                disabled={saving || !releaseDirty}
                onClick={cancelRelease}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone || 'warning'}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <Modal isOpen={bizOpen} onClose={() => setBizOpen(false)} title="Request business approval">
        <p className="text-sm text-gray-600 mb-3">
          Pick <strong>one</strong> business owner. Status becomes <strong>Business Approval</strong> (locked).
          Banner will show: Waiting for business approval — their name.
        </p>
        {businessOwners.length === 0 ? (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            No business owners. Ask an admin to add them under Settings.
          </p>
        ) : (
          <SearchableSelect
            options={businessOwners}
            value={bizOwner === '' ? '' : Number(bizOwner)}
            onChange={v => setBizOwner(v)}
            placeholder="Select business owner…"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setBizOpen(false)} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
          <button type="button" disabled={!businessOwners.length} onClick={confirmBizApproval} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50">
            Send for approval
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={reassignOpen}
        onClose={() => setReassignOpen(false)}
        title={`Reassign → ${reassignRoleLabel(data.reassign_role)}`}
      >
        <p className="text-sm text-gray-600 mb-3">
          Status stays <strong>{labelOf(STATUSES, data.status)}</strong>. Pick an active{' '}
          {reassignRoleLabel(data.reassign_role)} for this step.
        </p>
        {(data.reassign_users || []).length === 0 ? (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            No active people in that Settings list. Ask an admin to update Settings first.
          </p>
        ) : (
          <SearchableSelect
            options={(data.reassign_users || []).map(u => ({
              value: u.id,
              label: u.name || u.email || `#${u.id}`,
            }))}
            value={reassignTo === '' ? '' : Number(reassignTo)}
            onChange={v => setReassignTo(v)}
            placeholder="Select replacement…"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setReassignOpen(false)} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
          <button
            type="button"
            disabled={!(data.reassign_users || []).length}
            onClick={confirmReassign}
            className="px-3 py-2 text-sm rounded-lg bg-amber-700 text-white disabled:opacity-50"
          >
            Reassign
          </button>
        </div>
      </Modal>
    </div>
  );
}
