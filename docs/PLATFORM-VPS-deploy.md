# Platform + worker agent — VPS deploy

Control plane and agent run as **host Node processes** (PM2 / systemd). They are **not** inside the tenant ERP Docker image. Tenant orgs stay Docker; platform + agent stay on the VPS.

Day‑1: one VPS runs platform + local agent + Docker orgs (including secured). See also [`PHASE4-tenant-model.md`](./PHASE4-tenant-model.md) and root [`README.md`](../README.md) for tenant image Deploy / rollback.

**In the platform UI:** **Docs → Env** (same instructions as § Env files below) · **Docs → Multi‑VPS** · **Docs → Deploy**.

---

## Architecture (what runs where)

| Piece | How it runs |
|---|---|
| Platform API (`:7100`) | Host Node (PM2) |
| Platform UI | Built static files + nginx |
| Worker agent (`:7200`) | Host Node (PM2), **localhost only** (+ outbound WSS) |
| Each org ERP | Docker via agent (bind-mount `data/`) |

```
Operator browser → Cloudflare Access (email OTP / IdP)
                      → nginx (platform.sotyn.ai)  [DNS orange-clouded]
                           ├─ static  → /root/erp/platform/client/dist
                           └─ /api    → 127.0.0.1:7100  (platform)

Worker agent → outbound WSS → agents.sotyn.ai :443 → Platform /api/agent/v1/ws
             (HTTP :7200 kept as local fallback)
```

**Access model:** **Cloudflare Access** gates who can reach the **human** platform host. Keep platform JWT login — do not remove app auth. Runbook: [`PLATFORM-Cloudflare-Access.md`](./PLATFORM-Cloudflare-Access.md).

**Agent control plane (WSS):** [`PLATFORM-agents-wss.md`](./PLATFORM-agents-wss.md) — local `ws://127.0.0.1:7100/...`, deploy `wss://agents.sotyn.ai/...`. Do **not** put Access OTP on `agents.sotyn.ai`.

Do **not** expose the agent HTTP port on the public internet.

---

## First-time setup

Assumes monorepo checkout at `/root/erp` (adjust paths if yours differs). Docker Engine installed and working.

### 1. Code + directories

```bash
cd /root/erp
git pull origin main

mkdir -p /var/lib/sotyn/platform /var/lib/sotyn/tenants
```

### 2. Env files (platform + agent) — clear day‑1 example

Same content as platform UI **Docs → Env**. Two files on **VPS‑A** — not the same file.

```bash
cp platform/.env.example platform/.env
cp platform/agent.env.example platform/agent.env
```

Generate two secrets:

```bash
openssl rand -hex 32   # → PLATFORM_JWT_SECRET
openssl rand -hex 32   # → AGENT_TOKEN (same value in BOTH files below)
```

#### A) `platform/.env` (control plane only)

```bash
PLATFORM_PORT=7100
PLATFORM_DATA_DIR=/var/lib/sotyn/platform
PLATFORM_ADMIN_USER=admin
PLATFORM_ADMIN_PASSWORD='strong-password-first-boot-only'
PLATFORM_ADMIN_EMAIL=sotyn.soft@gmail.com
PLATFORM_JWT_SECRET='paste-first-openssl-rand-hex-32'
PLATFORM_PUBLIC_URL=https://platform.sotyn.com

# Optional — invite / forgot-password email (Gmail app password etc.)
# PLATFORM_SMTP_HOST=smtp.gmail.com
# PLATFORM_SMTP_PORT=587
# PLATFORM_SMTP_USER=sotyn.soft@gmail.com
# PLATFORM_SMTP_PASS='app-password'
# PLATFORM_EMAIL_FROM='Sotyn Platform <sotyn.soft@gmail.com>'

# How platform reaches the LOCAL agent on this same VPS
AGENT_URL=http://127.0.0.1:7200
AGENT_TOKEN='paste-second-openssl-rand-hex-32'
```

#### B) `platform/agent.env` (worker agent only)

Uncommented lines are required. Leave `LEGACY_*` commented until cutover.

```bash
# Must match platform/.env AGENT_TOKEN on day‑1 (same VPS)
AGENT_TOKEN='paste-second-openssl-rand-hex-32'
HOST_ID=host_local
TENANTS_ROOT=/var/lib/sotyn/tenants
ERP_ENV_FILE=/root/erp/.env

# One-shot cutover only — leave commented for normal provision
# LEGACY_IMPORT_SLUG=sepl
# LEGACY_DATA_DIR=/root/erp/data
# LEGACY_BACKUP_DIR=/root/erp-backups
```

| File | Who reads it | Purpose |
|---|---|---|
| `platform/.env` | Platform API (`sotyn-platform`) | Login, JWT, SMTP, DB path, default agent URL/token |
| `platform/agent.env` | Worker agent (`sotyn-agent`) | Token check, tenants disk, ERP `--env-file`, optional legacy rsync |
| `/root/erp/.env` | ERP containers (`ERP_ENV_FILE`) | JWT/SMTP/S3 for tenant apps — **not** platform/agent secrets |

Notes:

- `AGENT_TOKEN` on day‑1 **must match** in `platform/.env` and `platform/agent.env`.
- `PLATFORM_ADMIN_PASSWORD` only seeds admin when `platform_users` is empty (first boot). After that use **Operators → Set password** or login **Forgot password** (needs SMTP + admin email).
- `PLATFORM_ADMIN_EMAIL` defaults to `sotyn.soft@gmail.com` (also backfilled when empty on existing DBs).
- `PLATFORM_JWT_SECRET` is a random string you invent — not downloaded from a service. Prefer setting it **before** first start so it is not locked to the weak default in `platform.db`.
- This is **not** the ERP `JWT_SECRET` in `/root/erp/.env`.
- After any edit to `agent.env`: `pm2 restart sotyn-agent`. After edits to `platform/.env`: `pm2 restart sotyn-platform`.

### 3. Install + build UI

```bash
cd /root/erp/platform
npm run install:all
cd client && npm run build && cd ../..
```

### 4. Start API + agent (PM2)

```bash
cd /root/erp

# Platform API — loads platform/.env
pm2 start platform/server/index.js --name sotyn-platform

# Worker agent — loads platform/agent.env; needs Docker
pm2 start platform/worker-agent/index.js --name sotyn-agent

pm2 save
pm2 status
```

`sotyn-platform` / `sotyn-agent` are only **PM2 nicknames** (`--name`), not host ids.

Health checks:

```bash
curl -s http://127.0.0.1:7100/api/health
curl -s http://127.0.0.1:7200/v1/health
```

### 4b. sepl / orphan one-shot (optional)

Only when cutting over old PM2 data into `tenants/{slug}/`:

1. Edit `platform/agent.env` — uncomment and set:
   ```bash
   LEGACY_IMPORT_SLUG=sepl
   LEGACY_DATA_DIR=/root/erp/data
   LEGACY_BACKUP_DIR=/root/erp-backups
   ```
2. `pm2 restart sotyn-agent`
3. Stop old PM2 ERP (downtime)
4. Platform → Companies → draft matching that slug → **Rsync from legacy & provision**
5. Comment out / remove `LEGACY_IMPORT_SLUG` → `pm2 restart sotyn-agent` again

### 5. nginx — `platform.sotyn.com`

- Serve static files from `/root/erp/platform/client/dist`
- Proxy `/api` to `http://127.0.0.1:7100`
- TLS (e.g. certbot) as for other Sotyn hosts
- DNS for this hostname must be **Cloudflare-proxied** (orange cloud) so Access can gate traffic — see [`PLATFORM-Cloudflare-Access.md`](./PLATFORM-Cloudflare-Access.md)

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

### 5b. Cloudflare Access (exclusive platform access)

Before treating platform as production-hardened:

1. Put `platform.sotyn.com` on Cloudflare DNS (proxied).
2. Zero Trust → Access application + Allow policy (operator emails).
3. Enable One-time PIN (or your IdP).
4. Keep platform **login / operators / audit** — Access does not replace app auth.

Runbook: [`PLATFORM-Cloudflare-Access.md`](./PLATFORM-Cloudflare-Access.md) · platform UI **Docs → Access**.

### 6. First login

1. Open `https://platform.sotyn.com` → complete Cloudflare Access (OTP / IdP)
2. Sign in on platform `/login` with bootstrap admin
3. **Operators → Set password** — set a strong password immediately
4. Invite other operators (platform **Docs → Operators**); add their emails to the Access allow list

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

**Platform stays on VPS‑A.** Extra boxes run **agent + Docker tenants only**.

### Clear example — tokens & files

| Location | File / UI | Example values |
|---|---|---|
| **VPS‑A** platform | `platform/.env` | `AGENT_TOKEN=token-a` · `AGENT_URL=http://127.0.0.1:7200` |
| **VPS‑A** agent | `platform/agent.env` | `AGENT_TOKEN=token-a` · `HOST_ID=host_local` |
| **VPS‑B** agent | `platform/agent.env` | `AGENT_TOKEN=token-b` · `HOST_ID=host_vps_b` |
| **Platform UI → Hosts** (stored in `platform.db` on A) | Register host | see table below |

**Hosts UI — fill for VPS‑B:**

| Field | Example |
|---|---|
| Host id | `host_vps_b` |
| Label | `VPS B` |
| Agent URL | `http://VPS_B_PRIVATE_IP:7200` (must be reachable from A; agent is localhost-only until you open private access) |
| Agent token | `token-b` (same as B’s `agent.env`) |

No `platform/.env` on B/C — only `agent.env` + Docker. Same tables in UI **Docs → Env** / **Docs → Multi‑VPS**.

### One-time: stand up VPS‑B

1. Install Docker; clone the monorepo (image build context — platform app not required on this box).
2. `cp platform/agent.env.example platform/agent.env` → set `AGENT_TOKEN` / `HOST_ID` / paths → `pm2 start … --name sotyn-agent` (later: `pm2 restart sotyn-agent`).
3. Register that host in platform UI **Hosts** (table above).
4. Nginx / edge: `{slug}-erp…` → that box’s published container ports.
5. **Companies → New company** → pick that host → Provision (or draft then Provision / legacy rsync).

Secured / sepl usually stays on VPS‑A; new orgs land on VPS‑B when capacity needs it.

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
| Platform exclusive access (Cloudflare Access runbook) | ✅ docs — [`PLATFORM-Cloudflare-Access.md`](./PLATFORM-Cloudflare-Access.md); ops in CF dashboard |
| Private network / tunnel as in-app product | ❌ (infra runbook only; not a platform UI feature) |
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
