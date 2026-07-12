// The ONE place every Redis key string is built. Centralising key construction
// buys two things:
//   1. No stringly-typed key typos scattered across routes — a key is always
//      cacheKeys.perms(id), never a hand-written `'perms:'+id` that might drift.
//   2. The multi-tenant seam. Today tenantScope() returns 'global', so every key
//      looks like  sepl:t:global:perms:42 . When we go multi-tenant, tenantScope()
//      is changed in ONE place to return the current request's tenant id, and
//      EVERY key below — cache, chat buffer, presence, dashboards, reference data
//      — becomes tenant-scoped automatically (e.g. sepl:t:7:presence). No caller
//      changes. This is the "tenant_id prefix drops in with a one-line change"
//      requirement made concrete.
//
// Pure string building — no Redis, no I/O — so it's safe to require anywhere.

const PREFIX = process.env.REDIS_KEY_PREFIX || 'sepl';

// Multi-tenant seam. Returns the scope segment placed after `<prefix>:t:` in
// every key. 'global' today (single tenant); the tenant migration makes this
// return the active tenant id (e.g. from async-local-storage / the request), and
// all keys partition by tenant with zero changes at the call sites.
function tenantScope() {
  return 'global';
}

// Join parts into a namespaced, tenant-scoped key. Every builder below goes
// through this so the shape (<prefix>:t:<scope>:...) is guaranteed consistent.
const k = (...parts) => [PREFIX, 't', tenantScope(), ...parts].join(':');

module.exports = {
  // --- Read cache (Workstream 3) ---
  perms:      (userId)     => k('perms', userId),                 // cached user permission object
  setting:    (name)       => k('setting', name),                 // cached app_settings value
  dash:       (name, days) => (days != null ? k('dash', name, days) : k('dash', name)), // dashboard metrics, keyed by window
  ref:        (name, ...variant) => k('ref', name, ...variant),   // static reference data (vendors, geofence, ...)

  // --- Chat buffering (Workstream 2) ---
  chatBuffer: (groupId)    => k('chat', 'buf', groupId),          // Redis List of un-flushed messages for a group
  chatDirty:  ()           => k('chat', 'dirty'),                 // Set of group ids awaiting flush
  chatSeq:    ()           => k('chat', 'seq'),                   // INCR counter — allocates final message ids

  // --- Presence (Workstream 4) ---
  presence:   ()           => k('presence'),                      // Set of online user ids
  presenceHb: (userId)     => k('presence', 'hb', userId),        // per-user heartbeat key (TTL = crash-safe expiry)

  // --- Background jobs (Workstream 1) ---
  workerAlive: ()          => k('jobs', 'worker-alive'),          // TTL heartbeat the worker refreshes; API gates enqueue on it

  // exported so callers that need a prefix scan (delByPrefix) can build one,
  // and for tests asserting the tenant seam.
  _prefixForScope: (...parts) => k(...parts),
  tenantScope,
};
