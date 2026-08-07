import { useEffect, useState } from 'react';
import { lengthHint, clipToLimit } from './constants';

/** Explicit Edit → Save / Cancel (avoids accidental onBlur saves). */
export default function EditableBlock({
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
