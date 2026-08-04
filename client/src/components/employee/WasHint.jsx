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
