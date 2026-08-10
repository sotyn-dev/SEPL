import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import ConfirmDialog from '../../components/ConfirmDialog';
import Modal from '../../components/Modal';
import SearchableSelect from '../../components/SearchableSelect';
import { FiArrowLeft, FiSliders, FiX } from 'react-icons/fi';
import { fmtDateTime } from '../../utils/datetime';
import { useAuth } from '../../context/AuthContext';
import {
  STATUSES, STATUS_COLORS, PRIORITY_COLORS, PRIORITIES,
  labelOf, prettyAction,
  DESC_HARD_LIMIT, COMMENT_HARD_LIMIT, DEV_NOTES_HARD_LIMIT, clipToLimit,
} from './constants';
import ActionPanel, { canField } from './ActionPanel';
import AttachmentsPanel from './AttachmentsPanel';
import CommentsCard from './CommentsCard';
import EditableBlock from './EditableBlock';
import RemarkConfirmDialog from './RemarkConfirmDialog';

const ALL_TABS = ['overview', 'development', 'release', 'timeline'];
const RAISER_TABS = ['overview', 'timeline'];

const DEV_FIELDS = [
  ['tech_analysis', 'Technical analysis'],
  ['impl_strategy', 'Implementation strategy'],
  ['dev_notes', 'Development notes'],
  ['testing_notes', 'Testing notes'],
  ['completion_summary', 'Completion summary'],
];

export default function SystemRequirementWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [businessOwners, setBusinessOwners] = useState([]);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [remarkConfirm, setRemarkConfirm] = useState(null);
  const [bizOpen, setBizOpen] = useState(false);
  const [bizOwner, setBizOwner] = useState('');
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);
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

  useEffect(() => {
    if (!actionsOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setActionsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actionsOpen]);

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

  const doTransition = async (action, extra = {}) => {
    try {
      const { data: row } = await api.post(`/system-requirements/${id}/transition`, { action, ...extra });
      setData(d => ({
        ...d,
        ...row,
        comments: row.comments || d.comments,
        attachments: row.attachments || d.attachments,
        development_attachments: row.development_attachments || d.development_attachments,
        history: row.history || d.history,
      }));
      await load();
      toast.success(
        action === 'reassign' ? 'Reassigned'
          : action === 'request_business_approval' ? 'Sent for business approval'
            : action === 'approve_business' ? 'Approved — back to Waiting / Backlog'
              : action === 'reject' ? 'Rejected — back to Waiting / Backlog'
                : action === 'need_clarification' ? 'Need Clarification — with IT'
                  : action === 'done' ? 'Marked Done'
                    : action === 'closed' || action === 'close' ? 'Closed early'
                      : action === 'reopened' || action === 'reopen' ? 'Reopened'
                        : 'Status updated'
      );
    } catch (e) {
      toast.error(e.response?.data?.error || 'Transition failed');
    }
  };

  const runTransition = async (action) => {
    if (action === 'request_business_approval') {
      setBizOwner('');
      setBizOpen(true);
      return;
    }

    const isBizReject = action === 'reject' && data.status === 'under_review';
    const isBizClarify = action === 'need_clarification' && data.status === 'under_review';

    if (isBizReject || isBizClarify) {
      setRemarkConfirm({
        title: isBizReject ? 'Reject back to IT managers?' : 'Need clarification?',
        message: isBizReject
          ? 'Returns the ticket to Waiting / Backlog for IT managers. Your remark is posted in Comments.'
          : 'Sets Need Clarification and returns to the priority IT manager. Your remark is posted in Comments.',
        confirmLabel: isBizReject ? 'Reject → IT' : 'Need Clarification',
        tone: isBizReject ? 'danger' : 'warning',
        remarkPlaceholder: isBizReject ? 'Why is this rejected?' : 'What needs clarifying?',
        onConfirm: async (note) => {
          setRemarkConfirm(null);
          await doTransition(action, { note });
        },
      });
      return;
    }

    const risky = action === 'reject' || action === 'archived'
      || action === 'close' || action === 'closed' || action === 'done' || action === 'reopen' || action === 'reopened';
    if (risky) {
      const titles = {
        reject: 'Mark rejected?',
        close: 'Close early?',
        closed: 'Close early?',
        done: 'Mark Done?',
        reopen: 'Reopen this requirement?',
        reopened: 'Reopen this requirement?',
        archived: 'Archive requirement?',
      };
      const messages = {
        reject: 'Marks the requirement rejected.',
        close: 'Early stop — will not ship. IT managers can reopen later if needed.',
        closed: 'Early stop — will not ship. IT managers can reopen later if needed.',
        done: 'Marks successful completion after release. Optional proof can go in Comments.',
        reopen: 'Brings the ticket back for rework. Next set Pending / In Progress and assign a developer.',
        reopened: 'Brings the ticket back for rework. Next set Pending / In Progress and assign a developer.',
        archived: 'Archived items are hidden from the active list.',
      };
      const labels = {
        close: 'Close',
        closed: 'Close',
        done: 'Done',
        reopen: 'Reopen',
        reopened: 'Reopen',
        reject: 'Reject',
        archived: 'Archive',
      };
      setConfirm({
        title: titles[action] || 'Confirm?',
        message: messages[action] || 'Continue?',
        confirmLabel: labels[action] || 'Confirm',
        tone: action === 'done' || action === 'reopen' || action === 'reopened' ? 'warning' : 'danger',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition(action);
        },
      });
      return;
    }
    await doTransition(action);
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
        title: 'Close early?',
        message: 'Early stop — will not ship. IT managers can reopen later if needed.',
        confirmLabel: 'Close',
        tone: 'danger',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition('closed');
        },
      });
      return;
    }
    if (to === 'done') {
      setConfirm({
        title: 'Mark Done?',
        message: 'Successful completion after release. Optional proof can go in Comments.',
        confirmLabel: 'Done',
        tone: 'warning',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition('done');
        },
      });
      return;
    }
    if (to === 'reopened') {
      setConfirm({
        title: 'Reopen this requirement?',
        message: 'Brings the ticket back for rework. Next set Pending / In Progress and assign a developer.',
        confirmLabel: 'Reopen',
        tone: 'warning',
        onConfirm: async () => {
          setConfirm(null);
          await doTransition('reopened');
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

  const addComment = async (text) => {
    if (!text?.trim()) return null;
    if (text.length > COMMENT_HARD_LIMIT) {
      toast.error(`Comment max ${COMMENT_HARD_LIMIT} characters`);
      return null;
    }
    try {
      const { data: c } = await api.post(`/system-requirements/${id}/comments`, {
        body: clipToLimit(text.trim(), COMMENT_HARD_LIMIT),
      });
      toast.success('Comment added');
      return c;
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
      return null;
    }
  };

  const canManageComment = (c) => {
    if (!user || !c) return false;
    if (user.role === 'admin') return true;
    return Number(c.author_id) === Number(user.id);
  };

  const saveComment = async (commentId, bodyRaw) => {
    const body = clipToLimit(String(bodyRaw || '').trim(), COMMENT_HARD_LIMIT);
    if (!body) {
      toast.error('Comment cannot be empty');
      return;
    }
    try {
      await api.patch(`/system-requirements/${id}/comments/${commentId}`, { body });
      await load();
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
          await load();
          toast.success('Comment deleted');
        } catch (e) {
          toast.error(e.response?.data?.error || 'Failed to delete');
        }
      },
    });
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

  const quickActions = data.next_actions || [];

  const quickActionClass = (action) => {
    if (action === 'approve_business') {
      return 'bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-600';
    }
    if (action === 'reject') {
      return 'bg-red-600 text-white hover:bg-red-700 border border-red-600';
    }
    if (action === 'need_clarification') {
      return 'bg-amber-50 text-amber-900 hover:bg-amber-100 border border-amber-300';
    }
    // neutral: Submit, Request business approval, etc.
    return 'bg-gray-800 text-white hover:bg-gray-950 border border-black';
  };

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

  const actionPanelProps = {
    data,
    saving,
    employees,
    assigneeOptions,
    statusOpts,
    statusLocked,
    changeAssignee,
    changeStatus,
    field,
    patch,
    openReassign,
  };

  const canDevAttach = !!(data.is_tech_operator || data.is_staff || canField(data, 'tech_analysis'));
  const tabs = (data.is_tech_operator || data.is_staff) ? ALL_TABS : RAISER_TABS;

  useEffect(() => {
    if (!tabs.includes(tab)) setTab('overview');
  }, [tabs, tab]);

  return (
    <div className="space-y-4 min-h-[calc(100vh-180px)]">
        <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link to="/system-requirements" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-2">
            <FiArrowLeft size={14} /> Back
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
        <button
          type="button"
          className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
          onClick={() => setActionsOpen(true)}
        >
          <FiSliders size={14} /> Actions
        </button>
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
        {tabs.map(t => (
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <div className="card p-4 space-y-4">
              {quickActions.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2 mb-3">
                  {quickActions.map(a => (
                    <button
                      key={a.action}
                      type="button"
                      onClick={() => runTransition(a.action)}
                      className={`px-2 py-1 text-xs rounded-md ${quickActionClass(a.action)}`}
                    >
                      {a.label || prettyAction(a.action)}
                    </button>
                  ))}
                </div>
              )}
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
                markdown
                minHeightClass="min-h-[120px]"
                canEdit={canField(data, 'description')}
                saving={saving}
                emptyText="No description yet."
                maxLength={DESC_HARD_LIMIT}
                lengthGuidance="Keep it clear and concise — module / department context can go here."
                placeholder="What is needed and why? Use **bold** and lists if helpful."
                onSave={(v) => patch({ description: v || null })}
              />
              <AttachmentsPanel
                requirementId={id}
                attachments={data.attachments || []}
                canEdit={!!data.can_edit}
                onChanged={load}
                label="Attachments"
              />
            </div>
            <CommentsCard
              requirementId={Number(id)}
              comments={data.comments || []}
              mentionUsers={data.mention_users || []}
              selfId={user?.id}
              isAdmin={user?.role === 'admin'}
              canEditAttachments={!!data.can_edit}
              onRefresh={load}
              addComment={addComment}
              saveComment={saveComment}
              removeComment={removeComment}
              canManageComment={canManageComment}
            />
          </div>
          <div className="hidden lg:block">
            <div className="card p-4 sticky top-4">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Actions</h3>
              <ActionPanel {...actionPanelProps} />
            </div>
          </div>
        </div>
      )}

      {tab === 'development' && (
        <div className="card p-4 space-y-4">
          <h5 className="font-semibold text-sm">Task's Development Notes</h5>
          <div className="grid grid-cols-1 gap-4">
            {DEV_FIELDS.map(([key, label]) => (
              <EditableBlock
                key={key}
                label={label}
                value={data[key] || ''}
                multiline
                markdown
                canEdit={canField(data, key)}
                saving={saving}
                emptyText="Not filled yet."
                maxLength={DEV_NOTES_HARD_LIMIT}
                onSave={(v) => patch({ [key]: v || null })}
              />
            ))}
          </div>
          <div className="pt-3 border-t border-gray-100">
            <AttachmentsPanel
              requirementId={id}
              attachments={data.development_attachments || []}
              canEdit={canDevAttach}
              onChanged={load}
              uploadFields={{ dev_section: 'development' }}
              label="Development files"
              emptyText="No development files yet."
            />
          </div>
        </div>
      )}

      {tab === 'timeline' && (
        <div className="card p-4">
          <h5 className="font-semibold text-sm mb-4">Task's timeline records</h5>
          <ul className="space-y-3 max-h-[450px] overflow-y-auto -mr-4">
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

      {tab === 'release' && (
        <div className="card p-4 space-y-4">
          <h5 className="font-semibold text-sm">Release Notes</h5>
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

      {/* Mobile Actions drawer */}
      {actionsOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setActionsOpen(false)}
          />
          <div className="absolute inset-y-0 right-0 w-full max-w-sm bg-white shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Actions</h3>
              <button type="button" className="p-2 rounded-lg hover:bg-gray-100" onClick={() => setActionsOpen(false)}>
                <FiX size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <ActionPanel {...actionPanelProps} />
            </div>
          </div>
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

      <RemarkConfirmDialog
        open={!!remarkConfirm}
        title={remarkConfirm?.title}
        message={remarkConfirm?.message}
        confirmLabel={remarkConfirm?.confirmLabel}
        tone={remarkConfirm?.tone || 'warning'}
        remarkPlaceholder={remarkConfirm?.remarkPlaceholder}
        onConfirm={remarkConfirm?.onConfirm}
        onCancel={() => setRemarkConfirm(null)}
      />

      <Modal isOpen={bizOpen} onClose={() => setBizOpen(false)} title="Request business approval">
        <div className="min-h-[200px]">
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
              value={bizOwner}
              onChange={setBizOwner}
              placeholder="Business owner…"
            />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 sticky bottom-4">
          <button type="button" onClick={() => setBizOpen(false)} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
          <button type="button" disabled={!businessOwners.length} onClick={confirmBizApproval} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50">
            Submit
          </button>
        </div>
      </Modal>

      <Modal isOpen={reassignOpen} onClose={() => setReassignOpen(false)} title="Reassign">
        <p className="text-sm text-gray-600 mb-3">
          Pick a replacement {reassignRoleLabel(data.reassign_role)}. Status stays the same.
        </p>
        <SearchableSelect
          options={
            (data.reassign_pool || []).map(u => ({
              value: u.id,
              label: u.name || u.email || `#${u.id}`,
            }))
          }
          value={reassignTo}
          onChange={setReassignTo}
          placeholder="Select person…"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setReassignOpen(false)} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
          <button
            type="button"
            disabled={!reassignTo}
            onClick={confirmReassign}
            className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white disabled:opacity-50"
          >
            Reassign
          </button>
        </div>
      </Modal>
    </div>
  );
}
