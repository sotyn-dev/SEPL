# Sotyn Platform (control plane)

Boilerplate for `platform.sotyn.com` — org registry, white-label Brand (live), Layer‑1 panel pencils (non-integrated).

**Not** the tenant ERP. Worker agent lives under `worker-agent/` (Docker driver for tenant boxes).

## Pathway (local luxury + Docker tenants)

| Gear | When | How |
|---|---|---|
| **A. Everyday** | Code secured / platform UI | `npm run platform` / ERP `npm run server` — **no Docker** |
| **B. Multitenant smoke** | 2nd org / secured cutover rehearsal | Docker Desktop + `npm run platform:agent` → agent `docker run` with bind-mounts |
| **C. Prod day 1** | VPS | All tenant ERPs in Docker under `TENANTS_ROOT/{slug}/` |

No ERP `DATA_DIR` / DB-opener surgery — isolation is bind-mounts onto container `/app/data` and `/app/backups`.

## Layout

```
platform/
  server/           Express + SQLite (platform.db)
  client/           Super-admin UI (Vite + React)
  seed/tenants/     Seed orgs (sepl branding extracted from ERP)
  contracts/        Branding JSON schema + ERP surface checklist
  worker-agent/     /v1 Docker driver (provision / start / stop / deploy)
```

## Local run

```bash
# one-time deps (run from platform/ — do not npm --prefix from repo root)
cd platform && npm run install:all
cp .env.example .env   # optional; gitignored as platform/.env

# from repo root
npm run platform          # API :7100 + UI :7101

# or separately
npm run platform:server
npm run platform:client
npm run platform:agent    # :7200 Docker driver
```

Local defaults: first boot seeds operator `admin` / `sotyn-dev` with email `sotyn.soft@gmail.com` into `platform_users` (bcrypt). Override with `PLATFORM_ADMIN_USER` / `PLATFORM_ADMIN_PASSWORD` / `PLATFORM_ADMIN_EMAIL` **before first boot**, or change via **Operators → Set password** / login **Forgot password**. See [`platform/.env.example`](.env.example).

Auth: **platform JWT** (`PLATFORM_JWT_SECRET`, persisted in `platform_settings`) — separate from ERP `JWT_SECRET`. Client sends `Authorization: Bearer <token>`.

**Operators (invite / reset / email):** `/operators` — invite creates `/invite/:token` (emailed when SMTP + email set; always copyable once). **Reset link** invalidates the old password and emails when possible. **Forgot password** on login is self-service (does not invalidate until link used). SMTP: `PLATFORM_SMTP_*` — same nodemailer skip-if-unset pattern as ERP `server/lib/email.js`. `PLATFORM_PUBLIC_URL` builds full invite/reset URLs.

Data dir default: `platform/data/platform.db` (gitignored). Seed loads `sepl` on first boot (hostname `secured-erp.sotyn.com`; disk key stays `sepl`). Reset `platform.db` if an old `secured` row remains.

**Brand assets (durable):** uploads write to `platform/data/tenants/{slug}/assets/` (gitignored). Serve order: durable → seed (`platform/seed/tenants/{slug}/assets/`). API: `POST /api/branding/:slug/assets/:kind` multipart field `file` (`logo` | `logoPng` | `icon` | `favicon` | `icons`). Pointers stored in `tenant_branding.assets_json`.

Product mark: `platform/client/public/sotyn-logo.png` (login + header).

## Worker agent — Docker tenant smoke

Prereqs: **Docker Desktop** running; ERP image built once from repo root (multi-stage — builds UI inside Docker, no host `client/dist`):

```bash
docker build -t sotyn-erp:local .
npm run platform:agent
```

Bearer token default: `dev-agent-token` (`AGENT_TOKEN`).

```bash
# health (no auth)
curl -s http://127.0.0.1:7200/v1/health

# provision new org → mkdir tenants/pharma/data + docker run
curl -s -X POST http://127.0.0.1:7200/v1/tenants \
  -H "Authorization: Bearer dev-agent-token" \
  -H "Content-Type: application/json" \
  -d "{\"slug\":\"pharma\"}"

# provision sepl (tenants/sepl/data — same rule as any slug)
curl -s -X POST http://127.0.0.1:7200/v1/tenants \
  -H "Authorization: Bearer dev-agent-token" \
  -H "Content-Type: application/json" \
  -d "{\"slug\":\"sepl\"}"

curl -s http://127.0.0.1:7200/v1/tenants -H "Authorization: Bearer dev-agent-token"
curl -s -X POST http://127.0.0.1:7200/v1/tenants/pharma/stop -H "Authorization: Bearer dev-agent-token"
curl -s -X POST http://127.0.0.1:7200/v1/tenants/pharma/start -H "Authorization: Bearer dev-agent-token"

# remove container; ?wipeData=1 also deletes tenants/{slug}/data
# Deploy never uses wipeData — host data/ is never deleted on deploy/rollback
curl -s -X DELETE "http://127.0.0.1:7200/v1/tenants/pharma?wipeData=1" \
  -H "Authorization: Bearer dev-agent-token"

# Deploy (after you git pull on the host). build:true → docker build tag+latest, recreate all tenants
curl -s -X POST http://127.0.0.1:7200/v1/deploy \
  -H "Authorization: Bearer dev-agent-token" \
  -H "Content-Type: application/json" \
  -d "{\"tag\":\"11-08-2026-v1\",\"build\":true}"
# → { "jobId": "…" } ; poll GET /v1/deploy/jobs/{jobId}

curl -s http://127.0.0.1:7200/v1/images -H "Authorization: Bearer dev-agent-token"
curl -s -X DELETE http://127.0.0.1:7200/v1/images/old-tag -H "Authorization: Bearer dev-agent-token"
curl -s -X POST http://127.0.0.1:7200/v1/images/prune \
  -H "Authorization: Bearer dev-agent-token" -H "Content-Type: application/json" \
  -d '{"keepLatest":4}'
```

**Deploy / rollback:** human `git pull`; platform **Deploy** page → agent. Rollback = same with older tag and `build:false`. After success, auto keep‑N prune (default 4). Containers only — **never** delete host `data/`. Manual Delete remains. All host-scoped (`hostId`).

Env for containers: `ERP_ENV_FILE` (default repo `.env` if present) passed as `--env-file`.

Full Docker build/run procedure: root [`README.md`](../README.md).

| Slug | Host data → `/app/data` | Host backups → `/app/backups` |
|---|---|---|
| `{slug}` | `<TENANTS_ROOT>/{slug}/data` | `<TENANTS_ROOT>/{slug}/backups` |

**One-shot legacy import:** agent env `LEGACY_IMPORT_SLUG` + `LEGACY_DATA_DIR` + `LEGACY_BACKUP_DIR` → Companies draft matching that slug gets **Rsync from legacy & provision** (copy into `tenants/{slug}/`, then Docker). No platform DB flag. After success, unset `LEGACY_IMPORT_SLUG`.

Host ports **5101–5199** → container `5000`. Container name: `sotyn-tenant-{slug}`. Runtime registry: `tenants/.agent/runtimes.json` (gitignored under `/tenants/`).

Prod agent overrides: `TENANTS_ROOT=/var/lib/sotyn/tenants`, `ERP_IMAGE=…`.
## Routes — live vs pencil

| Route | Status |
|---|---|
| `/login` | **Live** — platform JWT |
| `/invite/:token` · `/reset/:token` | **Live** — set password (invite / admin reset) |
| `/` Companies list | **Live** list/create draft tenants (`platform.db`) |
| `/hosts` | **Live** — register worker VPS agents (URL, token, health); multi-VPS chassis |
| `/deploy` | **Live** — Deploy / rollback / prune images via worker agent (host picker; never wipes `data/` or `backups/`) |
| `/operators` | **Live** — invite operators, admin reset links, activate/deactivate |
| `/backups` | **Live** — `platform.db` zip backups (Backup Now / list / download; nightly 2:00) |
| `/audit` | **Live** — operator audit log (`platform_audit`; mirrors ERP Admin → Audit) |
| `/docs` | **Live** — HTML how‑tos (Deploy · Multi‑VPS · Operators · Backups · Audit) |
| `/orgs/:slug` Overview | **Live** — hostname edit; **Take backup** + **Restore** via agent (`platform_admin`, warning confirms) |

| `/orgs/:slug/entitlements` | **Pencil** — fixture pack toggles; Save does not persist |
| `/orgs/:slug/brand` | **Live** — branding API + **upload** to durable store (`data/tenants/{slug}/assets/`); seed = fallback |
| `/plans` | **Pencil / later** — pricing stub |
| Export dev config dialog | **Pencil** — Download disabled |
| `/dev/surfaces` | Engineering checklist (white-label ERP surfaces) |

HTML sketches remain at `docs/multitenancy/super-admin-panel-sketches.html` for discussion; React is the clickable walkthrough shell.

## Ports (local)

| Process | Port |
|---|---|
| Platform API | 7100 |
| Platform UI | 7101 (proxies `/api` → 7100) |
| Worker agent | 7200 |

## Next (architect order)

1. **`platform.db` backup/restore** — ✅ zip-only Backups page (see `/backups`)
2. **Platform audit** — ✅ middleware + `/api/audit` + Audit page
3. **Platform exclusive access (Cloudflare Access)** — ✅ runbook + Docs tab; **ops:** Zero Trust app + email allow list (do **not** remove app login)
4. Persist entitlements to `platform.db` + wire Save
5. Wire platform Create company → agent provision ✅ (host picker + Provision)
6. Materialize branding/entitlements into tenant mount; ERP consumes contract
   (branding durable store + upload UI already live — materialize still pending)
7. **Tenant container logs in platform (required)** — Overview Logs via agent `docker logs` (replaces PM2 log files for ERP containers)
8. Multi-VPS Deploy fan-out (same button → remote agents)
9. Nginx map + wildcard `*-erp.sotyn.com` (prod)

## Related

- [`docs/PLATFORM-Cloudflare-Access.md`](../docs/PLATFORM-Cloudflare-Access.md) — **exclusive platform access** (Cloudflare Access; keep JWT login)
- [`docs/PLATFORM-VPS-deploy.md`](../docs/PLATFORM-VPS-deploy.md) — **production VPS**: platform + agent (PM2, nginx, secrets)
- [`docs/PHASE4-tenant-model.md`](../docs/PHASE4-tenant-model.md) — architecture decisions
- Root [`README.md`](../README.md) — tenant Docker Deploy / rollback / prune
- [`.env.example`](.env.example) — platform env template
