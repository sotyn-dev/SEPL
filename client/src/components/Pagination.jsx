// usePagination — slice an array into a page, plus page-nav state.
//
// CRITICAL: this is a PLAIN UTILITY FUNCTION, not a React hook (despite
// the `use` prefix — kept as a naming convention).  Earlier version used
// useMemo internally, which broke when callers invoked it inside
// conditional `{tab === 'X' && (() => { ... })}` IIFEs.  Switching tabs
// changed the order of hook calls and React aborted with Minified error
// #310 ("Rendered more hooks than during the previous render.").
//
// By dropping useMemo, this function is safe to call inside any
// conditional branch — including the per-tab IIFEs in Procurement.jsx.
// The slice + math is cheap enough that memoization wasn't buying us
// anything noticeable anyway.
//
// Usage:
//   const pg = usePagination(rows, 15, page, setPage);
//   return (<>
//     <table>...pg.rows.map(...)</table>
//     <Pagination pg={pg} />
//   </>);
//
// Page state is held by the parent in the form of a `page` number + setter.
// This function is stateless — it just derives the slice indices and
// total pages from the full row count + perPage.  Passing in your own
// useState lets you reset to page 1 when filters change without ceremony.
export function usePagination(rows, perPage, page, setPage) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  // Clamp the requested page to the valid range — protects against the
  // user being on page 5 of a filtered set that just shrank to 2 pages.
  const cur = Math.min(Math.max(1, page), pages);
  const from = (cur - 1) * perPage;
  const to = Math.min(from + perPage, total);
  return {
    page: cur,
    pages,
    perPage,
    total,
    from,
    to,
    setPage,
    rows: rows.slice(from, to),
    hasPrev: cur > 1,
    hasNext: cur < pages,
  };
}

// Pagination — small page-nav strip designed to live under a table.
// Shows "X-Y of Z" + Prev / page numbers / Next.  Hides itself when
// there's only 1 page (no point in rendering 7 dead pixels).
export default function Pagination({ pg, className = '' }) {
  if (!pg || pg.total === 0) return null;
  const { page, pages, total, from, to, setPage, hasPrev, hasNext } = pg;

  // Build a compact page-number list with ellipses for long ranges.
  // For ≤ 7 pages we show them all; beyond that, we collapse the middle.
  const pageNumbers = (() => {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const out = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
    return [...out].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  })();

  return (
    <div className={`flex items-center justify-between gap-2 flex-wrap text-xs text-gray-600 px-2 py-2 ${className}`}>
      <div>
        Showing <span className="font-semibold">{from + 1}</span>–<span className="font-semibold">{to}</span> of <span className="font-semibold">{total}</span>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={!hasPrev}
            className="px-2 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
            ‹ Prev
          </button>
          {pageNumbers.map((n, idx) => {
            const prev = pageNumbers[idx - 1];
            const gap = prev != null && n - prev > 1;
            return (
              <span key={n} className="flex items-center gap-1">
                {gap && <span className="text-gray-400 px-1">…</span>}
                <button
                  type="button"
                  onClick={() => setPage(n)}
                  className={`min-w-[28px] px-2 py-1 rounded border ${n === page ? 'bg-red-600 text-white border-red-600 font-semibold' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                  {n}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={!hasNext}
            className="px-2 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
