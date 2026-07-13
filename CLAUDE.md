# SEPL ERP — engineering conventions

Plain-JS npm monorepo: `server/` (Express + better-sqlite3, CommonJS) and `client/`
(Vite/React). Single PM2 process on a 2-core VPS. There is a **Redis optimization layer**
(cache / queue / real-time). **The golden rule for all of it: Redis is an accelerator,
never a dependency. Correctness must survive Redis being down.**

---

## The fallback-first ethic (read this before adding any Redis/socket code)

1. **Never make correctness depend on Redis.** Every cached read must fall back to the
   direct SQLite query; every socket push must have a REST/poll path that already works
   without it. If you removed Redis entirely, the feature must still be *correct* — just
   slower. This is enforced in code: `cache.getOrSet` runs the loader when Redis is down,
   `emitTo`/`broadcast` no-op when the socket layer is down, and `ERP_DISABLE_REDIS=1` is a
   production kill-switch that reverts everything to pre-Redis behavior with no redeploy.
2. **All Redis access is fallback-safe by construction.** Use the helpers below — never call
   `ioredis` directly from a route, and never `await` a raw Redis command on a request path
   without a try/catch that degrades to the DB.
3. **All keys go through `cacheKeys.js`.** Never hand-build a key string. This keeps the
   multi-tenant seam (`tenantScope()`) working — one day it returns a tenant id and every
   key partitions automatically.
4. **Best-effort side channels never block or fail a write.** A cache invalidation or a
   socket emit must never throw into, delay, or fail the user's actual request.

---

## Caching reads (Workstream 3 pattern)

Helpers: [`server/lib/cache.js`](server/lib/cache.js), [`server/lib/cacheKeys.js`](server/lib/cacheKeys.js).

```js
const cache = require('../lib/cache');
const cacheKeys = require('../lib/cacheKeys');

// Read: try cache, else run the loader (the real query) and cache its JSON.
// Fallback-safe: if Redis is down, it just returns loader().
const data = await cache.getOrSet(cacheKeys.ref('vendors', 'active'), 3600,
  () => getDb().prepare('SELECT * FROM vendors WHERE active=1').all());
```

**When to cache:** slow-moving reads that repeat — user permissions, `app_settings`, heavy
dashboards, static reference lists (dropdowns). **Do NOT cache** fast-changing transactional
data (orders, cashflow entries, attendance pings) or tiny hot tables where the query is
already microseconds (e.g. `geofence_settings`) — caching there adds risk for no gain.

**Handlers that call `getOrSet` become `async`.** Wrap the existing body in the loader and
`res.json(result)` at the end.

**TTL choice:** stale-tolerant management views → TTL-only, no invalidation (dashboards:
45–180 s). Data users expect immediately → longer TTL **plus** invalidation on write.

**Invalidation — three patterns, pick the narrowest that's correct:**
- **Write-through** (single owner of the value): `setSetting` writes SQLite then
  `cache.del(key)`. See [`server/lib/settings.js`](server/lib/settings.js).
- **Mutation hook** (many write endpoints on one router): bust on any successful non-GET.
  Scope it to a path prefix if the router does more than the cached thing, and EXCLUDE any
  non-GET that doesn't change the cached set. Examples: item-master dropdown
  ([`itemmaster.js`](server/routes/itemmaster.js)), vendors ([`procurement.js`](server/routes/procurement.js) — scoped to `/vendors`),
  announcements (excludes `/mark-seen`).
  ```js
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.on('finish', () => { if (res.statusCode < 400) cache.delByPrefix(cacheKeys.ref('thing')); });
    }
    next();
  });
  ```
- **TTL-only** (staleness acceptable): no invalidation; the TTL bounds it.

Use `cache.del(key)` for one key, `cache.delByPrefix(prefix)` for all variants of a key
(SCAN-based; never `KEYS`). Both no-op when Redis is down.

**Permissions** are cached in [`server/middleware/auth.js`](server/middleware/auth.js):
`getUserPermissionsCached(userId)`, invalidated by `invalidateUserPermissions(id)` /
`invalidateAllPermissions()`. If you add an endpoint that changes a user's roles or a role's
permissions, call the matching invalidator.

---

## Real-time push (Workstream 6 pattern)

Helpers in [`server/lib/chatSocket.js`](server/lib/chatSocket.js): `emitTo(room, event, payload)`
(one room), `broadcast(event, payload)` (all clients). Rooms joined on connect: `u:<uid>`
(personal), `g:<gid>` (chat groups), `all` (everyone), `role:admin` (admins).

```js
const { emitTo, broadcast } = require('../lib/chatSocket');
emitTo('role:admin', 'location:ping', { userId, lat, lng });  // admins only
broadcast('announcement:changed');                             // everyone
```

**Rules for real-time features:**
- The socket push is a **hint to refresh, not the source of truth.** The client re-fetches
  from REST on the event. Never send authoritative state that only arrives via socket.
- **Always keep a fallback poll** on the client (a timer that still updates when the socket
  is down) — see the existing `setInterval` fallbacks in `AnnouncementBell.jsx`,
  `HR.jsx` (ManpowerTab), `Locations.jsx`.
- **Coalesce bursts.** High-frequency events (e.g. location pings from many users) must be
  debounced client-side into one refresh — don't refetch per event.
- Server emits are **best-effort**: fire after the DB write succeeds, never before, never
  awaited, never able to fail the request.

**Client side:** use the shared socket via `useAppSocket()`
([`client/src/context/SocketProvider.jsx`](client/src/context/SocketProvider.jsx)):
```js
const { subscribe } = useAppSocket();
useEffect(() => subscribe('announcement:changed', reload), [subscribe]); // returns unsubscribe
```
Do NOT open a new `io()` connection for a feature — reuse the shell socket. (The chat PAGE
is the one intentional exception.)

---

## Background jobs (Workstream 1 — BullMQ)

Heavy/slow work (Excel export/import, notification fan-out) goes to a BullMQ queue, NOT inline
on the request. Enqueue via [`server/jobs/queue.js`](server/jobs/queue.js) when Redis + a live
worker are present, else run the existing inline path as the fallback. Keep the heavy logic in
one shared function called by both the processor and the fallback (e.g. `runPushFanout` in
[`push.js`](server/lib/push.js), `buildQuotationBuffer` in
[`jobs/lib/quotationExcel.js`](server/jobs/lib/quotationExcel.js)).

**The worker runs EMBEDDED in the API process** ([`server/jobs/workerRuntime.js`](server/jobs/workerRuntime.js),
started from [`index.js`](server/index.js)) — no separate `erp-worker` PM2 app on this
single-fork 2-core box. IO-bound jobs (push fan-out) run in-process; the CPU-bound Excel build
runs as a BullMQ **sandboxed processor** (a child process with its own heap, so it can't OOM
the API). A **sandboxed processor file must stay Redis-free** — require
[`jobs/paths.js`](server/jobs/paths.js) for `GENERATED_DIR`, never `jobs/queue.js`, or every
child fork opens a Redis connection. `server/worker.js` still exists as a **standalone**
entrypoint for the future PM2 **cluster mode** split (set `ERP_EMBED_WORKER=0` on the API and
run it as its own app so N API instances share one queue drain). Same fallback ethic applies:
if Redis/worker is down, `enqueue`/`runFileJob` return false/null and the caller runs inline.

---

## Keys, config, testing

- **Key builder:** `cacheKeys.js` — `perms(id)`, `setting(name)`, `dash(name, days)`,
  `ref(name, ...variant)`, `chatUnread(id)`, `presence/presenceHb`, `workerAlive`. Add new key
  types here, never inline.
- **Env** (`.env`): `REDIS_URL`, `REDIS_KEY_PREFIX`, `PRESENCE_TTL_SEC`, and kill-switches
  `ERP_DISABLE_REDIS` / `ERP_DISABLE_JOB_QUEUE` (plus `ERP_EMBED_WORKER`, default 1).
- **Local dev:** the app runs fine with NO Redis (fallback mode). To test the cached/real-time
  paths, run a local Redis (WSL2 `apt install redis-server`, or Docker `redis:7`) at
  `localhost:6379`.
- **Testing a Redis/socket change — always verify BOTH paths:** (1) Redis/socket UP — the
  accelerated path works; (2) Redis/socket DOWN (`ERP_DISABLE_REDIS=1`) — the feature is still
  correct. A change that only works with Redis up is a regression. Prove invalidation actually
  fires (stale-after-write is the classic bug). Keep test fixtures self-cleaning (delete any
  throwaway rows you insert).

---

## General repo conventions

- Match the surrounding file's style: heavy explanatory comments (the "why", often dated),
  lean dependencies, degrade-gracefully everywhere (see `rateLimit.js`, the compression
  try/catch in `index.js`).
- Two SQLite DBs: `erp.db` ([`db/schema.js`](server/db/schema.js)) and `chat.db`
  ([`db/chatDb.js`](server/db/chatDb.js)) — kept separate on purpose; no cross-DB joins.
- better-sqlite3 is **synchronous**; the only reason a route becomes `async` is an `await`
  on the cache. Keep the DB calls synchronous inside the loader.
- Deploy (routine): on the VPS run **`bash scripts/deploy.sh`** — the single source of
  truth. It pulls, `npm install`s (rebuilds the client), `pm2 startOrReload`s the single
  **`erp`** app (which embeds the BullMQ worker in-process), and runs the smoke test.
  First-time Redis setup is a one-time `sudo bash scripts/setup-redis.sh`. Full runbook:
  [`docs/REDIS_DEPLOY.md`](docs/REDIS_DEPLOY.md). No schema migration should be required by
  a caching/real-time change.
