import { useState, useRef, useEffect } from 'react';

// Render cap — only this many option rows are painted at once. Kept low so
// huge masters (the item-master PO list is ~1700 rows) don't render thousands
// of DOM nodes and hang the page (mam 2026-06-09 "erp is hang"). 400 still
// covers a 350-item BOQ fully; for bigger lists the token search below makes
// anything reachable by typing a couple of words.
const RENDER_CAP = 400;

export default function SearchableSelect({ id, ariaLabel, disabled = false, options, value, onChange, placeholder = 'Search...', displayKey = 'label', valueKey = 'value', buttonClassName = 'input text-left text-sm w-full truncate flex items-center justify-between gap-1 cursor-pointer' }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const desktopInputRef = useRef(null);
  const mobileInputRef = useRef(null);

  const selected = options.find(o => o[valueKey] === value);
  // Token-based search (mam 2026-06-09): split the query into words and
  // require EVERY word to appear somewhere in the option text, in any order.
  // The " / " separators in item names (e.g. "pipe / ss 304 / 25mm") no
  // longer break the match — "304 pipe" or "ball 25mm ci" now find it.
  const filtered = options.filter(o => {
    if (!search) return true;
    const text = (o[displayKey] || '').toLowerCase();
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.every(t => text.includes(t));
  });

  useEffect(() => {
    const handler = (e) => {
      // Don't close on touch inside mobile overlay
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  useEffect(() => {
    if (open) {
      const prevOverflow = document.body.style.overflow;
      if (window.innerWidth < 640) {
        document.body.style.overflow = 'hidden';
      }
      setTimeout(() => {
        if (window.innerWidth < 640) {
          mobileInputRef.current?.focus();
        } else {
          desktopInputRef.current?.focus();
        }
      }, 50);
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [open]);

  // selectedLabel is the full untruncated text we'll surface via the
  // native title= attribute on hover (mam 2026-05-25: "i need item where
  // write hose book tooltip of every" — every truncated sub-item should
  // reveal its full name on hover).
  const selectedLabel = selected ? selected[displayKey] : '';

  return (
    <div ref={ref} className="relative">
      <button id={id} aria-label={ariaLabel} aria-expanded={open} disabled={disabled} type="button" onClick={() => { setOpen(!open); setSearch(''); }}
        // title attribute → browser-native tooltip on hover with the full
        // (untruncated) selected value.  Cheap, no library needed, works
        // across all browsers.
        title={selectedLabel || placeholder}
        className={buttonClassName}>
        <span className={`truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
          {selected ? selected[displayKey] : placeholder}
        </span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>

      {open && (
        <>
          {/* Mobile Full-Screen Overlay (< sm screens / phones) */}
          <div className="fixed inset-0 z-[100] bg-white flex flex-col sm:hidden">
            {/* Mobile Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50 flex-shrink-0 gap-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-gray-900 text-sm truncate">
                  {ariaLabel || placeholder || 'Select Option'}
                </h3>
                <p className="text-[11px] text-gray-500">
                  {filtered.length} {filtered.length === 1 ? 'item' : 'items'} available
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setOpen(false); setSearch(''); }}
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-200 flex-shrink-0"
                aria-label="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Mobile Search input */}
            <div className="p-3 border-b bg-white flex-shrink-0">
              <div className="relative">
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  ref={mobileInputRef}
                  type="text"
                  className="input text-base w-full pl-9 pr-9 py-2 rounded-lg border-gray-300 focus:ring-2 focus:ring-blue-500"
                  placeholder="Type to search..."
                  aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search options"}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    aria-label="Clear search text"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Mobile Options List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 overscroll-contain">
              {value && (
                <button
                  type="button"
                  onClick={() => { onChange(null); setOpen(false); setSearch(''); }}
                  className="w-full text-center py-2.5 px-3 text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-xl border border-red-200 transition-colors"
                >
                  Clear selection
                </button>
              )}
              {filtered.length === 0 && (
                <div className="py-12 text-center text-gray-400 text-sm">
                  No items found matching "{search}"
                </div>
              )}
              {filtered.slice(0, RENDER_CAP).map(o => {
                const isSelected = o[valueKey] === value;
                return (
                  <button
                    type="button"
                    key={o[valueKey]}
                    onClick={() => { onChange(o); setOpen(false); setSearch(''); }}
                    className={`w-full text-left p-3.5 rounded-xl border text-sm transition-all flex items-start justify-between gap-3 active:scale-[0.99] ${
                      isSelected
                        ? 'bg-blue-50 border-blue-400 text-blue-900 font-medium shadow-xs'
                        : 'bg-white border-gray-200 hover:border-gray-300 text-gray-800 active:bg-gray-50'
                    }`}
                  >
                    <span className="whitespace-normal break-words leading-relaxed flex-1">
                      {o[displayKey]}
                    </span>
                    {isSelected && (
                      <span className="text-blue-600 font-bold text-xs bg-blue-100 px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5">
                        Selected
                      </span>
                    )}
                  </button>
                );
              })}
              {filtered.length > RENDER_CAP && (
                <div className="py-3 text-xs text-gray-500 text-center bg-gray-50 rounded-lg">
                  Showing {RENDER_CAP} of {filtered.length} items — type more to narrow
                </div>
              )}
            </div>
          </div>

          {/* Desktop inline dropdown (sm+ screens) */}
          <div className="hidden sm:block absolute z-50 mt-1 left-0 min-w-full sm:min-w-[240px] max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden">
            <div className="p-2 border-b">
              <input ref={desktopInputRef} type="text" className="input text-sm w-full" placeholder="Type to search..." aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search options"}
                value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } }} />
            </div>
            <div className="overflow-y-auto max-h-64">
              {value && (
                <button type="button" onClick={() => { onChange(null); setOpen(false); }}
                  className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 border-b">
                  Clear selection
                </button>
              )}
              {filtered.length === 0 && <div className="px-3 py-4 text-sm text-gray-400 text-center">No items found</div>}
              {filtered.slice(0, RENDER_CAP).map(o => (
                <button type="button" key={o[valueKey]} onClick={() => { onChange(o); setOpen(false); setSearch(''); }}
                  title={o[displayKey]}
                  className={`w-full text-left px-3 py-2 text-sm whitespace-normal break-words leading-snug hover:bg-red-50 transition-colors ${o[valueKey] === value ? 'bg-red-50 font-medium text-red-700' : 'text-gray-700'}`}>
                  {o[displayKey]}
                </button>
              ))}
              {filtered.length > RENDER_CAP && <div className="px-3 py-2 text-xs text-gray-400 text-center">Showing {RENDER_CAP} of {filtered.length} — type more to narrow</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
