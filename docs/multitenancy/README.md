# Multitenancy references (Phase 4 — parked)

Design-only docs. Nothing here is implemented in the app.

**Product vision:** `{slug}-erp.sotyn.com` tenant slots; all orgs Docker under `TENANTS_ROOT/{slug}/data` (incl. secured). Platform at `platform.sotyn.com` drives a worker agent. Local default: run scripts.

| File | What it is |
|---|---|
| [tenant-model-ideation.html](tenant-model-ideation.html) | Original Jul 2026 team concept draft (plain language). Open in a browser. |
| [super-admin-panel-sketches.html](super-admin-panel-sketches.html) | Draft screen sketches for the Layer‑1 orchestration / super-admin panel. Open in a browser. |
| [../PHASE4-tenant-model.md](../PHASE4-tenant-model.md) | Engineering resume notes (decisions, open forks, prerequisites). |
| [module-depends-graph.md](module-depends-graph.md) | Traced cross-module `dependsOn` graph (hubs, hard/soft edges, pack sketch). |

Source of the ideation HTML (outside this repo): `D:\projects\observations\tenant-model-ideation.html`.
