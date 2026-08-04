import { FiRotateCcw } from 'react-icons/fi';

// "↩ was X" hint + revert link under a changed tracked field. Shared across
// every section — takes changedSet/original/revertField as props rather than
// closing over a hook, so it works the same in any section file.
export default function WasHint({ k, fmt, changedSet, original, revertField }) {
  if (!changedSet.has(k)) return null;
  return (
    <p className="text-[10px] text-amber-700 mt-0.5 flex items-center gap-1.5">
      <FiRotateCcw size={10} /> was {fmt ? fmt(original[k]) : `"${original[k] ?? '—'}"`}
      <button type="button" onClick={() => revertField(k)} className="underline hover:text-amber-900">revert</button>
    </p>
  );
}

export const trackAccent = (changedSet, key) => (changedSet.has(key) ? 'shadow-[-2px_0_0_0_#c9c9c9] -mx-2 px-2' : '');

// Inline client-side format-error message under a field (see
// constants/employeeValidation.js) — shown regardless of dirty state, since
// a pre-existing bad value (e.g. a legacy 5-digit PIN) should read as wrong
// even before it's touched, not just after an edit.
export function FieldError({ k, ws }) {
  const msg = ws.fieldError(k);
  if (!msg) return null;
  return <p className="text-[10px] text-red-600 mt-0.5">{msg}</p>;
}
