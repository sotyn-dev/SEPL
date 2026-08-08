import { useEffect } from 'react';

// Small shared confirmation dialog — the in-app replacement for window.confirm().
//
// Why not confirm(): it can't say anything beyond one line, it can't distinguish
// "this is reversible" from "this is permanent", and on a phone a native browser
// dialog reads like a scam popup, so people dismiss it without reading. The whole
// point of confirming a destructive action is that the wording lands.
//
// Deliberately NOT built on <Modal>: this is a compact prompt, not a page-sized
// panel, so it owns a smaller heading and tighter spacing than Modal's header.
//
// tone drives the confirm button colour ONLY, so the same component covers both
// "permanent, be careful" (danger) and "reversible, just checking" (warning) —
// and the two never look alike, which is the actual safety property.
export default function ConfirmDialog({
  open, title, message, note,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  tone = 'danger', busy = false, onConfirm, onCancel,
}) {
  // Esc cancels — matches what a native confirm() does, and what anyone expects
  // from a dialog. Ignored while the action is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  const confirmClass = tone === 'warning'
    ? 'bg-amber-500 hover:bg-amber-600'
    : 'bg-red-600 hover:bg-red-700';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => { if (!busy) onCancel?.(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-[340px] p-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="mt-1.5 text-[13px] text-gray-600 leading-snug">{message}</p>
        {note && <p className="mt-1.5 text-[11px] text-gray-400 leading-snug">{note}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 rounded-lg border text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} autoFocus
            className={`px-3 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50 ${confirmClass}`}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
