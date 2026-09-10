// PaginationBar (mam 2026-09-01): the "truncated numbered pagination" bar —
// "Showing 1–15 of 346 · Per page [15▾] · ‹ Prev 1 2 … 23 24 Next ›" —
// rolled out to the 19 big list pages. Client-side slicing: pages already
// load their full filtered list, the hook just windows what is RENDERED, so
// search/filter/export keep working on the complete list.
//
// NOT the same as components/Pagination.jsx: that older sibling is a PLAIN
// FUNCTION (hook-free on purpose — Procurement.jsx calls it inside per-tab
// IIFEs) with parent-held page state, and Procurement + UserManagement still
// use it. This one is a real hook that owns its own state, so it must be
// called unconditionally at component top level. Styling matches the old bar
// (red active page, Per page 15/50/100/All).
//
// Usage:
//   const pager = usePagination(filteredRows);          // default 15/page
//   ...render pager.pageItems instead of filteredRows...
//   <Pagination {...pager} />
//
// Rules baked in:
// - Auto-snaps back to page 1 when the list shrinks under the current page
//   (a filter/search change never leaves you stranded on an empty page).
// - Renders on BOTH the desktop table and the md:hidden mobile cards —
//   paginate the SHARED list once, above the two renders (mobile↔desktop
//   control parity, mam 2026-07).
// - CSV "Export" must keep using the FULL filtered list, never pageItems.
import { useEffect, useMemo, useState } from 'react';

export function usePagination(items, { initialPerPage = 15 } = {}) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(initialPerPage);
  const total = items?.length || 0;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pageCount);
  useEffect(() => { if (page > pageCount) setPage(1); }, [page, pageCount]);
  const pageItems = useMemo(
    () => (items || []).slice((safePage - 1) * perPage, safePage * perPage),
    [items, safePage, perPage]
  );
  return { page: safePage, setPage, perPage, setPerPage, total, pageCount, pageItems };
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

export default function Pagination({ page, setPage, perPage, setPerPage, total, pageCount, className = '' }) {
  if (!total) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const go = (p) => setPage(Math.min(Math.max(1, p), pageCount));
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 bg-white border-t border-gray-100 text-sm text-gray-600 ${className}`}>
      <span>Showing <b className="text-gray-900">{from}–{to}</b> of <b className="text-gray-900">{total}</b></span>
      <label className="flex items-center gap-1.5">
        Per page:
        <select
          value={perPage >= total ? 'all' : perPage}
          onChange={(e) => {
            // 'All' = one page holding everything (same trick as the classic
            // components/Pagination.jsx so both bars behave identically).
            setPerPage(e.target.value === 'all' ? Math.max(total, 1) : +e.target.value);
            setPage(1);
          }}
          className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white"
        >
          {[15, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
          <option value="all">All ({total})</option>
        </select>
      </label>
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
    </div>
  );
}
