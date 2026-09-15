// Bring the top of a paged list back into view after its page changes.
//
// Both pagers (components/Pagination.jsx, components/PaginationBar.jsx) sit
// UNDER their list. Without this, clicking "2" at the bottom renders page 2
// but leaves the user scrolled at the bottom of it, with the new page's first
// rows off the top of the screen (pagination audit, mam 2026-09-10).
//
// The bar doesn't know which element is "its" list, so it looks at what sits
// just before it in the page:
//   - a run of look-alike cards (mobile card lists) → the first card;
//   - otherwise the visible block right above (the table wrapper).
// Hidden twins (md:hidden cards on desktop, hidden md:block tables on phones)
// have no height and are skipped. It only scrolls when that top is actually
// out of view, and a bounded table box (max-h + overflow) restarts at its top.

const visiblePrev = (el) => {
  let p = el.previousElementSibling;
  while (p && !p.offsetHeight) p = p.previousElementSibling;
  return p;
};

const sameKind = (a, b) => !!a && !!b && a.tagName === b.tagName && a.className === b.className;

function listAnchor(barEl) {
  for (let el = barEl; el && el.parentElement; el = el.parentElement) {
    const p1 = visiblePrev(el);
    if (!p1) continue;                        // nothing before at this level — look one level up
    if (sameKind(p1, visiblePrev(p1))) {
      let first = p1;
      for (let q = visiblePrev(first); sameKind(q, p1); q = visiblePrev(q)) first = q;
      return first;
    }
    if (p1.offsetHeight > barEl.offsetHeight) return p1;
  }
  return null;
}

// Must ACTUALLY scroll: overflow-x-auto alone computes overflow-y to "auto"
// too, so a wrapper that never scrolls would otherwise be taken for the page's
// scroll area and the list would never be brought back into view.
const scrollsY = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight;

export function scrollListTop(barEl) {
  if (!barEl || typeof window === 'undefined') return;
  // Wait for the new page to render before measuring. A 0 ms timer, not
  // requestAnimationFrame: rAF never fires in a background / hidden tab, so the
  // list would silently stay scrolled at the bottom there.
  setTimeout(() => {
    const anchor = listAnchor(barEl);
    if (!anchor) return;
    if (scrollsY(anchor) && anchor.scrollTop) anchor.scrollTop = 0;
    anchor.querySelectorAll('.overflow-auto, .overflow-y-auto, .table-responsive').forEach((box) => {
      if (box.scrollTop) box.scrollTop = 0;
    });
    let scroller = anchor.parentElement;
    while (scroller && !scrollsY(scroller)) scroller = scroller.parentElement;
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    if (anchor.getBoundingClientRect().top < viewTop) anchor.scrollIntoView({ block: 'start' });
  }, 0);
}
