// Shared cached reader/writer for the key-value app_settings table (Workstream 3).
//
// app_settings holds slow-moving config: TURN/ICE servers, SMTP, AI provider,
// sentry DSN, plus many one-shot migration flags. The migration flags are read
// once at boot and don't matter here; this helper targets the RUNTIME reads that
// repeat (e.g. /ice on every call setup).
//
// getSetting is cached with a 1-hour TTL and is fallback-safe (cache.getOrSet
// runs the direct SQLite read when Redis is down). setSetting writes SQLite and
// invalidates the cached key, so an in-app config change takes effect at once;
// the TTL bounds staleness even for a value changed directly in the DB.
//
// NOTE: getSetting is async (the cache read is async). Boot-time / synchronous
// callers that can't await should use getSettingDirect (uncached).

const cache = require('./cache');
const cacheKeys = require('./cacheKeys');
const { getDb } = require('../db/schema');

const TTL_SECONDS = 3600;

// Uncached, synchronous read — for boot paths and load-bearing memoized readers
// (jwt_secret, VAPID) that must not depend on Redis or async.
function getSettingDirect(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}

// Cached read (1h TTL). Returns the string value or null. Falls back to the
// direct read when Redis is down.
async function getSetting(key) {
  return cache.getOrSet(cacheKeys.setting(key), TTL_SECONDS, () => getSettingDirect(key));
}

// Write + invalidate. Mirrors the existing upsert shape (key/value/updated_at).
// Best-effort cache.del — a Redis-down invalidate is a no-op and the TTL covers it.
function setSetting(key, value) {
  getDb().prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ).run(key, value);
  cache.del(cacheKeys.setting(key));
}

module.exports = { getSetting, setSetting, getSettingDirect };
