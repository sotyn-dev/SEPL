# Phase 4 — Multi-tenant model (parked / resume notes)

> Status: **PARKED** (designed Jul 2026 in Claude Code; not built).  
> Source of truth for ideation: `~/.claude/plans/enchanted-stargazing-pancake.md`  
> Related shipped work: Module availability, `server/lib/paths.js`, S3 seam (`STORAGE_DRIVER` / `S3_KEY_PREFIX`).  
> Empty local branch name only: `feature/multi-tenant-migration` (no unique commits — ignore or delete).

**Browser references (both):**

- [docs/multitenancy/tenant-model-ideation.html](multitenancy/tenant-model-ideation.html) — Jul 2026 plain-language concept draft  
- [docs/multitenancy/super-admin-panel-sketches.html](multitenancy/super-admin-panel-sketches.html) — Layer‑1 panel screen sketches  
- [docs/multitenancy/module-depends-graph.md](multitenancy/module-depends-graph.md) — traced `dependsOn` graph (hubs / hard vs soft)  
- Index: [docs/multitenancy/README.md](multitenancy/README.md)

This doc is the in-repo engineering handoff so Phase 4 can be resumed without digging Claude session history.

---

## Goal

Host other organisations (e.g. Concern Pharma) on the **same VPS / same codebase**, with:

1. **Subdomain per onboarded org** — pattern below (`{slug}-erp.sotyn.com`)  
2. **Org-level feature control** — which modules a tenant’s plan may use, set from the super-admin panel  
3. **Monitor from the same panel** — live/paused status, entitlements, audits, health of each org  
4. **Isolated data** — DB + uploads + S3 namespace per tenant  
5. **Control plane** — super-admin orchestration dashboard (create org, entitlements, monitor; later pricing)

### Product vision (locked by product owner — Aug 2026)

> Onboarded organisations get **their own subdomain**. Features are **controlled and monitored** from a **super-admin panel dashboard** — not edited only via env files or per-tenant admin screens.

This implies hostname → tenant resolution at the edge (DNS + nginx/TLS) and in the app (request → which data mount / entitlements). The panel is the day-to-day operator surface.

### What you are selling (locked — Aug 2026)

The wildcard subdomain is a **tenant slot**, not a promise of “MEPF ERP.”

| | |
|---|---|
| **Hosting unit** | `{slug}-erp.sotyn.com` + isolated `data/` + container — same for every customer |
| **Product** | Whatever **packs / apps** sales entitled for that slug |
| **Primary vertical (today)** | **MEPF contractor ERP** (Secured-shaped: projects, procure, site, finance, HRMS) |
| **Not required** | That every subdomain is an MEPF / ERP customer |
| **Later** | Any app surface can be **exclusive** to some tenants (Chat-only salon; future vertical apps; partner-only modules) |

Management / sales asks that the platform must absorb without a fork:

| Ask pattern | Example |
|---|---|
| Full / partial MEPF ERP | Concern Pharma — ERP baseline + selected packs |
| One feature onto an ERP org | “Give Sotyn Chat to Concern Pharma” |
| Non-ERP customer | “Give app features to a barber salon chain” |
| Exclusive app | “Only tenant X gets App Y” / “hide Y from everyone else” |

```text
Subdomain  =  tenancy + isolation + billing hook
Packs/apps =  what you invoice for
Panel      =  who gets what, live
```

**Engineering consequence:** entitlements are the product catalog. Code may ship many modules in one image; **nav + API only expose what that tenant bought**. Exclusive apps = packs default OFF globally, ON only for listed tenants (same kill-switch / `platform.db` path — no separate codebase).

Hostname label `-erp` is historical routing; it does **not** mean the tenant is an ERP customer. Rename later only if branding demands it — not required for the model.

### Hostname & TLS (locked — Aug 2026)

| | |
|---|---|
| Pattern | **`{slug}-erp.sotyn.com`** (wildcard form: `*-erp.sotyn.com`) |
| Examples | `sepl-erp.sotyn.com`, `pharma-erp.sotyn.com` |
| DNS | Single **wildcard** DNS entry covering `*-erp.sotyn.com` |
| TLS | **Wildcard SSL**, auto-generated / auto-renewed (no per-tenant cert dance at onboard) |
| App routing | Request `Host` → resolve `slug` → tenant id / data dir / entitlements |

Onboard flow implication: creating an org in the panel assigns a **slug**; the public URL is `{slug}-erp.sotyn.com` immediately — no new DNS record or cert issuance per company (wildcard already covers it). Nginx (or Hostinger equivalent) must forward that Host header to the correct container port.

### Hosting facts (production VPS — confirmed Aug 2026)

| | |
|---|---|
| Provider | **Hostinger** VPS |
| RAM | **4 GB** |
| Disk | **100 GB** |
| CPU | **2 cores** |
| Stack (target) | Ubuntu + nginx + Docker (ERP orgs) + platform + worker agent + SQLite on disk |

**Capacity (locked planning numbers — Aug 2026):** each ERP ≈ Node heap capped ~512M / process restart ~600M today (`ecosystem.config.js`). Worker agent is negligible (~tens of MB). Platform ~150–300 MB. OS + nginx + Docker daemon ~0.5–0.8 GB.

| Packing on first 4 GB VPS | Guidance |
|---|---|
| **Recommended** | Secured (Docker) + **2–3** other Docker orgs + platform + local agent |
| **Stretch** | 4–5 ERP-class containers — only with tight caps + swap; expect pressure |
| **Add VPS‑2 when** | You would take a **4th** active Docker org besides secured, or one org is noisy/hot |

Disk (100 GB) still fills from uploads — S3/R2 remains the scale lever; DBs stay local.

Older Claude notes that said “512 MB-heap VPS” were about Node memory pressure / small boxes, **not** these confirmed machine specs. Prefer this table going forward.

### Runtime model (locked — Aug 2026): **all orgs Docker from day 1**; secured data stays put

**Hard constraint:** `/root/erp/data/*` **belongs to secured** and must **not** be copied or moved. No “relocate into `data/secured/`”, no symlink flip. Containerizing secured = **bind-mount the existing folder** into the container’s `data/` — same files, different process.

Today (before cutover): one PM2 app `erp` at `/root/erp`, `PORT=5000`, relative `data/*` (= secured).

**Target:**

```
/root/erp/                              ← ONE git checkout + image build context
  server/ client/ …
  data/                                 ← SECURED ONLY — leave forever on disk
    erp.db  chat.db  uploads/ …         ← bind-mounted into secured container

/var/lib/sotyn/tenants/                 ← OTHER orgs’ disk homes (LOCKED)
  pharma/
    data/                               ← that org’s erp.db, uploads, …
  acme/
    data/

/var/lib/sotyn/platform/                ← control-plane state (outside tenant data)
  platform.db                           ← registry, entitlements, hosts, ports, container ids
```

| Piece | How it works |
|---|---|
| **Secured** | **Docker from day 1** — same image; volume `/root/erp/data` → container `data/` (e.g. `/app/data`). URL: `secured-erp.sotyn.com` → nginx → published port. **No data move.** Cutover: stop PM2 → start container with that mount. |
| **New org** | **Docker** from the **same image**; host `/var/lib/sotyn/tenants/{slug}/data` → container `data/`. |
| **Data resonance** | Inside every container the app only knows `data/*` — zero path logic change. Host path differs per org. |
| **Code** | One image built from `/root/erp` (or CI). No `/root/erp-pharma` code copy. Per worker VPS: one `/root/erp` checkout as build/pull context. |
| **URL** | `{slug}-erp.sotyn.com` → nginx → that org’s container port |
| **S3** | Per-org prefix = slug (set in container env) |
| **Forbidden** | Moving/copying secured `data/*`; forking the repo per customer; one Node process multiplexing all tenant DBs |

**Why Docker:** isolation + each org’s own disk tree **without** teaching the app multi-root paths and **without** relocating secured’s live files. A volume mount makes “another folder on the VPS” look like the same relative `data/*`.

**Container shapes (illustrative):**

```text
# Secured (legacy host path)
image:   sotyn-erp:<git-sha>
name:    erp-secured
env:     PORT=5000  S3_KEY_PREFIX=secured   # or tenant_sepl — pick once, keep stable
ports:   127.0.0.1:5000:5000
volume:  /root/erp/data  →  /app/data

# New org
image:   sotyn-erp:<git-sha>
name:    erp-pharma
env:     PORT=5000  S3_KEY_PREFIX=pharma
ports:   127.0.0.1:5101:5000
volume:  /var/lib/sotyn/tenants/pharma/data  →  /app/data
```

(App cwd inside image is wherever `data/` is relative today — mount must land on that exact path. Watch container UID vs existing file ownership on `/root/erp/data`.)

**Edge (nginx):** wildcard cert `*-erp.sotyn.com`; generated map `host → 127.0.0.1:port` (all Docker org ports, including secured).

**Super-admin panel (all automatic on onboard):**

Platform **never** talks to Docker/nginx directly. It always calls a **worker agent** (same API on day 1 and on VPS-2+).

| Action | What happens |
|---|---|
| Create org | Platform writes `platform.db` → calls **agent** `provision` → agent: `mkdir -p /var/lib/sotyn/tenants/{slug}/data` → `docker run` + volume + env + port → nginx map + reload → health-check |
| Feature control | Entitlements in `platform.db` only; see **Entitlement propagation** below |
| Monitor | Platform asks agent for container status + health; restart/stop/start; pause = stop container |
| Deploy code | See **Deploy / rollback (locked)** below |
| Move tenant (later) | Platform coordinates old agent (stop + export) → new agent (import + run) → flip routing |

**Deploy / rollback (locked — Aug 2026):**

1. Operator on the main VPS: `git pull origin main` only. Platform and agent **never** run git.
2. Platform **Deploy** → local worker agent: `docker build -t sotyn-erp:$TAG -t sotyn-erp:latest` (from already-pulled checkout) → recreate **every** tenant container on that host (same port, volume, `--env-file`, new image).
3. **Rollback** = same Deploy with an older existing tag and `build: false` (no rebuild).
4. **Hard rule:** deploy / recreate / rollback may only `docker rm -f` the **container**. Host bind-mounted `data/` is never removed, emptied, or passed through `wipeData`. Multi-VPS fan-out (same button → all agents) is later; day‑1 is **host_local only**.

**Day‑1 host (locked):** one VPS runs **platform + local worker agent + Docker orgs (including secured)**. Agent is `localhost` to platform — identical provision path when VPS‑2 joins (agent is remote). No “platform drives Docker itself” shortcut.

### Local development (locked — Aug 2026)

**Two gears (luxury + Docker tenants):**

| Gear | When | How |
|---|---|---|
| **A. Everyday** | Feature work on secured / platform | `npm` scripts only — **no Docker**. Secured = repo `data/`. |
| **B. Multitenant smoke** | Provision 2nd org / cutover rehearsal | Docker Desktop on; **worker agent Docker driver** bind-mounts host folders → container `/app/data` (same as prod). No `DATA_DIR` path surgery. |

| Process | Local default |
|---|---|
| ERP (secured day-to-day) | `npm` / Node against repo `data/` |
| Platform | run script (`npm run platform`) — **not** Docker |
| Worker agent | run script (`npm run platform:agent`); tenant ERP boxes via **`docker run`** |
| New org data | `./tenants/{slug}/data` (gitignored) → mount `/app/data` |
| Secured adopt (smoke) | repo `data/` → mount `/app/data` (stop npm first; **no file move**) |

Compose is optional for fixed control-plane stacks later — **not** the onboarder (agent provisions tenants).

**Local sim (privacy-safe):** export RBAC + entitlements (secret-filtered) via panel → seed into local `data/` or `./tenants/{slug}/data` via script.

**What we explicitly dropped:** moving secured into `data/secured/` or symlink-flipping `/root/erp/data`. Product owner rejected it. Containerize-in-place via bind mount is the allowed path. Child-process + `DATA_DIR` opener surgery is also rejected.

### Also locked

| Decision | Choice |
|---|---|
| Secured data | **`/root/erp/data/*` stays** — no move, no copy, no symlink flip |
| Secured runtime | **Docker from day 1** — bind-mount `/root/erp/data` → container `data/` |
| New orgs | **Docker** + bind-mount `/var/lib/sotyn/tenants/{slug}/data` → container `data/` |
| Tenancy shape | Separate folder + DB per org; never shared DB + `tenant_id` |
| Entitlements | Authoritative in `platform.db` only |
| Entitlement API | Coarse **packs** `GET/PUT /api/tenants/:slug/entitlements` — not per-widget |
| Hide / disable | **Best effort, loose coupling** — nav + pack front door; Dashboard/DPR/overlays degrade (skip/empty), never hard-unplumb every JOIN. See § Entitlement API + hide/disable semantics |
| Secured entitlements | **All packs ON** at seed — full surface as today |
| Effective access chain | **Platform entitlement → Module availability → RBAC matrix** (entitlement overrides Roles popup kill-switches; saved flags/matrix not wiped) |
| Code | One monorepo → ERP image + platform app + worker agent; never fork/copy per org |
| Local default | **Run scripts** for ERP, platform, agent; Docker optional for provision tests only |
| Slug resonance | `pharma` → `pharma-erp.sotyn.com` → `/var/lib/sotyn/tenants/pharma/data` → S3 prefix `pharma` |
| Tenant data root (new orgs) | **`/var/lib/sotyn/tenants/{slug}/data` only** — no alternate host roots |
| Control plane | One `platform.sotyn.com` + one `platform.db` (not per worker) |
| Worker agent | **From day 1** — local agent on the platform VPS; same agent on every later worker VPS. See **Worker agent** section |
| Multi-VPS | Extra workers (ERP + agent only); platform stays on its home host |
| First-VPS capacity | **Secured + 2–3** other Docker orgs comfortably on 4 GB |
| Entitlement propagation | **Day 1:** materialize + recreate; **later:** TTL poll / file refresh (expand, don’t replace) |
| What subdomain means | **Tenant slot** — not “must be MEPF ERP customer” |
| What you sell | **Packs / apps** via panel; one image; exclusive apps = pack OFF everywhere except listed tenants |
| Tenant classes | **MEPF/ERP** · **feature-only** · **exclusive-app** (see *What you are selling*) |
| Secured’s place | **A tenant like any other** for product/branding — not “the default org.” Special cases only: legacy `/root/erp/data` bind-mount + **all packs entitled**. See **White-label** / entitlements |
| White-label | Per-tenant display name + logo (platform sets → tenant shell/login/prints). No hardcoded Secured-as-default chrome |
| Field access | **PWA / WebView** on tenant URL + home-screen icons from tenant branding; optional **mini downloadable wrapper** for some tenants only — no separate field backend |

---

## What already shipped (do not rebuild)

- **Module availability** — `server/lib/features.js`, Roles & Permissions modal, `data/module-flags.json` (above RBAC).  
- **`server/lib/paths.js`** — `TENANT_ID` → `DATA_ROOT` (empty today → flat `data/`).  
- **S3 seam** — `server/lib/storage.js`, dual-read, quarantine/sweep verbs, optional `BACKUP_S3`.  
- **Deploy notes** — `docs/DEPLOY-disk-space-reclaim.md` (set `S3_KEY_PREFIX=tenant_sepl` on first S3 boot).

---

## Prerequisite before multi-org Docker (gate)

**Secured does not need a `TENANT_ID` / data move.** Isolation = Docker + bind mounts (secured uses legacy path; new orgs use `/var/lib/sotyn/tenants/…`).

Still worth doing in the shared codebase (helps the image + future hygiene):

1. Prefer `paths.js` (`DATA_ROOT` / `DB_PATH` / `uploadsSub`) over hardcoded `…/data/…` so the image has one place that resolves `data/`  
2. **Dockerfile** that runs the app with `data/` at a fixed in-container path ready to bind-mount  
3. Hardening before org #2: schema version stamp, fail-loud migrations, canary  
4. Careful secured cutover: stop PM2 → container with `/root/erp/data` mount → confirm UID/permissions  

**Do not** relocate live secured `data/*` as part of this work.

---

## Hardening required before tenant #2

1. **Schema version stamp** — `PRAGMA user_version` (or settings row), logged at boot per DB  
2. **Fail loud migrations** — stop bare `catch {}` on ALTER / rebuilds; only swallow “already applied”  
3. **Canary rollout** — after secured is on Docker, first *new* org is one Docker tenant; verify before onboarding more  

---

## Control plane / entitlements (ideation — not built)

**Two tiers:** `tenant.enabled(module)` × `requirePermission(module, action)`.

**Module `dependsOn`:** traced graph lives in [module-depends-graph.md](multitenancy/module-depends-graph.md) — use when expanding `KILLABLE_MODULES` so hub kills (especially `business_book`, `item_master`, `employees`) cannot leave hard dependents entitled.

### Common modules for all tenants (locked observation — Aug 2026)

Not every sidebar item is a plan toggle. Split three layers — and **not every onboarded org is an ERP customer**.

**Tenant classes (product):**

| Class | Example ask | What they get |
|---|---|---|
| **MEPF / ERP org** | Contractor or Concern Pharma on full / partial ERP | Chassis + ERP baseline + sold packs |
| **Feature-only org** | Barber salon chain — **not** an ERP / MEPF customer | Chassis + **only** sold packs (e.g. Chat / Flow) — no BB / Items / procure / DPR spine |
| **Exclusive-app org** | Later: “only this tenant gets App Y” | Chassis + exclusive pack(s); pack stays OFF for all other tenants |

Feature-only and exclusive-app orgs prove the platform sells **Sotyn app surfaces**, not only another Secured-style MEPF ERP. Baseline hubs are for ERP-class tenants, not a forced floor for every subdomain.

**1. Always-on chassis** (every tenant, including barber / Chat-only)

| Module | Why |
|---|---|
| Users / Roles / Permissions | Login + RBAC |
| Dashboard (home shell) | Post-login landing (may be nearly empty if few packs on) |
| Backups / Audit (admin) | Ops & recovery |
| Settings surfaces (as wired) | Tenant config |

**2. ERP business baseline** (default **ON** only for **ERP-class** plans — not for feature-only tenants)

| Module | Why |
|---|---|
| Employees | People master (attendance / payroll / payables lookups) |
| Customers | Light CRM master (e.g. Fire NOC, naming) |
| Vendors | Supplier master when anything is purchased |
| Business Book | Densest hub — projects/sites spine for this ERP |
| Item Master | Catalog spine for quotes / procure / stock |

Practical floor for “on Sotyn **ERP**” project work: **BB + Items + Vendors + Employees** (+ chassis). Without Business Book, most Procurement / Projects / Finance / Inventory screens are hollow.

**Nuance:** **solar-only** ERP SKU may skip Business Book. **Feature-only** SKU (barber + Chat) skips the whole ERP baseline.

**3. Optional packs** (plan / super-admin entitlements — the only “product” for feature-only orgs)

| Pack | Examples |
|---|---|
| Solar | whole Solar Division |
| Collab | Chat, Flow |
| CRM extras | Influencers, Full Kitting, dual funnels, quotations depth |
| Procurement / site | Indent to Dispatch, Orders, Gantt, Inventory |
| Projects | DPR, Snags, Indent Labour Payment, Sales Billing |
| Finance depth | Payables, Collections, Cash Flow, AR-AP, Cheques, Invoices |
| Attendance | Punch / muster as its **own** sellable pack (spine = chassis `users`; employees/leave soft; not forced `erp_baseline` / full HRMS) — salon-ready |
| HRMS depth | Payroll, Hiring, Sub-con, Champions / Performance (Payroll may require Attendance + employees) |
| Extras | AI, Tasks, Service Desk, Rentals / Assets, Fire NOC |

```text
ERP tenant        = chassis + ERP baseline + sold packs
Feature-only      = chassis + sold packs only   ← barber salon chain
Secured           = ERP tenant with **all packs ON** (seed entitlements full)
```

Tenant **Roles & Permissions** still carve who may use an entitled module; platform only decides which packs exist for that org.

### Golden asks (what plans must support) — Aug 2026

> **“Give Sotyn Chat to Concern Pharma.”**  
> **“Give app features to a barber salon chain — not an ERP customer.”**  
> **“Make App Y exclusive to tenant X.”** (later)

Together these define selling from one image + wildcard tenancy:

| Ask | Tenant class | Meaning |
|---|---|---|
| Chat → Pharma | MEPF/ERP org (partial pack) | Entitle `collab` only; other ERP packs unchanged |
| Features → barber chain | **Feature-only** | Onboard slug + chassis; entitle packs; **no** MEPF spine |
| Exclusive App Y → X | **Exclusive-app** | Pack OFF by default worldwide; ON only for X |

| Piece | Meaning |
|---|---|
| **Org** | One onboarded tenant (`{slug}-erp.sotyn.com`) — slot ≠ product type |
| **Feature / pack / app** | Optional surface — not the whole sidebar |
| **Give / exclusive** | Super-admin entitlements in `platform.db` |
| **Not this** | Not Roles-only toggles, not a code fork, not “every slug is an MEPF contractor” |

**Implications already locked elsewhere:**

1. Entitlements live in **`platform.db`**, flipped from the super-admin panel  
2. Propagate into that tenant’s container (day‑1: materialize + recreate)  
3. App gates with existing `isModuleEnabled` / `ModuleGate` / `requireModuleEnabled`  
4. Tenant admins still own **who** inside the org may use an entitled feature (RBAC)  
5. Plans encode **tenant class** (MEPF/ERP vs feature-only vs exclusive) or empty baseline — never force hollow BB/Items nav on a salon  
6. **Secured (`secured`)** seeds with **all packs ON** — full surface as today’s single-org app (legacy data path remains the only other Secured special case)

Same shape later: Solar to X, Payables to Y, remove Champions from Z, Chat-only salon group, partner-only exclusive module.

### Entitlement API + hide/disable semantics (locked — Aug 2026)

**API stays coarse** (platform control plane — not ERP):

| Method | Path | Body / result |
|---|---|---|
| `GET` | `/api/tenants/:slug/entitlements` | `{ packs: { chassis: true, erp_baseline: true, projects: false, … } }` |
| `PUT` | `/api/tenants/:slug/entitlements` | same → upsert `tenant_entitlements` in **`platform.db`** |

- Pack keys = product catalog (not every RBAC leaf, not per Dashboard card).  
- Platform may refuse illegal **sells** via pack-level `dependsOn` (e.g. Procurement without ERP baseline hubs). That is plan integrity only.  
- Truth never lives in tenant `erp.db`.

**Hide / disable = best effort, loose coupling** — especially for composite ERP surfaces.

Dashboard, DPR (and similar rollups: CMD, scoring, AI) pull plumbing from many modules. Day‑1 entitlements must **not** require rewriting every JOIN or shipping a custom Dashboard per tenant class.

| Layer | Behavior |
|---|---|
| **1. Nav / `ModuleGate`** | Hide entry points for OFF packs — primary UX |
| **2. Pack front door** | `requireModuleEnabled` (or pack equivalent) on that pack’s **own** APIs only — hard 404/403 at the door |
| **3. Overlays / composites** | Dashboard, DPR, CMD, scoring, AI: **opportunistic sections** — if a source pack is OFF or a call fails → skip / empty / hide; **never** block the shell or 500 the home page |

**`dependsOn`:** used when **entitling packs** in the panel (don’t sell a hollow plan). **Not** used to make Dashboard/DPR refuse to boot when an upstream pack is off — those stay **overlay / soft** (see [module-depends-graph.md](multitenancy/module-depends-graph.md)).

**Explicitly out of day‑1 scope:**

- Per-tenant Dashboard layouts or DPR schema forks  
- Entitlement checks on every internal SQL JOIN  
- Perfect scrubbing of dead filters/columns in reports (empty / zero / hidden is enough)

| Tenant | Expectation |
|---|---|
| **Secured** | All packs ON → today’s full Dashboard / DPR behavior |
| **MEPF partial** | Thinner nav; Dashboard shows entitled tiles; missing sections omit, don’t error |
| **Feature-only** | Near-empty home + sold packs; don’t load MEPF DPR spine if projects / ERP baseline OFF |

**Override chain (Roles & Permissions — locked):** today’s ERP already has two in-tenant layers on Settings → Roles & Permissions:

1. **Module availability** popup — org kill-switch (`features.js` / `module-flags.json`), above the matrix  
2. **Permissions matrix** — per-role grants  

**Platform entitlements sit above both.** Effective show = entitled × module-flag ON × role allows.

| Priority | Layer | SoT | If OFF |
|---|---|---|---|
| 1 (highest) | Platform pack entitlement | `platform.db` | Hidden from ERP view (nav, Module availability list, matrix columns for that pack). Tenant admin cannot “turn on” what wasn’t sold |
| 2 | Module availability | tenant `module-flags` | Hidden for everyone in that org; **flags kept** when flipped back |
| 3 | Role permissions matrix | tenant `erp.db` | User lacks action; **matrix rows kept** when pack / flag returns |

Do **not** delete `module-flags` or `role_permissions` when platform turns a pack OFF — same preserve rule as matrix vs entitlements. Module availability UI should only list (or only allow toggling) modules inside entitled packs; entitlement wins if a stale flag says ON.

### Self-note — gradual entitlement development (Aug 2026)

Interdependence is real; **do not freeze the full pack catalog before coding**. API stays pack-level forever; **which packs exist** grows step by step. Treat `dependsOn` and hub JOINs as a discovery backlog, not a day‑1 blocker.

**Ladder (prove each rung before inventing the next):**

| Step | Entitle | Clears |
|---|---|---|
| **1** | `chassis` only (always ON) | Platform → ERP “what is sold” read path; login / users / roles / empty dashboard shell |
| **2** | One **island** pack OFF/ON | Softest: Chat or Tasks / Service Desk — nav hide + pack API door; almost no hub JOINs |
| **3** | One **standalone sellable** | Attendance (spine = chassis `users`) — salon-style without `erp_baseline` |
| **4** | One **hub** pack alone | e.g. Items or Vendors OFF children — see orphan UI; hide best-effort, don’t micro-pack yet |
| **5** | Thin **`erp_baseline`** | Employees + customers + vendors + book + items as *one* pack for MEPF orgs |
| **6** | Chain packs | Procurement / Projects / Finance — only after baseline exists |
| **7** | Overlays last | Dashboard / DPR = opportunistic sections; never block shell on missing packs |

**Rules while climbing:**

- Platform stores **pack booleans** only (not ~80 leaf module flags).
- ERP maps pack → existing kill-switch / `ModuleGate` keys.
- Orphan UI when parent ON / child OFF → **hide the orphan**; add a pack or `dependsOn` only when a real sale needs “X without Y”.
- Golden asks drive the next rung (e.g. pharma + Chat, salon + Attendance) — not a complete sidebar matrix.

**Explicit anti-goal:** designing the finished `{ chassis, erp_baseline, projects, solar, … }` config as “correct” before step 1–3 ship. Full catalog in fixtures/docs is a **wishlist**, not locked product truth until sold and proven.

See also [module-depends-graph.md](multitenancy/module-depends-graph.md) (hubs / soft vs hard / overlays).

### White-label — org name & logo (locked notes — Aug 2026)

**Secured is a tenant, not the default.** Product chrome must not assume “Secured Engineers / SEPL logo” is the fallback for every slug. Secured gets the same branding fields as Pharma or a salon; its only special case remains the **legacy data path** (`/root/erp/data` bind-mount), not identity.

| | **Platform (super-admin)** | **Tenant app (client module)** |
|---|---|---|
| **Owns** | Per-org display name, logo asset/URL; onboard + Brand tab | Renders name/logo on shell surfaces |
| **Does not** | Render every PDF itself | Hold a second branding SoT |

**Propagate:** platform writes branding → agent materializes onto tenant config mount and/or `data/` (same family as entitlements) → tenant loads on boot. Hosted orgs: platform can override; optional later: tenant admin edits own logo/name.

**White-label these (priority):**

1. Login (name + logo)  
2. Sidebar / header  
3. Document title + favicon  
4. Email from-name / footer (when sending as the customer)  
5. Print / PDF letterhead (many surfaces still hardcode Secured today)

**Defer / out of scope:** per-tenant theme/colors (ERP UI stays one shared palette); rewriting every “SOTYN.AI” help string; custom domain (separate from wildcard).

**Two marks:**

- **Customer brand** — their name + logo  
- **Sotyn product mark** — optional small “Powered by Sotyn” (useful on feature-only deals)

**Ops:** logo on tenant volume or S3 under that slug’s prefix (survives container recreate); platform keeps metadata + URL; size/type limits; missing logo → generic Sotyn mark, **never** Secured’s artwork as global default.

**Platform UI (enough):** org card — display name, logo upload, login preview.

### Field / mobile access (locked notes — Aug 2026)

Management wants **field workers** on phones without a full desktop ERP experience. Same tenant URL + entitlements; different **client shell**.

| Decision | Choice |
|---|---|
| **Primary** | **WebView / PWA** against `{slug}-erp.sotyn.com` — not a second backend |
| **Home screen** | Installable icon (PWA manifest + apple-touch-icon) using **that tenant’s white-label** name/logo |
| **Per-tenant** | Manifest + icons derived from branding config; field-oriented start URL / nav subset later if needed |
| **Optional later** | **Mini downloadable app** (store or sideload wrapper) **only for some tenants** — thin WebView shell pointing at their slug; sold/entitled like an exclusive pack, not a fork of the ERP |
| **Not** | Separate field API or separate field database per worker app |

```text
Same tenant container + packs
        ↑
   PWA / WebView shell  (all field tenants)
        ↑
   optional native wrapper  (entitled tenants only)
```

**Platform considerations:** toggle “Field PWA” / “Downloadable wrapper” on the org; ensure branding assets sized for home-screen icons; deep links stay on tenant host. RBAC + module entitlements still gate what field users see.

#### Field-frequent modules (traced Aug 2026 — for field shell / responsive UI)

Evidence: GPS/selfie, `capture="environment"`, site-engineer scoping, pinned Chat — not a usage-analytics study. Use this list to **prioritize mobile/WebView UI polish** and a slim field home; desktop can keep the full sidebar.

**Daily / near-daily (field-first — polish first):**

| Module | Why field |
|---|---|
| Attendance | Punch-in/out with GPS + selfie |
| Daily Reports (DPR) | Site-engineer / supervisor scoped; photos; site slips / consumption |
| SOTYN Chat | Pinned nav; push/toast; voice |
| Snags | Raise/close with rear-camera proof |
| Indent to Dispatch | Site engineers raise/edit indents (`procurement.create`) |
| Inventory (site store / issue) | Site stock; issues tied to sites / DPR |

**Frequent, not every punch:**

| Module | Why field |
|---|---|
| Tools | Assigned to sites |
| Tool Rentals | Stage 2: live photo + GPS on material receive |
| Delegations / PMS Tasks | Camera proof on submit |
| Help Tickets | Photo proof from phone |
| Checklists | On-site tick-offs |
| SOTYN Flow | Pinned near Chat; boards if entitled — less “must open daily” than Chat/DPR |

**Occasional field / mostly view:** Order to Planning (assignment), Performance / Champions, Fire NOC, Complaints.

**Not field-frequent (keep desktop-first):** Payables, Collections, Cash Flow, AR-AP, Payroll, Hiring/ATS, Solar masters, Admin/Settings, heavy Business Book edit, Gantt, AI estimator.

**Suggested field shell shortlist (MEPF tenant):** Attendance · DPR · Chat · Snags · Indents · Site inventory/tools · (+ Tasks/tickets if used).

**Feature-only tenant (e.g. salon + Chat):** often Chat only (+ Attendance only if HRMS lite is sold).

**UI refine implication:** responsive / thumb-friendly work lands on the daily + frequent rows first; do not spend field-shell budget on finance/admin screens unless a pack explicitly targets field for that tenant.

**Three ownership buckets:**

1. `platform.db` — tenant registry, plan, **`enabled_modules`**, host/container/port metadata  
2. Tenant `erp.db` — roles, `role_permissions`, tenant-owned settings (on that org’s mounted `data/`)  
3. Optional disposable cache of entitlements — never trusted after restore  

**Onboarding:** platform → agent → `mkdir` host data dir → start container with volume → first boot seeds empty schema → nginx map → monitor. Secured: adopt existing `/root/erp/data` mount (no mkdir of a new pantry).

### Entitlement propagation (locked — Aug 2026)

**Problem:** panel writes `platform.db`; the running ERP container must learn the new plan.

**Day 1 (ship this):**

1. Truth only in `platform.db`  
2. Agent **materializes** entitlements for that org (small file and/or env on a config mount — not authoritative inside `erp.db`)  
3. ERP **loads on boot** into memory → module gates  
4. On plan/feature change in the panel → agent **recreates that one container** (data volume untouched)  

Simple, debuggable, fits Docker-per-org. Short blip is acceptable for rare plan edits.

**Expand later (same design — do not replace):**

- ERP **polls** platform (or re-reads the mounted file) on a **60–120s TTL**, and/or  
- Agent calls a secured internal reload endpoint  

Recreate stays as fallback and as the deploy path. Avoid per-request calls to platform on every API hit, and avoid a Redis/Kafka invalidate bus until scale demands it.

**Industry parallel:** day 1 ≈ PaaS/Docker “restart on config change”; later ≈ feature-flag SDK / short-TTL cache — without a second source of truth.

**RECOVERY.txt:** per-tenant on each data volume; plaintext delivery → show-once via panel for hosted orgs.

---

## Worker agent (locked shape — Aug 2026)

The agent is the **only** process on a worker that may touch Docker, tenant data dirs, and that host’s nginx tenant map. Platform is UI + `platform.db`; agent is hands.

### Where it lives

| | |
|---|---|
| **Monorepo** | `platform/worker-agent/` (same SEPL repo as ERP + platform UI) |
| **Runs on** | Every worker VPS (day‑1: colocated with platform on VPS‑1; later: VPS‑2+ agent-only) |
| **Process** | Small Node (or similar) HTTP service — **run script** locally; systemd/Docker on prod |
| **Listen** | `127.0.0.1` on day‑1 (platform on same box). Later: private IP / WireGuard / SSH tunnel — **not** public internet |
| **Auth** | Shared secret (or mTLS later): `Authorization: Bearer <AGENT_TOKEN>` on every call |
| **Not** | Not the super-admin UI; not inside a tenant ERP container; no public `*-erp` hostname |

```text
platform.sotyn.com  --HTTPS-->  platform process
                                    |
                                    | HTTP + Bearer (localhost or private net)
                                    v
                              worker-agent :7200
                                    |
                    +---------------+---------------+
                    v               v               v
                 Docker        tenant dirs         nginx map
```

### Ingredients (what the agent is made of)

1. **HTTP API** — verbs below (JSON in/out)  
2. **Docker driver** — Docker Engine CLI (`docker run` / start / stop / rm); same on local smoke and prod. Host data bind-mounted to container `/app/data`.  
3. **Filesystem** — `mkdir` under `TENANTS_ROOT/{slug}/data` for new orgs; secured: adopt `SECURED_DATA_PATH` (local repo `data/`, prod `/root/erp/data`), never mkdir-as-new under `tenants/secured`  
4. **Entitlements materializer** — write plan file/env from platform payload (not SoT)  
5. **Nginx map writer** — update host→port fragment + reload  
6. **Health probe** — HTTP check tenant container’s health URL after start  
7. **Host identity** — `host_id`, capacity hints reported to platform  

### API surface (day‑1 verbs)

Base path illustrative: `http://127.0.0.1:7200/v1`. All require Bearer token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Agent itself up |
| `GET` | `/v1/host` | Host id, free ports hint, disk/RAM snapshot (coarse) |
| `GET` | `/v1/tenants` | List org runtimes this host knows (slug, status, port, image) |
| `GET` | `/v1/tenants/:slug` | One org: container state + last health |
| `POST` | `/v1/tenants` | **Provision** — body: `{ slug, image, port, env, entitlements, dataPath? }` → mkdir (if new), materialize entitlements, `docker run`, nginx map, healthcheck. Secured: `dataPath=/root/erp/data`, skip mkdir |
| `POST` | `/v1/tenants/:slug/start` | Start stopped container |
| `POST` | `/v1/tenants/:slug/stop` | Stop (pause org) |
| `POST` | `/v1/tenants/:slug/restart` | Restart / recreate **same** volume + image (or refreshed entitlements) |
| `PUT` | `/v1/tenants/:slug/entitlements` | Materialize new entitlements then **recreate** that container (day‑1 propagation) |
| `POST` | `/v1/deploy` | Body: `{ image }` — pull tag, rolling recreate **all** tenants on this host (volumes untouched) |
| `DELETE` | `/v1/tenants/:slug` | Stop + remove container; **do not** delete data dir unless `wipeData: true` (dangerous, audited) |

### Later verbs (same agent, add when multi-VPS move is real)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tenants/:slug/export` | Quiesce + package/stream data dir for move |
| `POST` | `/v1/tenants/:slug/import` | Receive data dir onto this host + provision |

### What the agent does **not** own

- `platform.db` / plans / pricing / operator login  
- Wildcard DNS/TLS (edge stays global)  
- Choosing which worker gets a new org (platform scheduler)  
- Tenant business data APIs  

### Local vs prod driver

| | Prod | Local (tenant ERP when exercising multitenancy) |
|---|---|---|
| Runtime | Docker + bind mounts | **Same** — Docker + bind mounts (`tenants/{slug}/data` or adopt `data/` for secured) |
| Everyday secured / platform | — | npm scripts (Docker off) |
| Nginx | Write + reload | Skip |
| API | Identical `/v1/...` | Identical — platform always calls agent |

### Platform control-plane safety (requirements — Aug 2026)

Not built yet. Do not confuse with **tenant ERP** Backups / Audit (chassis inside each org). These are **platform-only**.

**1. `platform.db` backup / restore (do sooner)**

- Control plane truth lives in one SQLite file (`platform/data/platform.db` locally; host path on VPS).
- Need: operator-triggered backup (file copy / `VACUUM INTO`), durable backup dir, download or host-path retention; documented restore.
- Optional later: scheduled backups + retention; still separate from per-tenant ERP DB backups.
- Why early: orgs + branding already write here; entitlements/agent will raise blast radius.

**2. Platform audit logs (skeleton early OK; full UI after mutations matter)**

- Separate from ERP activity logs. Platform records **operator** actions on the control plane.
- Events to capture (minimum): login failures / operator login, create/update tenant, brand save / asset upload, entitlement Save, provision / start / stop / pause, backup / restore, export dev config (when wired).
- Shape: `platform_audit` (or similar) in `platform.db` — who, when, action, tenant slug if any, payload summary; Audit nav page + per-org “View audit” (UI still dimmed / later today).
- Sequencing recommendation: lightweight backup first → persist entitlements → write audit on those mutations (and later agent verbs) → fuller Audit UI. Full audit product before Save/provision is optional early skeleton only.

---

## Suggested resume order

| Step | Work | Status |
|---|---|---|
| 0 | Docs synced: **Docker-all-orgs / no-move-secured** + **local scripts** + **capacity 2–3** + **local agent day 1** | ✅ |
| 0b | Platform boilerplate (`platform/`) + Secured white-label seed + Brand pencil UI | ✅ started |
| 0c | **`platform.db` backup/restore** (operator download or host copies) | ❌ requirement noted |
| 0d | **Platform audit** write path + Audit UI (after entitlements/agent mutations grow; thin stub OK earlier) | ❌ requirement noted |
| 1 | Dockerfile: same app, bind-mount `data/` (`Dockerfile` + `.dockerignore`) | ✅ |
| 2 | Worker agent (`platform/worker-agent/`): `/v1` API + **Docker driver** (provision/start/stop; secured adopt) | ✅ docker mode |
| 3 | `platform.db` + host registry + entitlements; platform always calls agent; **local = run script** | 🟡 db + orgs/branding; packs via **gradual ladder** (PHASE4 self-note), not full catalog first |
| 4 | Super-admin panel on `platform.sotyn.com` | 🟡 local UI pencil |
| 5 | Wildcard DNS/TLS `*-erp.sotyn.com` + nginx host→port | ❌ |
| 6 | Cutover secured → Docker (bind `/root/erp/data`); canary org #2 on `/var/lib/sotyn/tenants/…` | ❌ |
| 7 | Later: remote agent on VPS‑2 + tenant move; optional paths.js hygiene | ❌ |

---

## Explicit non-goals

- Moving or copying secured `/root/erp/data/*`  
- Forking / copying the repo into `/root/<app-name>` per customer  
- One Node process serving all tenants’ DBs  
- Putting entitlements only in tenant `erp.db` as source of truth  
- Symlink-flipping live `data/` for secured  
- Requiring Docker for default local ERP / platform / agent development  

---

## Quick pointers in code

```
server/lib/paths.js          # DATA_ROOT (local: flat data/; Docker: mount supplies data/)
server/lib/features.js       # Module availability (org kill-switch; restore-safe file)
server/lib/storage.js        # keyPrefix() — S3_KEY_PREFIX per container env
docs/DEPLOY-disk-space-reclaim.md
ecosystem.config.js          # current secured PM2 (pre-cutover reference: cwd /root/erp, PORT 5000, heap 512M)
```
