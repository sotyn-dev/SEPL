import { useEffect, useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { COMMENT_HARD_LIMIT } from './constants';

/** SysReq-only confirm with required remark — do not put this in shared ConfirmDialog. */
export default function RemarkConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'warning',
  remarkLabel = 'Remark',
  remarkPlaceholder = '',
  onConfirm,
  onCancel,
}) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  if (!open) return null;

  const confirmClasses = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-amber-500 hover:bg-amber-600';
  const iconClasses = tone === 'danger'
    ? 'bg-red-100 text-red-600'
    : 'bg-amber-100 text-amber-600';

  const canConfirm = text.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${iconClasses}`}>
            <FiAlertTriangle size={16} />
          </div>
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
            <p className="mt-1 text-sm text-gray-600 whitespace-pre-line">{message}</p>
          </div>
        </div>
        <div className="my-3">
          <label className="text-xs font-medium text-gray-600">{remarkLabel} *</label>
          <textarea
            className="input w-full mt-1 min-h-[80px] text-sm"
            value={text}
            maxLength={COMMENT_HARD_LIMIT}
            placeholder={remarkPlaceholder}
            onChange={e => setText(e.target.value.slice(0, COMMENT_HARD_LIMIT))}
            autoFocus
          />
          <p className="text-[11px] text-gray-400 mt-1">{text.length}/{COMMENT_HARD_LIMIT}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm?.(text.trim())}
            className={`px-3 py-1.5 text-sm rounded-lg text-white disabled:opacity-50 ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
