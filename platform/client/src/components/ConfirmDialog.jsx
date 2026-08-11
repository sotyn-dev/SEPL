import { useEffect } from 'react';

/**
 * In-app confirm — same idea as ERP client ConfirmDialog2.
 * Replaces window.confirm() so wording, tone, and Esc/backdrop cancel work consistently.
 *
 * tone: 'danger' (destructive) | 'warning' (reversible / caution)
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  note,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const confirmClass = tone === 'warning'
    ? 'bg-amber-500 hover:bg-amber-600'
    : 'bg-red-600 hover:bg-red-700';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => { if (!busy) onCancel?.(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-[340px] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
        {message && (
          <p className="mt-1.5 text-[13px] text-slate-600 leading-snug whitespace-pre-line">{message}</p>
        )}
        {note && (
          <p className="mt-1.5 text-[11px] text-slate-400 leading-snug">{note}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
            className={`px-3 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
