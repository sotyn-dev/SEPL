import { useState, useEffect, useCallback } from 'react';
import api from '../api';

// Shared, self-fetching + cached people source for <PeoplePicker>.
//
// Why a module-level cache: a single OrgStructure / employee-form screen can
// mount several pickers at once (set-head, reports-to, linked-user). Without a
// shared cache each would fire its own /auth/users or /hr/employees call. Here
// the FIRST consumer of a given (kind|activeOnly) key triggers exactly one
// network request; every other picker on the page awaits the same in-flight
// promise (or reads the resolved rows). Keyed by kind+activeOnly so the
// active-only and all variants don't clobber each other.
//
// Invalidation: employee-save (and any mutation that changes names/links) fires
//   window.dispatchEvent(new Event('people:refresh'))
// which drops every cache entry so mounted pickers refetch. Callers can also
// call the returned refresh() directly (e.g. the inline retry button).

const cache = new Map();        // key -> { rows }        (resolved, ready to read)
const inflight = new Map();     // key -> Promise<rows>   (dedupes concurrent first-loads)

const keyOf = (kind, activeOnly) => `${kind}|${activeOnly ? 1 : 0}`;

// `lite=1` returns only the non-sensitive picker fields (no phone/salary/role/
// timestamps); see server routes/auth.js + routes/hr.js.
const endpointFor = (kind, activeOnly) =>
  kind === 'employee'
    ? '/hr/employees?lite=1'
    : `/auth/users?lite=1${activeOnly ? '&active_only=1' : ''}`;

// Normalise either source shape into ONE row contract the picker renders:
//   { id, name, email, designation, department, active, dupCount, avatar_url }
// - user  source (/auth/users): designation/department come from the linked
//   employee (hr_designation / hr_department); dupCount = hr_record_count.
// - employee source (/hr/employees): designation/department are the columns;
//   active derives from status; avatar comes from the linked user (may be null).
// Exported so a page holding a LEGACY /auth/users or /hr/employees list (full or
// lite shape) can adapt it straight into <PeoplePicker options={…}/> with no
// re-fetch: `normalizePeople(myUsers, 'user')`. Tolerant of both shapes because
// it only reads fields present in both (extra columns are ignored).
export function normalizePeople(rows, kind = 'user') {
  if (kind === 'employee') {
    return (rows || []).map(e => ({
      id: e.id,
      name: e.name || '',
      email: e.email || '',
      designation: e.designation || '',
      department: e.department || '',
      active: (e.status || 'active') === 'active',
      dupCount: 1,
      avatar_url: e.avatar_url || null,
    }));
  }
  return (rows || []).map(u => ({
    id: u.id,
    name: u.name || '',
    email: u.email || '',
    designation: u.hr_designation || u.designation || '',
    department: u.hr_department || u.department || '',
    active: u.active !== 0,
    dupCount: Number(u.hr_record_count) || 1,
    avatar_url: u.avatar_url || null,
  }));
}

// Always resolves with normalized rows. Cached hits resolve synchronously via
// the async wrapper; concurrent first-loads share one in-flight promise.
async function load(kind, activeOnly) {
  const key = keyOf(kind, activeOnly);
  if (cache.has(key)) return cache.get(key).rows;
  if (inflight.has(key)) return inflight.get(key);
  const p = api.get(endpointFor(kind, activeOnly))
    .then(res => {
      let rows = normalizePeople(res.data, kind);
      // /hr/employees has no server-side active filter — apply it here.
      if (kind === 'employee' && activeOnly) rows = rows.filter(r => r.active);
      cache.set(key, { rows });
      inflight.delete(key);
      return rows;
    })
    .catch(err => { inflight.delete(key); throw err; });
  inflight.set(key, p);
  return p;
}

export function invalidatePeople() {
  cache.clear();
  inflight.clear();
  window.dispatchEvent(new Event('people:refresh'));
}

export default function usePeopleOptions(kind = 'user', { activeOnly = true } = {}) {
  const key = keyOf(kind, activeOnly);
  // Lazy init straight from cache — a cached key hydrates with zero flash and,
  // crucially, without any synchronous setState inside an effect.
  const [state, setState] = useState(() => {
    const cached = cache.get(key);
    return cached
      ? { key, rows: cached.rows, loading: false, error: null }
      : { key, rows: [], loading: true, error: null };
  });

  // Fetch on mount / when the key changes. State is only ever set from the
  // async .then/.catch (never synchronously in the effect body) so the
  // react-hooks/set-state-in-effect rule stays satisfied. `state.key` guards
  // against applying a resolved payload after the key changed underneath us.
  useEffect(() => {
    let alive = true;
    load(kind, activeOnly)
      .then(rows => { if (alive) setState({ key, rows, loading: false, error: null }); })
      .catch(() => { if (alive) setState(s => ({ ...s, key, loading: false, error: 'load-failed' })); });
    return () => { alive = false; };
  }, [key, kind, activeOnly]);

  // Global refresh bus: drop this key's cache and refetch silently, swapping
  // rows in when ready (setState here runs in an event callback, not an effect).
  useEffect(() => {
    const onBus = () => {
      cache.delete(key); inflight.delete(key);
      load(kind, activeOnly)
        .then(rows => setState({ key, rows, loading: false, error: null }))
        .catch(() => setState(s => ({ ...s, key, loading: false, error: 'load-failed' })));
    };
    window.addEventListener('people:refresh', onBus);
    return () => window.removeEventListener('people:refresh', onBus);
  }, [key, kind, activeOnly]);

  const refresh = useCallback(() => {
    cache.delete(key); inflight.delete(key);
    setState(s => ({ ...s, loading: true, error: null }));   // event-handler setState: allowed
    load(kind, activeOnly)
      .then(rows => setState({ key, rows, loading: false, error: null }))
      .catch(() => setState(s => ({ ...s, key, loading: false, error: 'load-failed' })));
  }, [key, kind, activeOnly]);

  return { options: state.rows, loading: state.loading, error: state.error, refresh };
}
