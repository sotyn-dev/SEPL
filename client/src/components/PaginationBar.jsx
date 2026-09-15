// PaginationBar (mam 2026-09-01): the "truncated numbered pagination" bar —
// "Showing 1–15 of 346 · Per page [15▾] · ‹ Prev 1 2 … 23 24 Next ›" —
// rolled out to the big list pages. Client-side slicing: pages already
// load their full filtered list, the hook just windows what is RENDERED, so
// search/filter/export keep working on the complete list.
//
// NOT the same as components/Pagination.jsx: that older sibling is a PLAIN
// FUNCTION (hook-free on purpose — Procurement.jsx calls it inside per-tab
// IIFEs) with parent-held page state, and Procurement + UserManagement + Snags
// still use it. This one is a real hook that owns its own state, so it must be
// called unconditionally at component top level. Styling matches the old bar
// (red active page, Per page 15/50/100/All).
//
// Usage:
//   const pager = usePagination(filteredRows, { resetKey: [search, status, tab] });
//   ...render pager.pageItems instead of filteredRows...
//   <Pagination {...pager} />          ← OUTSIDE any scroll box (see below)
//
// Rules baked in (pagination audit, mam 2026-09-10 "pagination has some issue
// in live"):
// - resetKey = the page's FILTER INPUTS (search text, pills, tabs, dates…).
//   When it changes the list goes back to page 1 in the same render. Before,
//   searching from page 4 showed "46–50 of 50" and the best matches looked
//   missing. Never pass the list itself: several pages rebuild it every render
//   and Leads / Sotyn Leads re-poll it every 20–30 s, which would pin page 1.
// - The list getting shorter (last row on the last page approved or deleted)
//   keeps the user on the new LAST page instead of throwing them to page 1.
// - "All" per page is kept as the choice 'all' and sized from today's total.
//   It used to be frozen as the count at the moment it was picked, so a list
//   that grew or was un-filtered split into odd pages while the dropdown read
//   "15" (and choosing 15 then did nothing).
// - Changing page scrolls the list's top back into view (utils/scrollListTop).
// - Render the bar AFTER the table's scroll wrapper, never inside it: inside a
//   max-h / overflow box the controls only appear once that box is scrolled to
//   its bottom, and inside a sideways-scrolling box they slide off on phones.
// - Renders on BOTH the desktop table and the md:hidden mobile cards —
//   paginate the SHARED list once, above the two renders (mobile↔desktop
//   control parity, mam 2026-07).
// - CSV "Export" must keep using the FULL filtered list, never pageItems.
import { useEffect, useMemo, useRef, useState } from 'react';
import { scrollListTop } from '../utils/scrollListTop';

export function usePagination(items, { initialPerPage = 15, resetKey } = {}) {
  const [page, setPage] = useState(1);
  const [perPageChoice, setPerPage] = useState(initialPerPage);   // a number, or 'all'
  const total = items?.length || 0;
  const perPage = perPageChoice === 'all' ? Math.max(total, 1) : perPageChoice;
  const pageCount = Math.max(1, Math.ceil(total / perPage));

  // Filters changed → page 1 during this render (React's "adjust state when
  // props change" pattern), so the old page never flashes.
  const key = resetKey === undefined ? undefined : JSON.stringify(resetKey);
  const [seenKey, setSeenKey] = useState(key);
  const filtersChanged = key !== seenKey;
  if (filtersChanged) {
    setSeenKey(key);
    setPage(1);
  }
  const safePage = filtersChanged ? 1 : Math.min(page, pageCount);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  const pageItems = useMemo(
    () => (items || []).slice((safePage - 1) * perPage, safePage * perPage),
    [items, safePage, perPage]
  );
  return { page: safePage, setPage, perPage, perPageChoice, setPerPage, total, pageCount, pageItems };
}

// Windowed page numbers: 1 … (p-1) p (p+1) … N, first/last always visible.
function pageWindow(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const set = new Set([1, 2, page - 1, page, page + 1, pageCount - 1, pageCount]);
  const nums = [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}

export default function Pagination({ page, setPage, perPage, perPageChoice, setPerPage, total, pageCount, className = '' }) {
  const barRef = useRef(null);
  if (!total) return null;
  const isAll = perPageChoice === 'all';
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const go = (p) => {
    const next = Math.min(Math.max(1, p), pageCount);
    if (next === page) return;
    setPage(next);
    scrollListTop(barRef.current);
  };
  // A page that starts at a size other than 15/50/100 still shows it selected.
  const sizes = [15, 50, 100];
  if (!isAll && !sizes.includes(perPage)) sizes.push(perPage);
  sizes.sort((a, b) => a - b);
  return (
    <div ref={barRef} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 bg-white border-t border-gray-100 text-sm text-gray-600 ${className}`}>
      <span>Showing <b className="text-gray-900">{from}–{to}</b> of <b className="text-gray-900">{total}</b></span>
      <label className="flex items-center gap-1.5">
        Per page:
        <select
          value={isAll ? 'all' : perPage}
          onChange={(e) => {
            setPerPage(e.target.value === 'all' ? 'all' : +e.target.value);
            setPage(1);
          }}
          className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white"
        >
          {sizes.map(n => <option key={n} value={n}>{n}</option>)}
          <option value="all">All ({total})</option>
        </select>
      </label>
      {pageCount > 1 && (
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => go(page - 1)} disabled={page <= 1}
            className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-default">
            ‹ Prev
          </button>
          {pageWindow(page, pageCount).map((n, i) => n === '…'
            ? <span key={`e${i}`} className="px-1.5 text-gray-400">…</span>
            : <button key={n} onClick={() => go(n)}
                className={`min-w-[32px] px-2 py-1 rounded-lg border text-center ${n === page
                  ? 'bg-red-600 border-red-600 text-white font-semibold'
                  : 'border-gray-200 hover:bg-gray-50'}`}>
                {n}
              </button>)}
          <button onClick={() => go(page + 1)} disabled={page >= pageCount}
            className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-default">
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
