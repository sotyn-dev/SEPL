import SearchableSelect from '../../components/SearchableSelect';
import { fmtDateTime } from '../../utils/datetime';
import { TYPES, PRIORITIES } from './constants';

export function canField(data, field) {
  if (!data) return false;
  const list = data.editable_fields;
  if (Array.isArray(list)) return list.includes(field);
  return !!data.can_edit;
}

export default function ActionPanel({
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
}) {
  return (
    <div className="space-y-3">
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
          <label className="text-xs font-medium text-gray-600">Reporter</label>
          <p className="mt-1 text-sm text-gray-800 py-2">{data.requested_by_name || '—'}</p>
        </div>
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
        Updated {fmtDateTime(data.updated_at)}
        {saving ? ' · Saving…' : ''}
      </p>
    </div>
  );
}
