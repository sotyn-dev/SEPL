# White-label surfaces — ERP integration checklist

Pencil first in the platform Brand tab. Wire into the tenant ERP later (do not hardcode Secured as global fallback).

Priority matches `docs/PHASE4-tenant-model.md` § White-label.

| Priority | Surface | Current Secured hardcode (examples) | Consume branding field |
|---|---|---|---|
| P0 | Login | `Login.jsx` — `/sepl-logo.webp`, “Secured Engineers Pvt Ltd”, SOTYN.AI | `assets.logo`, `displayName` / `legalName`, `productMark`, `loginTagline` |
| P0 | Sidebar / header | `Layout.jsx` — logo + “Secured Engineers” | `assets.logo`, `displayName`, `shortName` |
| P0 | Document title + favicon | `client/index.html`, `manifest.json` | `pwa.*`, `assets.favicon` / `icon` (shared ERP theme — no per-tenant colors) |
| P1 | Email from-name / footer | mailer templates (when sending as customer) | `displayName`, `legalName` |
| P2 | Print / PDF letterhead | `VendorPOPrint.jsx`, `OfferLetterPrint.jsx`, `NDAPrint.jsx`, `IndentPrint.jsx`, Delivery Note / Sales Bill | `legalName`, `assets.logo`, address/GST later |

**Deferred:** per-tenant theme/colors (ERP keeps one shared palette); every help string; custom domain.

**Assets extracted (seed for slug=`sepl` only):**

- `platform/seed/tenants/sepl/assets/logo.webp` ← `client/public/sepl-logo.webp`
- `platform/seed/tenants/sepl/assets/logo.png` ← `client/public/sepl-logo.png`
- `platform/seed/tenants/sepl/assets/icon.svg` ← `client/public/icon.svg`
- `platform/seed/tenants/sepl/assets/favicon.svg` ← `client/public/favicon.svg`
- `platform/seed/tenants/sepl/assets/icons.svg` ← `client/public/icons.svg`
- `platform/seed/tenants/sepl/branding.json` — field values from Login / Layout / manifest

**Integration shape (later):** platform writes branding → agent materializes onto tenant config mount → ERP reads once at boot (same family as entitlements). Until then, ERP keeps its hardcoded Secured chrome; platform Brand tab is the pencil SoT.
