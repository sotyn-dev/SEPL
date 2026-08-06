import { useState, useRef, useEffect, useMemo, useId } from 'react';
import { FiChevronDown } from 'react-icons/fi';

// OrgCatalogPicker — searchable leaf picker for employee home department /
// designation (Plan B.0). Binds by catalog id; shows leaf label + muted
// hierarchy/meta hint. Do NOT reuse DepartmentPicker (org admin tree moves)
// or SearchableSelect (generic flat lists).
//
//   options     [{ id, label, hint?, search?, note?, disabled? }]
//   value       selected id | null
//   legacyLabel when value is null but a free-text leaf still exists (pinned)
//   onChange    (id | null, option | null)
//   warning     optional soft warning under the control (e.g. singleton held)

const RENDER_CAP = 400;

export default function OrgCatalogPicker({
  options = [],
  value = null,
  legacyLabel = '',
  onChange,
  loading = false,
  error = false,
  onRetry,
  disabled = false,
  disabledHint,
  allowClear = true,
  placeholder = 'Select…',
  emptyText = 'No matches',
  searchPlaceholder = 'Search…',
  warning = null,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = useId();

  const selected = useMemo(
    () => (value != null ? options.find((o) => o.id === value) || null : null),
    [options, value],
  );
  const closedText = selected
    ? selected.label
    : (legacyLabel ? legacyLabel : '');
  const closedHint = selected?.hint || (legacyLabel && !selected ? 'Current (not in catalog)' : '');

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = (o.search || `${o.label || ''} ${o.hint || ''}`).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, search]);
  const shown = filtered.slice(0, RENDER_CAP);

  const openPanel = () => { setSearch(''); setActive(0); setOpen(true); };

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

  const commit = (opt) => {
    onChange?.(opt ? opt.id : null, opt || null);
    setOpen(false);
    setSearch('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = shown[active];
      if (row && !row.disabled) commit(row);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { if (open) setOpen(false); else openPanel(); } }}
        title={closedText || (disabled ? disabledHint : placeholder)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`input text-left text-sm w-full flex items-center justify-between gap-1.5 cursor-pointer ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <span className={`min-w-0 truncate ${closedText ? 'text-gray-900' : 'text-gray-400'}`}>
          {closedText ? (
            <>
              {closedText}
              {closedHint && <span className="text-gray-400 font-normal"> · {closedHint}</span>}
            </>
          ) : (disabled && disabledHint ? disabledHint : placeholder)}
        </span>
        <FiChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>

      {warning && (
        <p className="mt-1 text-[11px] leading-snug text-amber-700">{warning}</p>
      )}

      {open && (
        <div className="absolute z-50 mt-1 w-full max-w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-96 overflow-hidden">
          <div className="p-2 border-b">
            <input
              ref={inputRef}
              type="text"
              className="input text-sm w-full"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={shown[active] ? `${listboxId}-opt-${shown[active].id}` : undefined}
            />
          </div>

          <div ref={listRef} id={listboxId} role="listbox" className="overflow-y-auto max-h-72">
            {allowClear && (value != null || legacyLabel) && (
              <button type="button" onClick={() => commit(null)}
                className="w-full text-left px-3 py-2 text-xs text-red-500 hover:bg-red-50 border-b">
                Clear selection
              </button>
            )}

            {loading && (
              <div className="p-2 space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            )}

            {!loading && error && (
              <div className="px-3 py-4 text-sm text-center text-gray-500">
                Couldn’t load catalog.{' '}
                {onRetry && <button type="button" onClick={onRetry} className="text-red-600 font-medium hover:underline">Retry</button>}
              </div>
            )}

            {!loading && !error && shown.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">{emptyText}</div>
            )}

            {!loading && !error && shown.map((o, i) => {
              const isSel = o.id === value;
              const isActive = i === active;
              return (
                <button
                  type="button"
                  key={o.id}
                  data-idx={i}
                  id={`${listboxId}-opt-${o.id}`}
                  role="option"
                  aria-selected={isSel}
                  disabled={!!o.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => !o.disabled && commit(o)}
                  className={`w-full text-left px-3 py-2 ${o.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'} ${isActive ? 'bg-gray-50' : ''} ${isSel ? 'bg-blue-50' : ''}`}
                >
                  <div className="text-sm text-gray-900 truncate">{o.label}</div>
                  {o.hint && <div className="text-[11px] text-gray-400 truncate">{o.hint}</div>}
                  {o.note && <div className="text-[11px] text-amber-700 truncate">{o.note}</div>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Flatten org department tree → picker options with muted parent-path hint. */
export function departmentCatalogOptions(tree = []) {
  const rows = [];
  const walk = (nodes, ancestors) => {
    (nodes || []).forEach((n) => {
      const path = [...ancestors, n.name];
      rows.push({
        id: n.id,
        label: n.name,
        hint: ancestors.length ? ancestors.join(' › ') : '',
        search: `${n.name} ${n.alias || ''} ${path.join(' ')}`,
      });
      walk(n.children, path);
    });
  };
  walk(tree, []);
  return rows;
}

/** Flat designation catalog → picker options (tag + dept chips as hint). */
export function designationCatalogOptions(list = []) {
  return (list || []).map((d) => {
    const depts = (d.departments || []).map((x) => x.name).filter(Boolean);
    const hintParts = [d.tag_name, depts.length ? depts.join(' · ') : null].filter(Boolean);
    return {
      id: d.id,
      label: d.name,
      hint: hintParts.join(' · '),
      search: `${d.name} ${d.tag_name || ''} ${depts.join(' ')}`,
      singleton: d.singleton === 1,
      active_holders: d.active_holders || 0,
      note: d.singleton === 1 && (d.active_holders || 0) > 0
        ? `Unique title — currently held (${d.active_holders})`
        : null,
    };
  });
}
