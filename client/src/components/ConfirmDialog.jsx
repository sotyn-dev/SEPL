import { FiAlertTriangle } from 'react-icons/fi';

// Sleek, purpose-built confirm popup — replaces raw window.confirm() where the
// message needs to be multi-line or styled. Deliberately not built on top of
// Modal.jsx: that component is header+scrollable-body chrome meant for forms,
// overkill for a two-line confirm.
export default function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  tone = 'warning', onConfirm, onCancel, infoOnly = false,
}) {
  if (!open) return null;
  const confirmClasses = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-amber-500 hover:bg-amber-600';
  const iconClasses = tone === 'danger'
    ? 'bg-red-100 text-red-600'
    : 'bg-amber-100 text-amber-600';

  return (
    <div className="!m-0 fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${iconClasses}`}>
            <FiAlertTriangle size={18} />
          </div>
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
            <p className="mt-1 text-sm text-gray-600 whitespace-pre-line">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {infoOnly ? (
            <button
              onClick={onConfirm}
              className={`px-3 py-1.5 text-sm rounded-lg text-white ${confirmClasses}`}
            >
              {confirmLabel}
            </button>
          ) : (
            <>
              <button
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {cancelLabel}
              </button>
              <button
                onClick={onConfirm}
                className={`px-3 py-1.5 text-sm rounded-lg text-white ${confirmClasses}`}
              >
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
