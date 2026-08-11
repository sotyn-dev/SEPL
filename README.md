# SEPL / Sotyn ERP

Monorepo layout:

| Path | Role |
|---|---|
| `server/` + `client/` | Tenant ERP application |
| `platform/` | Control plane (orgs, branding, **Deploy**, worker agent) |
| `docs/PHASE4-tenant-model.md` | Multitenancy design notes |

**Local ERP (no Docker):** `npm run server` / `npm run client` (or `npm run dev`).  
**Platform:** see [`platform/README.md`](platform/README.md).

---

## Tenant runtime model

Each organisation runs as its **own Docker container** from image `sotyn-erp`.  
Inside the container the app always uses `/app/data` and backup zips at `/app/backups`. Isolation is **host bind-mounts** (no ERP path surgery).

| Tenant | Host `data/` → `/app/data` | Host backups → `/app/backups` |
|---|---|---|
| `secured` | Local: `<repo>/data` · Prod: `/root/erp/data` | Local: `<repo>/backups` · Prod: `/root/erp-backups` |
| Other slugs | Local: `tenants/{slug}/data` · Prod: `/var/lib/sotyn/tenants/{slug}/data` | Local: `tenants/{slug}/backups` · Prod: `/var/lib/sotyn/tenants/{slug}/backups` |

The image is multi-stage: Vite builds the UI **inside Docker**. Host / git `client/dist` is not used for image builds.

**Hard rule:** Deploy / recreate never deletes host `data/` or `backups/` — only the container is replaced.

---

## Everyday deploy (automated — preferred)

This is the normal path once platform + worker agent are running on the host.

### What you do

| Step | Who | Action |
|---|---|---|
| 1 | You | `git pull origin main` on the VPS / host (platform never runs git) |
| 2 | You | Open platform → **Deploy** |
| 3 | You | Enter tag (e.g. `11-08-2026-v1`), leave **Build from current checkout** on, press Deploy |
| 4 | Agent | Builds `sotyn-erp:$TAG` + `:latest`, recreates **all** tenant containers (same ports, volumes, env) |

**Rollback:** same **Deploy** page → pick an older tag from the image list → turn **Build** off → Deploy.

**Old images:** after each successful deploy/rollback the agent auto-prunes unused tags on that host (keeps in-use + `:latest` + **N** newest unused; default **4**). Manual **Delete** remains on Deploy. See [Cleaning old images](#cleaning-old-images). Never deletes tenant data.

### Keep these running

```bash
# from repo root
npm run platform          # API :7100 + UI :7101  (login: admin / sotyn-dev locally)
npm run platform:agent    # agent :7200  (Bearer: AGENT_TOKEN or dev-agent-token)
```

Docker Engine / Desktop must be up. Agent needs image name via `ERP_IMAGE` (default `sotyn-erp:local` for first provision).

### Same thing without the UI (agent API)

```bash
# after git pull
curl -s -X POST http://127.0.0.1:7200/v1/deploy \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag":"11-08-2026-v1","build":true}'
# → { "jobId": "…" }
# poll: GET /v1/deploy/jobs/{jobId}

# rollback (no build)
curl -s -X POST http://127.0.0.1:7200/v1/deploy \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag":"10-08-2026-v1","build":false}'
```

Platform proxies the same calls (JWT required; pass `hostId` for multi-VPS):

- `GET /api/deploy/hosts`
- `POST /api/deploy` `{ "tag", "build", "hostId?", "keepLatest?": 4, "pruneAfter?": true }`
- `GET /api/deploy/jobs/:id?hostId=`
- `GET /api/deploy/images?hostId=`
- `DELETE /api/deploy/images/:tag?hostId=`
- `POST /api/deploy/images/prune` `{ "hostId?", "keepLatest": 4 }`

---

## First-time / local smoke

### Build image once (or let Deploy do it)

```bash
docker build -t sotyn-erp:local .
```

### Manual one-off container (optional check)

```bash
mkdir -p tenants/_manual/data tenants/_manual/backups
docker run -d --name sotyn-smoke \
  -p 5188:5000 \
  -v "$(pwd)/tenants/_manual/data:/app/data" \
  -v "$(pwd)/tenants/_manual/backups:/app/backups" \
  --env-file .env \
  -e TENANT_ID=smoke \
  -e PORT=5000 \
  -e ERP_BACKUP_DIR=/app/backups \
  -e ERP_DISABLE_BACKUP_SCHEDULER= \
  sotyn-erp:local
```

Check: `http://127.0.0.1:5188/api/health`  
Cleanup: `docker rm -f sotyn-smoke` (data/backups folders stay unless you delete them yourself).

PowerShell volumes: `-v "${PWD}\tenants\_manual\data:/app/data"` and `-v "${PWD}\tenants\_manual\backups:/app/backups"`.

### Agent: create a tenant box

```bash
npm run platform:agent

curl -s -X POST http://127.0.0.1:7200/v1/tenants \
  -H "Authorization: Bearer dev-agent-token" \
  -H "Content-Type: application/json" \
  -d '{"slug":"pharma"}'
```

| Action | Request |
|---|---|
| Health | `GET /v1/health` (no auth) |
| Provision | `POST /v1/tenants` `{"slug":"…"}` |
| List / stop / start | `GET /v1/tenants` · `POST …/stop` · `…/start` |
| Images | `GET /v1/images` (includes `inUse` / `usedBy`) |
| Delete tag | `DELETE /v1/images/{tag}` (refuses if in use) |
| Prune | `POST /v1/images/prune` `{ keepLatest?: 4 }` — this host only |
| Deploy | `POST /v1/deploy` (see above) |
| Remove container | `DELETE /v1/tenants/{slug}` — add `?wipeData=1` only if you really want that tenant’s data gone (`secured` refuses wipe) |

- Ports **5101–5199** → container `5000`
- Name: `sotyn-tenant-{slug}`
- Registry: `tenants/.agent/runtimes.json` (gitignored)

---

## Manual deploy (fallback if platform/agent is down)

Same outcome as automated Deploy, done by hand. Use only when needed.

```bash
cd /root/erp   # or local repo root
git pull origin main

TAG=11-08-2026-v1
docker build -t sotyn-erp:$TAG -t sotyn-erp:latest .

# For EACH tenant — same port + volumes as before (agent remembers these; you must look them up)
docker rm -f sotyn-tenant-secured
docker run -d --name sotyn-tenant-secured \
  -p 5101:5000 \
  -v /root/erp/data:/app/data \
  -v /root/erp-backups:/app/backups \
  --env-file /root/erp/.env \
  -e TENANT_ID=secured \
  -e PORT=5000 \
  -e ERP_BACKUP_DIR=/app/backups \
  -e ERP_DISABLE_BACKUP_SCHEDULER= \
  sotyn-erp:$TAG

# other slug example
docker rm -f sotyn-tenant-pharma
docker run -d --name sotyn-tenant-pharma \
  -p 5102:5000 \
  -v /var/lib/sotyn/tenants/pharma/data:/app/data \
  -v /var/lib/sotyn/tenants/pharma/backups:/app/backups \
  --env-file /root/erp/.env \
  -e TENANT_ID=pharma \
  -e PORT=5000 \
  -e ERP_BACKUP_DIR=/app/backups \
  -e ERP_DISABLE_BACKUP_SCHEDULER= \
  sotyn-erp:$TAG
```

`docker restart` does **not** pick up a new image — you must `rm` + `run` again. Data and backups on disk are untouched.

Rollback: same commands with an older tag. List images: `docker images sotyn-erp`.

### Cleaning old images

**Default:** after a successful Deploy / rollback, the agent auto-prunes unused `sotyn-erp` tags on that host (keeps in-use, `:latest`, and **4** newest unused — configurable via keep‑N on the Deploy form). Manual **Delete** on an unused row is still available. Optional **Prune unused** runs the same rule without deploying.

CLI fallback (does **not** touch tenant `data/`):

```bash
docker images sotyn-erp
docker rmi sotyn-erp:10-08-2026-v1
```

If a container is still using that tag, recreate/rollback first (or Docker / the agent will refuse).

---

## Environment variables

| Layer | What |
|---|---|
| Image | Code + built UI only — no secrets |
| Host `.env` | Secrets (`JWT_SECRET`, Twilio, S3, …) — gitignored |
| Container start | `--env-file` + tenant `-e` overrides |

Agent uses `ERP_ENV_FILE` (default: repo `.env` if present), then forces `TENANT_ID`, `PORT=5000`, `ERP_BACKUP_DIR=/app/backups`, and clears `ERP_DISABLE_BACKUP_SCHEDULER` so nightly backups write to the bind-mounted folder.

| Variable | Default | Meaning |
|---|---|---|
| `ERP_IMAGE` | `sotyn-erp:local` | Image for new provision |
| `TENANTS_ROOT` | `<repo>/tenants` | New-tenant data + backups root |
| `SECURED_DATA_PATH` | `<repo>/data` | Secured data bind path |
| `SECURED_BACKUP_PATH` | `<repo>/backups` (Win) · `/root/erp-backups` (Linux) | Secured backups bind path |
| `AGENT_PORT` | `7200` | Agent listen port |
| `AGENT_TOKEN` | `dev-agent-token` | Bearer for agent `/v1/*` |
| `ERP_ENV_FILE` | `<repo>/.env` if present | Passed into tenant containers |

Restart platform / agent processes only when **those** packages changed — they are not inside the tenant ERP image.

Multi-VPS: later the same Deploy button fans out to each host’s agent. Day‑1 = this host only.

---

## Related docs

- [`platform/README.md`](platform/README.md) — control plane local run
- [`docs/PLATFORM-VPS-deploy.md`](docs/PLATFORM-VPS-deploy.md) — VPS: platform + agent (PM2, nginx, env)
- [`docs/PHASE4-tenant-model.md`](docs/PHASE4-tenant-model.md) — architecture and decisions
- [`.env.example`](.env.example) — ERP env reference
