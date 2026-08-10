# Multitenancy references (Phase 4 — parked)

Design-only docs. Nothing here is implemented in the app.

**Product vision:** `{slug}-erp.sotyn.com` is a **tenant slot** (wildcard DNS + auto SSL) — may or may not be an **MEPF ERP** customer. Sell **packs/apps** from the super-admin panel (Chat→Pharma, feature-only salon, later exclusive apps). **All orgs Docker from day 1** — secured bind-mounts `/root/erp/data/*` (no move); new orgs `/var/lib/sotyn/tenants/{slug}/data`. **Platform** at `platform.sotyn.com` drives a **worker agent**. **Local default:** run scripts. **First VPS capacity:** secured + ~2–3 other orgs on 4 GB RAM.

| File | What it is |
|---|---|
| [tenant-model-ideation.html](tenant-model-ideation.html) | Original Jul 2026 team concept draft (plain language). Open in a browser. |
| [super-admin-panel-sketches.html](super-admin-panel-sketches.html) | Draft screen sketches for the Layer‑1 orchestration / super-admin panel. Open in a browser. |
| [../PHASE4-tenant-model.md](../PHASE4-tenant-model.md) | Engineering resume notes (decisions, open forks, prerequisites). |
| [module-depends-graph.md](module-depends-graph.md) | Traced cross-module `dependsOn` graph (hubs, hard/soft edges, pack sketch). |

Source of the ideation HTML (outside this repo): `D:\projects\observations\tenant-model-ideation.html`.
