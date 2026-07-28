import { useState, useRef, useEffect, useMemo, useId } from 'react';

// PeoplePicker — the shared, purpose-built person selector for the org module
// (set-head, reports-to, linked-user, and any "pick a human" spot elsewhere).
//
// PURE / PRESENTATIONAL: it does NOT fetch. The caller passes `options` (usually
// from the shared, cached usePeopleOptions('user'|'employee') hook, or its own
// list) plus loading/error state. Reusable for ANY people list, testable with
// mock data.
//
// Two modes:
//   single (default) — value = id | null ; onChange(id | null, row | null)
//   multiple         — value = id[]       ; onChange(id[], rows[])
//     · closed control shows removable × tag chips
//     · list rows show a ✓ tick and toggle without closing
// Both modes are ×-clearable (clear-all in the control).
//
// Rich two-line rows tell same-named people apart: email · designation ·
// department + active dot, and a "⚠ N records" flag when a login maps to more
// than one employee (dupCount > 1). Token search matches name + email +
// designation + department. Missing/null fields render gracefully.
//
// Expected row shape: { id, name, email, designation, department, active, dupCount, avatar_url? }
// (avatar_url optional — real photo shown when present, else colour-coded initials).

const RENDER_CAP = 400;   // paint at most this many rows; search narrows the rest

// Initials for the avatar chip — same idiom as Layout.jsx:511. Null-safe.
const initialsOf = (name) =>
  (name || '?').trim().split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';

// Avatar — the real photo when the row has an avatar_url, else colour-coded
// initials (grey when inactive). size 5 = compact (closed control), 8 = list row.
function Avatar({ url, name, active = true, size = 8 }) {
  const box = size === 5 ? 'w-5 h-5 text-[10px]' : 'w-8 h-8 text-[11px]';
  if (url) return <img src={url} alt="" className={`${box} rounded-full object-cover flex-shrink-0 border border-gray-200`} />;
  return (
    <span className={`${box} rounded-full font-bold flex items-center justify-center flex-shrink-0 ${active ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-600'}`}>
      {initialsOf(name)}
    </span>
  );
}

// Display name. Email is NEVER shown directly (it's search-only) — so a row
// without a name falls back to "(unnamed)", not its email. In real data both
// users.name and employees.name are NOT NULL, so this fallback is edge-only.
const nameOf = (r) => (r && r.name && String(r.name).trim()) ? r.name : '(unnamed)';

// Label for the CLOSED / filled control — name only, no email.
const closedLabel = (r) => (r ? nameOf(r) : '');

const CheckIcon = () => (
  <svg className="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
  </svg>
);

export default function PeoplePicker({
  options = [],
  value = null,
  onChange,
  multiple = false,
  loading = false,
  error = false,
  onRetry,
  excludeIds = [],
  getDisabledReason,          // (row) => string | null — keep a row VISIBLE but non-
                              // selectable, greyed with the reason (vs excludeIds = hide)
  disabled = false,
  disabledHint,
  allowClear = true,
  showInactive = false,   // assignment pickers hide ex-employees by default
  placeholder = 'Search name or email…',
  emptyText = 'No matches',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);     // keyboard-highlighted row index
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listboxId = useId();

  const excluded = useMemo(() => new Set(excludeIds || []), [excludeIds]);
  // `visible` = everything selectable/resolvable (used to resolve the selected
  // row + chips, so an already-chosen person who later went inactive still
  // shows in the control instead of silently blanking). `pool` = what the LIST
  // offers — inactive members are hidden by default (assignment convention),
  // unless showInactive. Only an explicit active===false is hidden.
  const visible = useMemo(() => (options || []).filter(o => o && !excluded.has(o.id)), [options, excluded]);
  const pool = useMemo(() => (showInactive ? visible : visible.filter(o => o.active !== false)), [visible, showInactive]);
  const byId = useMemo(() => new Map(visible.map(o => [o.id, o])), [visible]);

  // Selected ids as an array + Set, normalised across modes.
  const selectedIds = useMemo(
    () => (multiple ? (Array.isArray(value) ? value : []) : (value != null ? [value] : [])),
    [multiple, value],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Single-mode selected row (may be null while loading / if id absent).
  const selected = useMemo(() => (multiple ? null : byId.get(value) || null), [multiple, byId, value]);
  // Multi-mode chips — keep unknown ids visible (fallback "#id") so a value set
  // before options load doesn't silently vanish.
  const chips = useMemo(
    () => (multiple ? selectedIds.map(id => byId.get(id) || { id, name: `#${id}`, _unknown: true }) : []),
    [multiple, selectedIds, byId],
  );
  const hasSelection = selectedIds.length > 0;

  // Open the panel from a fresh state (reset in the handler, NOT an effect).
  const openPanel = () => { setSearch(''); setActive(0); setOpen(true); };

  // Token search across name AND email AND designation AND department — every
  // whitespace token must appear somewhere in the row's combined text.
  const filtered = useMemo(() => {
    if (!search.trim()) return pool;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return pool.filter(o => {
      const hay = `${o.name || ''} ${o.email || ''} ${o.designation || ''} ${o.department || ''}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }, [pool, search]);

  const shown = filtered.slice(0, RENDER_CAP);

  // Close on outside click.
  useEffect(() => {
    const h = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // On open: focus the search box (DOM call only — no setState).
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keep the highlight scrolled into view as it moves.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // --- selection ops -------------------------------------------------------
  const emitSingle = (row) => { onChange?.(row ? row.id : null, row || null); setOpen(false); setSearch(''); };
  const emitMulti = (nextIds) => {
    const rows = nextIds.map(id => byId.get(id)).filter(Boolean);
    onChange?.(nextIds, rows);
  };
  const toggle = (row) => {
    if (!multiple) return emitSingle(row);
    const has = selectedSet.has(row.id);
    emitMulti(has ? selectedIds.filter(id => id !== row.id) : [...selectedIds, row.id]);
  };
  const removeId = (id) => emitMulti(selectedIds.filter(x => x !== id));
  const clearAll = () => { multiple ? onChange?.([], []) : onChange?.(null, null); };

  const onSearchKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o && !getDisabledReason?.(o)) toggle(o); }
    else if (e.key === 'Backspace' && !search && multiple && selectedIds.length) {
      removeId(selectedIds[selectedIds.length - 1]);   // chip-style backspace delete
    }
  };
  const onControlKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); if (!open) openPanel(); }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        onClick={() => { if (!disabled) { if (open) setOpen(false); else openPanel(); } }}
        onKeyDown={onControlKeyDown}
        title={selected ? closedLabel(selected) : (disabled ? disabledHint : placeholder)}
        className={`input text-left text-sm w-full flex items-center gap-1.5 cursor-pointer min-h-[42px] ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
          {multiple ? (
            chips.length ? (
              chips.map(c => (
                <span
                  key={c.id}
                  title={c._unknown ? String(c.name) : closedLabel(c)}
                  className={`inline-flex items-center gap-1 rounded-md pl-1.5 pr-1 py-0.5 text-xs max-w-full ${c._unknown ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-800'}`}
                >
                  <span className="truncate">{nameOf(c)}</span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeId(c.id); }}
                      className="rounded hover:bg-blue-200 text-blue-600 leading-none w-4 h-4 flex items-center justify-center flex-shrink-0"
                      aria-label={`Remove ${nameOf(c)}`}
                    >×</button>
                  )}
                </span>
              ))
            ) : (
              <span className="text-gray-400 truncate">{disabled && disabledHint ? disabledHint : placeholder}</span>
            )
          ) : (
            <span className={`truncate flex items-center gap-1.5 ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
              {selected && <Avatar url={selected.avatar_url} name={selected.name} active={selected.active !== false} size={5} />}
              <span className="truncate">
                {selected ? closedLabel(selected) : (disabled && disabledHint ? disabledHint : placeholder)}
              </span>
            </span>
          )}
        </div>

        {/* Clear-all is single-mode only — in multiselect each chip carries its own
            × (and Backspace removes the last), so a separate clear-all is redundant. */}
        {allowClear && hasSelection && !disabled && !multiple && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearAll(); }}
            title="Clear"
            aria-label="Clear selection"
            className="text-gray-400 hover:text-blue-600 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded"
          >×</button>
        )}
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-96 overflow-hidden">
          <div className="p-2 border-b">
            <input
              ref={inputRef}
              type="text"
              className="input text-sm w-full"
              placeholder="Type a name, email or department…"
              value={search}
              onChange={e => { setSearch(e.target.value); setActive(0); }}
              onKeyDown={onSearchKeyDown}
              role="combobox"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={shown[active] ? `${listboxId}-opt-${shown[active].id}` : undefined}
            />
          </div>

          <div ref={listRef} id={listboxId} role="listbox" aria-multiselectable={multiple || undefined} className="overflow-y-auto max-h-72">
            {loading && (
              <div className="p-2 space-y-2">
                {[0, 1, 2].map(i => (
                  <div key={i} className="flex items-center gap-2 animate-pulse">
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-gray-200 rounded w-1/3" />
                      <div className="h-2.5 bg-gray-100 rounded w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loading && error && (
              <div className="px-3 py-4 text-sm text-center text-gray-500">
                Couldn’t load.{' '}
                {onRetry && (
                  <button type="button" onClick={onRetry} className="text-red-600 font-medium hover:underline">Retry</button>
                )}
              </div>
            )}

            {!loading && !error && shown.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">{emptyText}</div>
            )}

            {!loading && !error && shown.map((o, i) => {
              const isSel = selectedSet.has(o.id);
              const isActive = i === active;
              const nm = nameOf(o);
              // Email is search-only — NOT shown. Visible meta = designation · dept.
              const meta = [o.designation, o.department].filter(Boolean).join(' · ');
              const reason = getDisabledReason?.(o) || null;   // truthy → visible but not pickable
              return (
                <button
                  type="button"
                  key={o.id}
                  data-idx={i}
                  id={`${listboxId}-opt-${o.id}`}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={reason ? true : undefined}
                  disabled={!!reason}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => { if (!reason) toggle(o); }}
                  title={reason ? `${nm} — ${reason}` : `${nm}${meta ? ` — ${meta}` : ''}`}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${reason ? 'opacity-50 cursor-not-allowed' : ''} ${!reason && (isActive || (!multiple && isSel)) ? 'bg-blue-50' : ''}`}
                >
                  <Avatar url={o.avatar_url} name={o.name} active={o.active} size={8} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`text-sm truncate ${isSel ? 'font-semibold text-blue-700' : 'text-gray-900'}`}>{nm}</span>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${o.active ? 'bg-green-500' : 'bg-gray-300'}`} title={o.active ? 'active' : 'inactive'} />
                      {o.dupCount > 1 && (
                        <span className="text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1 flex-shrink-0" title="This login maps to more than one employee record — pick carefully.">
                          ⚠ {o.dupCount} records
                        </span>
                      )}
                    </span>
                    {(meta || reason) && (
                      <span className="block text-xs truncate">
                        {meta && <span className="text-gray-500">{meta}</span>}
                        {reason && <span className="text-amber-700">{meta ? ' · ' : ''}{reason}</span>}
                      </span>
                    )}
                  </span>
                  {multiple && isSel && <CheckIcon />}
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
