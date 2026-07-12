// TTL read-cache helper — the workhorse of Workstream 3.
//
// getOrSet(key, ttl, loader) is the whole idea: try Redis, and on a miss OR any
// Redis trouble at all, run the loader (a direct SQLite query) and return that.
// So a route wrapped in getOrSet behaves EXACTLY as it does today when Redis is
// down — same query, same result — just without the cache. Correctness never
// depends on Redis; only speed does.
//
// Everything here is fallback-safe: no function throws because Redis is
// unavailable. A Redis error is logged (once, softly) and swallowed so the
// request continues on the direct path.

const { getRedis, isRedisReady } = require('./redis');

let _warned = false;
function softWarn(where, err) {
  if (!_warned) {
    console.warn(`[cache] ${where} — serving uncached from SQLite:`, err && err.message);
    _warned = true;   // avoid log spam during an outage; reset is fine to skip
  }
}

// Get key from cache; on miss run loader(), cache its JSON with a TTL, return it.
// - ttlSeconds: expiry for the cached value (the "1-hour TTL" etc. from the plan)
// - loader: async or sync fn that produces the fresh value (the real DB read)
// Guarantees: if Redis isn't ready, or GET/SET/parse fails, we just return
// loader() — never throw, never block on Redis.
async function getOrSet(key, ttlSeconds, loader) {
  if (!isRedisReady()) return loader();
  const redis = getRedis();
  if (!redis) return loader();

  // Try the cache first. A parse/GET failure must not break the request.
  try {
    const hit = await redis.get(key);
    if (hit != null) {
      try { return JSON.parse(hit); }
      catch (_) { /* corrupt/legacy value — fall through and recompute */ }
    }
  } catch (err) {
    softWarn(`get ${key}`, err);
    return loader();   // Redis unreachable mid-flight → direct path
  }

  // Miss (or unparseable): compute fresh, then best-effort cache it.
  const value = await loader();
  try {
    // Don't cache undefined (JSON.stringify → undefined → Redis error); null is fine.
    if (value !== undefined) {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }
  } catch (err) {
    softWarn(`set ${key}`, err);   // couldn't cache — the value is still returned
  }
  return value;
}

// Invalidate a single key (call after a write that changes the cached data).
// No-op when Redis is down — the TTL will bound staleness anyway.
async function del(key) {
  if (!isRedisReady()) return;
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(key); } catch (err) { softWarn(`del ${key}`, err); }
}

// Invalidate every key under a prefix (e.g. all `ref:vendors*` variants after a
// bulk import). Uses SCAN (never KEYS — KEYS blocks the Redis event loop) and
// deletes in batches. Best-effort; no-op / swallow on any error.
async function delByPrefix(prefix) {
  if (!isRedisReady()) return;
  const redis = getRedis();
  if (!redis) return;
  const match = `${prefix}*`;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    softWarn(`delByPrefix ${prefix}`, err);
  }
}

module.exports = { getOrSet, del, delByPrefix };
