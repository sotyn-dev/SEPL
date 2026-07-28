import { useState, useRef, useEffect, useMemo, useId } from 'react';
import { FiChevronDown } from 'react-icons/fi';
import { flattenTree } from '../hooks/useDepartmentTree';

// DepartmentPicker — pure/presentational tree picker over the org department
// tree (from useDepartmentTree). Same shell as PeoplePicker (search, keyboard,
// states) but rows are indented by depth and it returns a department id.
//
//   tree       nested roots[] with .children (from useDepartmentTree)
//   value      selected department id | null
//   onChange   (id | null, node | null)
//   excludeId  hide this node AND its subtree (used by "move to…" so a
//              department can't be reparented under itself or a descendant)
//   loading / error / onRetry / disabled / disabledHint / allowClear /
//   placeholder / emptyText / className

const RENDER_CAP = 400;

export default function DepartmentPicker({
  tree = [],
  value = null,
  onChange,
  excludeId = null,
  loading = false,
  error = false,
  onRetry,
  disabled = false,
  disabledHint,
  allowClear = true,
  placeholder = 'Select a department…',
  emptyText = 'No departments',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = useId();

  // Resolve the selected node from the FULL tree (so a valid selection outside
  // the visible/excluded subtree still shows); the LIST uses the excluded one.
  const allRows = useMemo(() => flattenTree(tree, null), [tree]);
  const listRows = useMemo(() => flattenTree(tree, excludeId), [tree, excludeId]);
  const selected = useMemo(() => allRows.find(n => n.id === value) || null, [allRows, value]);

  const openPanel = () => { setSearch(''); setActive(0); setOpen(true); };

  // Token search on name + alias (order-independent).
  const filtered = useMemo(() => {
    if (!search.trim()) return listRows;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return listRows.filter(n => {
      const hay = `${n.name || ''} ${n.alias || ''}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }, [listRows, search]);
  const shown = filtered.slice(0, RENDER_CAP);

  useEffect(() => {
    const h = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current?.focus()); }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (node) => { onChange?.(node ? node.id : null, node || null); setOpen(false); setSearch(''); };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) commit(shown[active]); }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { if (open) setOpen(false); else openPanel(); } }}
        title={selected ? selected.name : (disabled ? disabledHint : placeholder)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`input text-left text-sm w-full flex items-center justify-between gap-1.5 cursor-pointer ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <span className={`truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
          {selected ? (
            <>
              {selected.name}
              {selected.alias && <span className="text-gray-400 font-normal"> {selected.alias}</span>}
            </>
          ) : (disabled && disabledHint ? disabledHint : placeholder)}
        </span>
        <FiChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-96 overflow-hidden">
          <div className="p-2 border-b">
            <input
              ref={inputRef}
              type="text"
              className="input text-sm w-full"
              placeholder="Search departments…"
              value={search}
              onChange={e => { setSearch(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={shown[active] ? `${listboxId}-opt-${shown[active].id}` : undefined}
            />
          </div>

          <div ref={listRef} id={listboxId} role="listbox" className="overflow-y-auto max-h-72">
            {allowClear && value != null && (
              <button type="button" onClick={() => commit(null)}
                className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 border-b">
                Clear selection
              </button>
            )}

            {loading && (
              <div className="p-2 space-y-2">
                {[0, 1, 2].map(i => (
                  <div key={i} className="h-6 bg-gray-100 rounded animate-pulse" style={{ marginLeft: i * 12 }} />
                ))}
              </div>
            )}

            {!loading && error && (
              <div className="px-3 py-4 text-sm text-center text-gray-500">
                Couldn’t load departments.{' '}
                {onRetry && <button type="button" onClick={onRetry} className="text-red-600 font-medium hover:underline">Retry</button>}
              </div>
            )}

            {!loading && !error && shown.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">{emptyText}</div>
            )}

            {!loading && !error && shown.map((n, i) => {
              const isSel = n.id === value;
              const isActive = i === active;
              // Indent by depth; when searching (depth still shown) it stays readable.
              return (
                <button
                  type="button"
                  key={n.id}
                  data-idx={i}
                  id={`${listboxId}-opt-${n.id}`}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(n)}
                  title={`${n.name}${n.alias ? ' ' + n.alias : ''}`}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-1.5 transition-colors ${isActive || isSel ? 'bg-red-50' : ''}`}
                  style={{ paddingLeft: `${12 + n.depth * 16}px` }}
                >
                  {n.depth > 0 && <span className="text-gray-300 flex-shrink-0">└</span>}
                  <span className={`truncate ${isSel ? 'font-semibold text-red-700' : 'text-gray-800'}`}>{n.name}</span>
                  {n.alias && <span className="text-xs text-gray-400 truncate">{n.alias}</span>}
                </button>
              );
            })}

            {!loading && !error && filtered.length > RENDER_CAP && (
              <div className="px-3 py-2 text-xs text-gray-400 text-center">
                Showing {RENDER_CAP} of {filtered.length} — type more to narrow
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
