# Sotyn Platform (control plane)

Boilerplate for `platform.sotyn.com` — org registry, white-label Brand (live), Layer‑1 panel pencils (non-integrated).

**Not** the tenant ERP. **Not** the worker agent (stub only under `worker-agent/`).

## Layout

```
platform/
  server/           Express + SQLite (platform.db)
  client/           Super-admin UI (Vite + React)
  seed/tenants/     Seed orgs (secured branding extracted from ERP)
  contracts/        Branding JSON schema + ERP surface checklist
  worker-agent/     Minimal /v1/health stub (Docker verbs later)
```

## Local run

```bash
# one-time deps (run from platform/ — do not npm --prefix from repo root)
cd platform && npm run install:all

# from repo root
npm run platform          # API :7100 + UI :7101

# or separately
npm run platform:server
npm run platform:client
npm run platform:agent    # stub :7200
```

Local defaults: first boot seeds operator `admin` / `sotyn-dev` into `platform_users` (bcrypt). Override with `PLATFORM_ADMIN_USER` / `PLATFORM_ADMIN_PASSWORD` **before first boot**, or change the hash in DB.

Auth: **platform JWT** (`PLATFORM_JWT_SECRET`, persisted in `platform_settings`) — separate from ERP `JWT_SECRET`. Client sends `Authorization: Bearer <token>`.

Data dir default: `platform/data/platform.db` (gitignored). Seed loads `secured` on first boot.

Product mark: `platform/client/public/sotyn-logo.png` (login + header).

## Routes — live vs pencil

| Route | Status |
|---|---|
| `/login` | **Live** — platform JWT |
| `/` Companies list | **Live** list/create draft tenants (`platform.db`) |
| `/orgs/:slug` Overview | **Pencil** — layout + real tenant fields; Pause not wired |
| `/orgs/:slug/entitlements` | **Pencil** — fixture pack toggles; Save does not persist |
| `/orgs/:slug/brand` | **Live** — branding API + seed assets |
| `/plans` | **Pencil / later** — pricing stub |
| Export dev config dialog | **Pencil** — Download disabled |
| `/dev/surfaces` | Engineering checklist (white-label ERP surfaces) |
| Audit / Operators nav | Dim “Later” — no pages yet |

HTML sketches remain at `docs/multitenancy/super-admin-panel-sketches.html` for discussion; React is the clickable walkthrough shell.

## Ports (local)

| Process | Port |
|---|---|
| Platform API | 7100 |
| Platform UI | 7101 (proxies `/api` → 7100) |
| Worker agent stub | 7200 |

## Next (architect order)

1. Persist entitlements to `platform.db` + wire Save
2. Worker agent Docker + local drivers (`/v1/tenants…`)
3. Dockerfile for ERP image + agent provision
4. Materialize branding/entitlements into tenant mount; ERP consumes contract
