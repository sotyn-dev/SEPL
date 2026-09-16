// Tiny read-through cache for expensive, user-independent read work.
//
// Why (hang audit 2026-09-05): the server is ONE synchronous-SQLite process,
// so an expensive read that several endpoints repeat back-to-back (the RACI
// module row-sets, recomputed once per user × week inside the leaderboard,
// ~100 times per request) blocks every other user for the whole repeat.
//
// Correctness: entries live at most TTL_MS, AND `invalidateAll()` is called
// from the audit middleware on every mutating request (POST/PUT/PATCH/DELETE),
// so a read after a write is always fresh. The cache only ever serves data
// that was computed after the most recent write.
const TTL_MS = 15 * 1000;
const store = new Map(); // key -> { value, at }

function memo(key, fn, ttl = TTL_MS) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttl) return hit.value;
  const value = fn();
  store.set(key, { value, at: now });
  return value;
}

function invalidateAll() { store.clear(); }
function invalidate(prefix) { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); }
function stats() { return { entries: store.size, ttl_ms: TTL_MS }; }

module.exports = { memo, invalidateAll, invalidate, stats, TTL_MS };
