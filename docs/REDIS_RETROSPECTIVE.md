# Redis Optimization Layer — Retrospective

_Written 2026-07-12, after the `feat/redis-optimization-layer` branch was committed and
re-verified end-to-end. This is the honest "was it worth it" log: what each piece actually
bought us, what is real today vs. latent groundwork, and what was deferred or left inert._

> **The one-line verdict:** Yes — fruitful, and safely so. The layer removes real hot paths
> off SQLite and the request event loop, and because every path has a proven inline fallback
> (`ERP_DISABLE_REDIS=1` reverts to pre-Redis behavior), the downside is bounded: if Redis
> dies, the app is slower, never wrong. The biggest _unrealized_ value is the multi-instance
> groundwork, which only pays out the day a second app instance is deployed.

---

## What shipped (five accelerator pieces)

| # | Piece | What it does |
|---|-------|--------------|
| 1 | **Read caching** | Caches slow-moving reads (permissions, `app_settings`/ICE, heavy dashboards, item-master + vendor dropdowns, announcement bell) with TTLs and, where needed, write-invalidation. |
| 2 | **Real-time push** | Socket.IO pushes replace three timer-polls (live location map, HR manpower board, announcement bell). Polls kept as the socket-down fallback. |
| 3 | **Socket.IO Redis adapter** | Chat + call signalling fan out across instances via Pub/Sub. Falls back to the in-memory adapter (single instance) when Redis is absent. |
| 4 | **Presence + ring timeout** | TTL-heartbeat presence (crash- & multi-tab-safe); offline short-circuit and 30s no-answer auto-cancel on calls. |
| 5 | **`erp-worker` (2nd PM2 app)** | BullMQ worker moves push fan-out and the quotation Excel export off the API event loop; identical inline fallback when the worker/Redis is down. |

Foundation under all of it: `server/lib/redis.js` (never-throws connection singleton + kill-switch),
`cache.js` (`getOrSet`/`del`/`delByPrefix`, all fallback-safe), `cacheKeys.js` (single key builder
with the `tenantScope()` multi-tenant seam), `server/jobs/queue.js` (enqueue-or-fallback gate).

---

## Per-piece verdict

Ratings: **Win** (helping in production today) · **Latent** (built & correct, but the
condition that makes it valuable isn't present yet) · **Inert** (scaffolded, not wired).

| Piece | Hot path removed / UX gained | Rating |
|-------|------------------------------|--------|
| Permission cache (`middleware/auth.js`) | A `role_permissions × user_roles` JOIN that ran on **every authenticated request** → one cached object (1h TTL), invalidated on role/perm change. Highest-frequency win. | **Win** |
| `app_settings` + `/ice` TURN cache | Per-call-setup settings reads served from cache instead of SQLite. | **Win** |
| Dashboard caching (home 45s; KPI/CMD/collections 180s) | Heavy aggregate payloads recomputed at most once per TTL instead of per view. Audit-KPI shares the in-app key, so the daily automated caller reuses the same payload. | **Win** |
| Item-master dropdown (30m) + vendor list (1h) | A `GROUP BY` over ~2,300 item rows, hit from 8 pages, cached with a mutation-hook that busts all variants on write. Verified: stale-after-write is avoided. | **Win** |
| Announcement bell (5m set + in-memory badge) | A per-user `COUNT` on every bell poll → one cached set reduced in memory per user; busts on create/edit/delete, **not** on mark-seen. | **Win** |
| Real-time push (location / HR board / bell) | Replaced three always-on polls with event-driven refresh; polls remain as fallback so nothing breaks when the socket is down. | **Win** |
| Push fan-out off the event loop | Notification fan-out no longer blocks the request that triggered it; runs on the `notifications` queue (concurrency 5), inline fallback intact. | **Win** |
| Quotation Excel export off the event loop | The heaviest CPU task (styled XLSX build) runs on the `files` queue (concurrency 2). Client contract unchanged (POST → streamed `.xlsx`). Worker-built and inline builds are byte-identical. | **Win** |
| Socket.IO Redis adapter | Correct cross-instance delivery — but the deployment still runs **single-instance**, so it changes nothing today. | **Latent** |
| Presence (TTL heartbeat) | Crash-/multi-tab-safe and multi-instance-safe by design; the multi-instance safety only matters once there's a 2nd instance. Offline short-circuit + ring timeout are live UX wins today. | **Win (UX) / Latent (multi-instance)** |
| Chat write-buffering (Workstream 2) | **Never implemented.** `chatBuffer/chatDirty/chatSeq` keys are declared but unused; `CHAT_FLUSH_MS` and `ERP_DISABLE_CHAT_BUFFER` have no readers. Chat writes go straight to `chat.db`. | **Inert** |
| Phase 1D follow-ups (geofence, solar rate-book, scoring templates, pipe-weights, warehouses) | Intentionally deferred. `geofence_settings` excluded on purpose (safety-critical punch path, not worth the async-conversion risk). | **Deferred (by design)** |

**Net:** 8 clear production wins, 2 latent (adapter + presence's multi-instance dimension),
1 inert (chat buffering), plus deliberate deferrals. Of the four advertised kill-switches,
**two are functional** (`ERP_DISABLE_REDIS`, `ERP_DISABLE_JOB_QUEUE`); `ERP_DISABLE_CHAT_BUFFER`
is a no-op today and should be documented as reserved (it already is, in `REDIS_DEPLOY.md`).

---

## Costs (the honest other side)

- **~2,384 added lines / 42 files** — a new subsystem (`server/lib/` Redis helpers,
  `server/jobs/` queue + processors) and a **second PM2 process** (`erp-worker`) to run,
  watch, and reason about on a 2-core / 8 GB VPS.
- **New operational surface:** a Redis server to install and keep alive, a required
  `maxmemory-policy noeviction` (so the job queue is never evicted), and a deploy runbook.
  Mitigated by: one-time `scripts/setup-redis.sh`, routine `scripts/deploy.sh`, and
  `redis-smoke.js` as a post-deploy check.
- **More async:** several handlers became `async` (permissions, settings, dropdowns).
  Contained, but it's real surface area where a missed `await` could bite.
- **Cognitive load:** every cached read now has an invalidation story to keep correct
  (the classic trap). CLAUDE.md's fallback-first rules exist precisely to bound this.

These costs are justified by the fallback-first design: the layer can be switched off
entirely with one env var and no redeploy, so the risk it adds is capped.

---

## Bottom line

The bet paid off. The caching and off-loop work attack genuinely hot paths (an every-request
permission JOIN, repeated heavy aggregates, a ~2,300-row dropdown, CPU-bound Excel builds),
and the real-time push removes standing poll load while keeping polls as a safety net. None
of it makes correctness depend on Redis — verified below on both paths.

The clearest place value is still **on the table** is the multi-instance groundwork
(Redis adapter + presence). It's built and correct but dormant while we run one instance.
If/when load justifies a second `erp` instance, that work converts from _latent_ to _win_
with no further code. Until then, the one piece of dead weight to be aware of is the
**inert chat write-buffering scaffolding** — either finish it or delete the keys/env vars in
a future cleanup so the layer doesn't advertise a capability it doesn't have.

---

## Verification evidence (2026-07-12, both paths)

Re-verified after the merge from `main`, on the dev box (Node 18, Docker `redis:7` for the
up-path). No production code changed; the live dev DB row counts were identical before and
after (`users=3`, `item_master=2385`, …); the throwaway Redis container was removed.

**Static:** `node --check` passes on all 7 new libs (`redis`, `cache`, `cacheKeys`,
`settings`, `chatSocket`, `jobs/queue`, `worker`).

**Fallback path — Redis DOWN (`ERP_DISABLE_REDIS=1`):**
- `redis-smoke.js` degrades gracefully (detects Redis-not-ready, exits clean, no crash).
- API boots; authenticated sweep = **12/14 endpoints healthy**, including both cached routes
  (`/procurement/vendors`, `/announcements`). The 2 misses are pre-existing route shapes
  (`orders` has no root `GET`; `expenses` isn't mounted on this branch) — not fallback
  regressions.

**Accelerated path — Redis UP (`redis:7` + both PM2 apps):**
- `redis-smoke.js` → **4/4 pass**: connectivity, cache read/cache/invalidate
  (`loaderRuns=1`, del empties), worker heartbeat present, files-job processed by the worker
  (**168 KB valid `.xlsx`**, `PK` magic).
- `delByPrefix` multi-variant invalidation → **PASS**: 3 cached dropdown variants all busted
  in one call, re-read triggered a fresh loader — the item-master mutation-hook mechanism
  works and stale-after-write is avoided.

**Known gap (confirmed, expected):** Workstream 2 chat write-buffering is inert — no readers
for the chat-buffer keys, `CHAT_FLUSH_MS`, or `ERP_DISABLE_CHAT_BUFFER`. *(Resolved 2026-07-14
— see addendum below.)*

---

## Addendum — 2026-07-14

Two follow-ups from this retrospective's own recommendations landed:

- **`erp-worker` collapsed into the API.** The separate PM2 worker app was overkill for the
  single-fork 2-core box. The BullMQ worker now runs **embedded** in the `erp` process
  (`server/jobs/workerRuntime.js`), with the heavy Excel export as a **sandboxed child process**
  (own heap, can't OOM the API). `server/worker.js` is kept as a thin standalone shell for the
  future PM2 cluster-mode split (`ERP_EMBED_WORKER=0` + a separate app). Net −57 lines.

- **Inert chat write-buffering scaffolding removed; chat read-caching added instead.** Per the
  "either finish it or delete the keys/env vars" note above, the unused `chatBuffer/chatDirty/chatSeq`
  keys, `CHAT_FLUSH_MS`, and the no-op `ERP_DISABLE_CHAT_BUFFER` kill-switch were deleted. In
  their place, the **hottest chat read** — the `/unread-count` sidebar badge poll (every ~25 s,
  every page, every user) — is now cached per user (`cacheKeys.chatUnread`, 120 s TTL) with
  best-effort invalidation on the writes that change it. This is fallback-safe (Redis down ⇒ the
  same query runs inline) and avoids the write-behind buffer's data-loss risk. So the layer no
  longer advertises a chat-write capability it never had; the chat acceleration that shipped is
  read-caching + delivery/presence, not write-buffering.
