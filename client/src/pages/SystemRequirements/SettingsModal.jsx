import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import MultiUserSelect from '../../components/MultiUserSelect';
import toast from 'react-hot-toast';

/** Ordered priority list beside MultiUserSelect — does not change the shared control. */
function ManagerOrderList({ ids, usersById, canEdit, onChange }) {
  if (!ids.length) return null;

  const move = (id, dir) => {
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    const next = [...ids];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onChange(next);
  };

  return (
    <ul className="mt-2 space-y-1.5 border border-gray-200 rounded-lg p-2 bg-gray-50">
      {ids.map((id, i) => {
        const name = usersById[id]?.name || `#${id}`;
        return (
          <li key={id} className="flex items-center gap-2 text-sm">
            {i === 0 ? (
              <span className="text-[10px] uppercase tracking-wide font-semibold bg-red-600 text-white rounded px-1.5 py-0.5">
                Priority
              </span>
            ) : (
              <span className="text-[10px] text-gray-400 w-[52px] text-center">{i + 1}</span>
            )}
            <span className="flex-1 text-gray-800 truncate">{name}</span>
            {canEdit && (
              <span className="flex gap-1 text-gray-500">
                <button type="button" className="px-1 hover:text-gray-900" title="Move earlier" onClick={() => move(id, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="px-1 hover:text-gray-900" title="Move later" onClick={() => move(id, 1)} disabled={i === ids.length - 1}>↓</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function SettingsModal({ open, onClose, onSaved }) {
  const [allUsers, setAllUsers] = useState([]);
  const [itManagerIds, setItManagerIds] = useState([]);
  const [itTeamIds, setItTeamIds] = useState([]);
  const [businessIds, setBusinessIds] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      api.get('/system-requirements/options/active-users'),
      api.get('/system-requirements/settings'),
    ]).then(([activeRes, settingsRes]) => {
      setAllUsers((activeRes.data.rows || []).map(u => ({ id: u.id, name: u.name || u.email || `#${u.id}` })));
      setItManagerIds(settingsRes.data.it_manager_ids || settingsRes.data.it_approver_ids || []);
      setItTeamIds(settingsRes.data.it_team_ids || []);
      setBusinessIds(settingsRes.data.business_owner_ids || settingsRes.data.business_approver_ids || []);
      setCanEdit(!!settingsRes.data.can_edit);
    }).catch(() => toast.error('Failed to load settings'));
  }, [open]);

  const usersById = Object.fromEntries(allUsers.map(u => [u.id, u]));

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/system-requirements/settings', {
        it_manager_ids: itManagerIds,
        it_team_ids: itTeamIds,
        business_owner_ids: businessIds,
      });
      toast.success('Team lists saved');
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="System Requirements · Settings" wide>
      <p className="text-sm text-gray-600 mb-4">
        Admin only. Same person may appear on more than one list. Order of IT managers matters — first = Priority (new tickets land there).
      </p>

      {!canEdit && (
        <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Only an admin can change these settings.
        </div>
      )}

      <div className="space-y-6">
        <section>
          <h4 className="text-sm font-semibold text-gray-800 mb-1">IT managers</h4>
          <p className="text-xs text-gray-500 mb-2">
            Triage owners. Use the list below to set Priority (first) and order — submitted tickets auto-assign to Priority.
          </p>
          <MultiUserSelect
            options={allUsers}
            value={itManagerIds}
            onChange={ids => canEdit && setItManagerIds(ids)}
            placeholder={canEdit ? 'Pick IT managers…' : 'No access'}
            emptyText="No active users found"
          />
          <ManagerOrderList
            ids={itManagerIds}
            usersById={usersById}
            canEdit={canEdit}
            onChange={setItManagerIds}
          />
        </section>

        <section>
          <h4 className="text-sm font-semibold text-gray-800 mb-1">IT team</h4>
          <p className="text-xs text-gray-500 mb-2">
            People who can receive work assignments (with IT managers). Assignee or scrum master marks Pending → In Progress.
          </p>
          <MultiUserSelect
            options={allUsers}
            value={itTeamIds}
            onChange={ids => canEdit && setItTeamIds(ids)}
            placeholder={canEdit ? 'Pick IT team members…' : 'No access'}
            emptyText="No active users found"
          />
        </section>

        <section>
          <h4 className="text-sm font-semibold text-gray-800 mb-1">Business owners</h4>
          <p className="text-xs text-gray-500 mb-2">
            When IT needs business sign-off, approval or reject returns the ticket to IT managers (rework or close).
          </p>
          <MultiUserSelect
            options={allUsers}
            value={businessIds}
            onChange={ids => canEdit && setBusinessIds(ids)}
            placeholder={canEdit ? 'Pick business owners…' : 'No access'}
            emptyText="No active users found"
          />
        </section>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Cancel</button>
        {canEdit && (
          <button type="button" disabled={saving} onClick={save} className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </Modal>
  );
}
