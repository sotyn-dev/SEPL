# Platform + worker agent — VPS deploy

Control plane and agent run as **host Node processes** (PM2 / systemd). They are **not** inside the tenant ERP Docker image. Tenant orgs stay Docker; platform + agent stay on the VPS.

Day‑1: one VPS runs platform + local agent + Docker orgs (including secured). See also [`PHASE4-tenant-model.md`](./PHASE4-tenant-model.md) and root [`README.md`](../README.md) for tenant image Deploy / rollback.

---

## Architecture (what runs where)

| Piece | How it runs |
|---|---|
| Platform API (`:7100`) | Host Node (PM2) |
| Platform UI | Built static files + nginx |
| Worker agent (`:7200`) | Host Node (PM2), **localhost only** |
| Each org ERP | Docker via agent (bind-mount `data/`) |

```
Internet → nginx (platform.sotyn.com)
              ├─ static  → /root/erp/platform/client/dist
              └─ /api    → 127.0.0.1:7100  (platform)
                              └─ AGENT_TOKEN → 127.0.0.1:7200  (agent → Docker)
```

Do **not** expose the agent on the public internet.

---

## First-time setup

Assumes monorepo checkout at `/root/erp` (adjust paths if yours differs). Docker Engine installed and working.

### 1. Code + directories

```bash
cd /root/erp
git pull origin main

mkdir -p /var/lib/sotyn/platform /var/lib/sotyn/tenants
```

### 2. Platform env

```bash
cp platform/.env.example platform/.env
```

Edit `platform/.env` (generate secrets with `openssl rand -hex 32`):

```bash
PLATFORM_PORT=7100
PLATFORM_DATA_DIR=/var/lib/sotyn/platform
PLATFORM_ADMIN_USER=admin
PLATFORM_ADMIN_PASSWORD='strong-password-first-boot-only'
PLATFORM_JWT_SECRET='paste-openssl-rand-hex-32'
PLATFORM_PUBLIC_URL=https://platform.sotyn.com

AGENT_URL=http://127.0.0.1:7200
AGENT_TOKEN='paste-another-openssl-rand-hex-32'
```

Notes:

- `PLATFORM_ADMIN_PASSWORD` only seeds admin when `platform_users` is empty (first boot). After that use **Operators → Set password**.
- `PLATFORM_JWT_SECRET` is a random string you invent — not downloaded from a service. Prefer setting it **before** first start so it is not locked to the weak default in `platform.db`.
- This is **not** the ERP `JWT_SECRET` in `/root/erp/.env`.

### 3. Install + build UI

```bash
cd /root/erp/platform
npm run install:all
cd client && npm run build && cd ../..
```

### 4. Start API + agent (PM2)

Use the **same** `AGENT_TOKEN` as in `platform/.env`.

```bash
cd /root/erp

# Platform API — loads platform/.env
pm2 start platform/server/index.js --name sotyn-platform

# Worker agent — localhost; needs Docker
AGENT_TOKEN='same-as-platform-env' \
HOST_ID=host_local \
SECURED_DATA_PATH=/root/erp/data \
TENANTS_ROOT=/var/lib/sotyn/tenants \
ERP_ENV_FILE=/root/erp/.env \
pm2 start platform/worker-agent/index.js --name sotyn-agent

pm2 save
pm2 status
```

Health checks:

```bash
curl -s http://127.0.0.1:7100/api/health
curl -s http://127.0.0.1:7200/v1/health
```

### 5. nginx — `platform.sotyn.com`

- Serve static files from `/root/erp/platform/client/dist`
- Proxy `/api` to `http://127.0.0.1:7100`
- TLS (e.g. certbot) as for other Sotyn hosts

Example location sketch (adapt to your nginx style):

```nginx
server {
  server_name platform.sotyn.com;

  root /root/erp/platform/client/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:7100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

### 6. First login

1. Open `https://platform.sotyn.com/login`
2. Sign in with bootstrap admin
3. **Operators → Set password** — set a strong password immediately
4. Invite other operators as needed (see platform **Docs → Operators**)

---

### Platform database backups

After platform is running, open **Backups** → **Backup Now** (or wait for nightly 2:00 AM).
Zips land in `PLATFORM_BACKUP_DIR` (default `/var/lib/sotyn/platform-backups`). Download weekly to a laptop.
Restore: stop `sotyn-platform` → unzip → replace `platform.db` under `PLATFORM_DATA_DIR` → start.

---

## Later updates (platform / agent code changed)

```bash
cd /root/erp
git pull origin main

cd platform && npm run install:all
cd client && npm run build && cd ../..

pm2 restart sotyn-platform sotyn-agent
```

Restart platform/agent only when `platform/` (or agent) code changed.

---

## Tenant ERP deploys (separate)

Tenant containers are **not** updated by PM2 restart.

1. `git pull origin main` on the VPS (human)
2. Platform UI → **Deploy** → build/recreate tenant containers via agent  
   (auto keep‑N image prune; never deletes host `data/` or `backups/`)

Details: root [`README.md`](../README.md) · platform UI **Docs → Deploy**.

---

## Multi-VPS (adding a worker box)

**Platform stays on VPS‑1.** A new VPS is **agent + Docker tenants only** — same agent API, called remotely from the platform.

### One-time: stand up VPS‑2

1. Install Docker; clone the monorepo (image build context — platform app not required on this box).
2. Run **worker agent** (PM2) with its own `HOST_ID`, same `AGENT_TOKEN` as platform (for now), `TENANTS_ROOT`, `ERP_ENV_FILE`.
3. Register that host in platform UI **Hosts** (id, label, reachable `agent_url`, optional per-host token).
4. Nginx / edge: `{slug}-erp…` → that box’s published container ports.
5. **Companies → New company** → pick that host → Provision (or draft then Provision).

Secured usually stays on VPS‑1; new orgs land on VPS‑2 when capacity needs it.

### Everyday code deploy (each VPS, separately)

| Step | Who | Action |
|---|---|---|
| 1 | You | `git pull` **on that VPS** (platform never runs git) |
| 2 | You | Platform → **Deploy** → pick **that host** |
| 3 | Agent on that host | Build `sotyn-erp:$TAG` → recreate **its** tenant containers only |

Image prune/delete is also **per host**. Data/backups on that disk are never deleted.

### Built already?

| Piece | Status |
|---|---|
| `hosts` table + seeded `host_local` | ✅ |
| Platform **Hosts** UI (register / edit / remove / health) | ✅ |
| Per-host `agent_token` (falls back to env `AGENT_TOKEN`) | ✅ |
| Deploy host picker + `hostId` on deploy / images / prune / delete | ✅ |
| Create company → choose host; optional / later **Provision** via agent | ✅ |
| Private network / tunnel productization | ❌ (ops: WireGuard / SSH / VPC) |
| Auto fan-out (one Deploy → all VPS) | ❌ |
| Tenant move between VPS | ❌ |

Day‑1 path is identical: platform talks to an agent; VPS‑2 just makes that agent remote instead of `localhost`. Also in platform UI **Docs → Multi‑VPS** and **Hosts**.

---

## Everyday reminder

| Change type | What you do |
|---|---|
| Platform UI / API / operators | `git pull` → `npm run install:all` → client `build` → `pm2 restart sotyn-platform` |
| Worker agent | `git pull` → `pm2 restart sotyn-agent` (same `AGENT_TOKEN`) |
| Tenant ERP app code | `git pull` → platform **Deploy** |

There is no platform UI button that deploys the platform or agent itself — only tenant images.
