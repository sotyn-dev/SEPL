import { useState, useEffect, useCallback } from 'react';
import api from '../api';

// Shared, self-fetching + cached department-tree source for <DepartmentPicker>
// and the OrgStructure page — same split as usePeopleOptions/PeoplePicker: the
// hook owns fetching + caching, the picker is pure. GET /org-structure/departments
// returns the NESTED tree (roots[] with .children); ?activeOnly=1 for pickers.
//
// Invalidation: any org mutation fires window.dispatchEvent(new Event('departments:refresh'))
// (see OrgStructure page) so open pickers refetch; refresh() is the manual hook.

const cache = new Map();     // key -> { tree }
const inflight = new Map();  // key -> Promise<tree>

const keyOf = (activeOnly) => (activeOnly ? 'active' : 'all');

async function load(activeOnly) {
  const key = keyOf(activeOnly);
  if (cache.has(key)) return cache.get(key).tree;
  if (inflight.has(key)) return inflight.get(key);
  const p = api.get(`/org-structure/departments${activeOnly ? '?activeOnly=1' : ''}`)
    .then(res => {
      const tree = Array.isArray(res.data) ? res.data : [];
      cache.set(key, { tree });
      inflight.delete(key);
      return tree;
    })
    .catch(err => { inflight.delete(key); throw err; });
  inflight.set(key, p);
  return p;
}

export function invalidateDepartments() {
  cache.clear();
  inflight.clear();
  window.dispatchEvent(new Event('departments:refresh'));
}

// Flatten a nested tree into ordered rows with a `depth` for indentation.
// `excludeId` drops that node AND its whole subtree (used by "move to…" so a
// department can't be reparented under itself or a descendant).
export function flattenTree(tree, excludeId = null) {
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      if (excludeId != null && n.id === excludeId) continue;   // skip self + subtree
      out.push({ ...n, depth });
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

export default function useDepartmentTree({ activeOnly = false } = {}) {
  const key = keyOf(activeOnly);
  const [state, setState] = useState(() => {
    const cached = cache.get(key);
    return cached ? { key, tree: cached.tree, loading: false, error: null } : { key, tree: [], loading: true, error: null };
  });

  useEffect(() => {
    let alive = true;
    load(activeOnly)
      .then(tree => { if (alive) setState({ key, tree, loading: false, error: null }); })
      .catch(() => { if (alive) setState(s => ({ ...s, key, loading: false, error: 'load-failed' })); });
    return () => { alive = false; };
  }, [key, activeOnly]);

  useEffect(() => {
    const onBus = () => {
      cache.delete(key); inflight.delete(key);
      load(activeOnly)
        .then(tree => setState({ key, tree, loading: false, error: null }))
        .catch(() => setState(s => ({ ...s, key, loading: false, error: 'load-failed' })));
    };
    window.addEventListener('departments:refresh', onBus);
    return () => window.removeEventListener('departments:refresh', onBus);
  }, [key, activeOnly]);

  const refresh = useCallback(() => {
    cache.delete(key); inflight.delete(key);
    setState(s => ({ ...s, loading: true, error: null }));
    load(activeOnly)
      .then(tree => setState({ key, tree, loading: false, error: null }))
      .catch(() => setState(s => ({ ...s, key, loading: false, error: 'load-failed' })));
  }, [key, activeOnly]);

  return { tree: state.tree, loading: state.loading, error: state.error, refresh };
}
