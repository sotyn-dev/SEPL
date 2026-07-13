# Redis optimization layer — deploy checklist

This branch adds the Redis accelerator layer (caching, real-time push, chat/call
multi-instance delivery, presence, and an **embedded background worker**). Redis is
an **accelerator, never a dependency** — with Redis off the app runs exactly as
before, just without the speedups. That means a botched Redis step degrades
performance, it does not take the site down.

The BullMQ worker runs **inside the single `erp` process** (no separate PM2 app) —
push fan-out in-process, the heavy Excel build in a short-lived BullMQ sandboxed
child process. **One-time on first deploy of this branch there are extra steps**
(new npm deps + Redis setup). After that, deploys are normal.

---

## TL;DR — the automated way (recommended)

Two scripts do everything below for you. Run them **on the VPS**:

```bash
# 1) ONE TIME — install + configure Redis (needs sudo):
sudo bash scripts/setup-redis.sh

# 2) EVERY DEPLOY — pull, install, reload the erp app, smoke-test:
bash scripts/deploy.sh            # deploys origin/main
bash scripts/deploy.sh <branch>   # deploys a specific branch (until merged)
```

`deploy.sh` is safe to re-run, reloads the single `erp` app (which embeds the
worker), and finishes by running the smoke test — so a green run means everything's live.
If Redis isn't set up yet it still deploys (fallback mode) and tells you to run
`setup-redis.sh`. The sections below explain what those scripts do, plus the
manual verification steps.

---

## 0. What ships

| Piece | Effect |
|-------|--------|
| Read caching | permissions, `app_settings`, heavy dashboards, dropdowns, announcement bell |
| Real-time push | live location map, HR board, announcement bell (polls kept as fallback) |
| Redis adapter | chat + call signalling correct across >1 instance |
| Presence + ring timeout | calls short-circuit offline users; 30 s no-answer auto-cancel |
| **Embedded worker** (in the `erp` process) | durable push-notification fan-out + quotation export **off the API event loop** (Excel via a sandboxed child) |

New env: `REDIS_URL`, `REDIS_KEY_PREFIX`, `PRESENCE_TTL_SEC`, and kill-switches
`ERP_DISABLE_REDIS` / `ERP_DISABLE_JOB_QUEUE`
(plus `ERP_EMBED_WORKER`, default 1 — only set 0 for the cluster-mode split).
New deps: `ioredis`, `bullmq`, `@socket.io/redis-adapter`.

---

## 1. Install + configure Redis (once)

```bash
sudo apt update && sudo apt install -y redis-server
```

Edit `/etc/redis/redis.conf`:

```
bind 127.0.0.1 ::1           # localhost only — do NOT expose Redis publicly
maxmemory-policy noeviction  # REQUIRED: the job queue must never be evicted
# optional, bound memory on the 8 GB box (cache/queue are small):
maxmemory 512mb
```

> `noeviction` is important: under memory pressure Redis must reject writes, not
> silently drop queued jobs / cached keys. The cache tolerates missing keys; the
> queue does not tolerate eviction.

```bash
sudo systemctl enable --now redis-server
redis-cli ping     # -> PONG
```

---

## 2. Configure `.env` (once)

```ini
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=sepl          # optional; namespaces all keys
PRESENCE_TTL_SEC=30
# leave the kill-switches EMPTY to enable Redis:
ERP_DISABLE_REDIS=
ERP_DISABLE_JOB_QUEUE=
```

---

## 3. Deploy

### First deploy of this branch (extra steps)

```bash
cd /root/erp
git fetch origin
git reset --hard origin/main            # (or the feature branch until merged)
npm install                             # installs ioredis/bullmq/adapter + runs the client build (postinstall)
pm2 startOrReload ecosystem.config.js   # starts/reloads the erp app (worker is embedded)
pm2 save                                # persist the app list across reboots
```

> `pm2 save` + an existing `pm2 startup` ensure the app comes back after a VPS
> reboot. There is no separate worker app to start — the `erp` process embeds it.

### Every deploy after that

```bash
cd /root/erp
git fetch origin && git reset --hard origin/main
npm install                             # only needed when dependencies changed
pm2 startOrReload ecosystem.config.js
```

Confirm the app is online and the embedded worker started:

```bash
pm2 status        # expect: erp (online)
pm2 logs erp --lines 20   # expect: "[worker] listening on \"notifications\" queue" + "\"files\" queue"
```

---

## 4. Smoke test (automated)

With Redis up and the `erp` app running:

```bash
node server/scripts/redis-smoke.js
```

Expected — all four pass, exit 0:

```
  ✓ Redis reachable + ready
  ✓ Cache read/cache/invalidate
  ✓ Worker alive (embedded in erp)
  ✓ Files job (export) processed by worker
✓ PASS — 4/4 checks passed
```

It's safe on production: only a throwaway cache key (deleted) and one no-op export
job (temp file auto-deleted); it writes nothing to `erp.db`. A **FAIL** means Redis
acceleration isn't engaged (Redis down, `npm install` not run, or the embedded
worker didn't start) — the app still works via fallbacks, but investigate before
relying on the speedups. Common cause: the `Worker alive` check fails ⇒ the `erp`
app didn't start the worker (check `pm2 logs erp` for `[worker] listening`, and
that `ERP_EMBED_WORKER`/`ERP_DISABLE_JOB_QUEUE` aren't turning it off).

---

## 5. Manual verification (browser)

Do these once after deploy (all have a non-Redis fallback, so they also confirm
nothing regressed):

- [ ] **Login + navigate** — pages load; permissions correct (perms cache).
- [ ] **Announcement bell** — post an announcement; the bell badge updates for
      another logged-in user within a couple seconds (socket) — and still updates
      if you disconnect the socket (60 s poll fallback).
- [ ] **Live location map** (admin → Locations) — a site engineer's ping appears
      near-live.
- [ ] **HR manpower board** — an edit shows up for a second viewer.
- [ ] **Chat** — send a message between two logged-in users; it appears instantly.
- [ ] **Call** — start a call to an **offline** user ⇒ "offline" immediately (no
      endless ringing); call someone who doesn't answer ⇒ auto-cancels at ~30 s.
- [ ] **Quotation export** (Estimator → export) — downloads a valid styled `.xlsx`
      (built by the embedded worker in a sandboxed child; watch `pm2 logs erp` for the job).

---

## 6. Rollback / kill-switches (no redeploy needed)

Redis misbehaving? Flip a switch in `.env` and `pm2 restart erp`:

| Set in `.env` | Effect |
|---------------|--------|
| `ERP_DISABLE_REDIS=1` | Full fallback — cache, sockets adapter, presence, queue all off; app behaves exactly pre-Redis. |
| `ERP_DISABLE_JOB_QUEUE=1` | Jobs run inline (notifications via `setImmediate`, exports built in the API process); cache + sockets stay on. |

Full code rollback: `git reset --hard <previous-commit> && npm install && pm2 startOrReload ecosystem.config.js`.
The embedded worker no-ops if the queue is disabled — the API just runs every job inline.

---

## 7. Monitoring

```bash
pm2 status                          # erp online
pm2 logs erp                        # job completions / failures ([worker] …)
redis-cli info clients              # connected clients
redis-cli --scan --pattern 'sepl:*' | head    # keys in use (cache/presence/jobs)
redis-cli smembers sepl:t:global:presence      # who's online right now
redis-cli exists sepl:t:global:jobs:worker-alive  # 1 = worker heartbeat healthy
```
