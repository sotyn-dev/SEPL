import { useState, useRef, useEffect } from 'react';

// Status filter — tick one or more statuses (mam 2026-09-14: "all status click
// ui/ux not good"). The six list pages used MultiUserSelect, a people picker:
// every tick became a red pill inside the box, so the box grew taller, pushed
// the filter row around and clashed with the red scope tabs. This one keeps a
// fixed height and says what is filtered in plain words.
//   options : [{ id, name }]
//   value   : array of selected ids — empty = all statuses
//   onChange: (nextIds[]) => void
export default function StatusMultiSelect({ options, value = [], onChange, placeholder = 'All statuses', label = 'Status' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const sel = new Set(value);
  const picked = options.filter(o => sel.has(o.id));
  const allOn = picked.length === 0;
  const toggle = (id) => onChange(sel.has(id) ? value.filter(v => v !== id) : [...value, id]);

  // Closed-box text: "All statuses" · "Open" · "Open, Closed" · "Open +2".
  // Two names only when they fit whole — otherwise "Open +1", never a word
  // cut in half like "Open, Submitte…".
  const bothNames = picked.map(o => o.name).join(', ');
  const summary = allOn
    ? placeholder
    : picked.length === 1 || (picked.length === 2 && bothNames.length <= 18)
      ? bothNames
      : `${picked[0].name} +${picked.length - 1}`;

  return (
    <div ref={ref} className="relative w-full">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        title={allOn ? placeholder : picked.map(o => o.name).join(', ')}
        className={`input h-[42px] w-full flex items-center gap-2 text-left text-sm cursor-pointer transition-colors ${
          allOn ? '' : '!border-blue-400 bg-blue-50/60'} ${open ? 'ring-2 ring-blue-200' : ''}`}>
        {/* label="" when the page already puts a "Status" heading above the box */}
        {label && <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 flex-shrink-0">{label}</span>}
        <span className={`flex-1 truncate ${allOn ? 'text-gray-500' : 'text-blue-800 font-medium'}`}>{summary}</span>
        {!allOn && (
          <>
            <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">{picked.length}</span>
            <span role="button" tabIndex={-1} title="Show all statuses"
              onClick={(e) => { e.stopPropagation(); onChange([]); }}
              className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-200 hover:text-gray-700 text-base leading-none">×</span>
          </>
        )}
        <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div role="listbox" aria-multiselectable="true"
          className="absolute z-50 mt-1 min-w-full w-max max-w-[320px] bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
          <button type="button" onClick={() => onChange([])}
            className={`w-full text-left px-3 py-2.5 text-sm flex items-center gap-2.5 border-b border-gray-100 hover:bg-gray-50 ${allOn ? 'text-blue-800 font-semibold' : 'text-gray-700'}`}>
            <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${allOn ? 'border-blue-600' : 'border-gray-300'}`}>
              {allOn && <span className="w-2 h-2 rounded-full bg-blue-600" />}
            </span>
            {placeholder}
          </button>
          <div className="max-h-64 overflow-y-auto py-1">
            {options.map(o => {
              const on = sel.has(o.id);
              return (
                <button type="button" key={o.id} role="option" aria-selected={on} onClick={() => toggle(o.id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 hover:bg-blue-50 whitespace-nowrap ${on ? 'text-blue-900 font-medium' : 'text-gray-700'}`}>
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${on ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'}`}>
                    {on && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                  </span>
                  {o.name}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50">
            <button type="button" onClick={() => onChange([])} disabled={allOn}
              className="text-xs font-medium text-gray-500 hover:text-gray-800 disabled:opacity-40 disabled:cursor-default">Clear</button>
            <button type="button" onClick={() => setOpen(false)}
              className="text-xs font-semibold px-3 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
