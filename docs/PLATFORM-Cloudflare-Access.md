# Platform access — Cloudflare Access

**Decision (Aug 2026):** Limited exclusive access to `platform.sotyn.com` uses **Cloudflare Access** (Zero Trust). Fixed trusted operators only (≈2–3 people). Free for up to 50 seats; company-usable; Mac + Windows need only a browser.

**Do not remove platform login.** Access = who can reach the UI at all. Platform JWT / operators / audit = who is signed in and what they did. Keep both.

Related: [`PLATFORM-VPS-deploy.md`](./PLATFORM-VPS-deploy.md) · platform UI **Docs → Access**.

---

## Target architecture

```
Operator browser (Mac/Windows)
    │  HTTPS
    ▼
Cloudflare edge  →  Access policy (email OTP / IdP)
    │  only allow-listed operators pass
    ▼
nginx  platform.sotyn.com  (orange-cloud DNS)
    ├─ static → platform/client/dist
    └─ /api   → 127.0.0.1:7100
         │
         ▼
    Platform login (JWT)  ← keep as built
```

- **Tenant ERP** (`*-erp.sotyn.com`) — leave public (do not put Access on every tenant unless you intend to).
- **Worker agent** — stays `127.0.0.1:7200` (never public).
- **No VPN app**, no `apt install` for Access on the VPS.

---

## Prerequisites

| Need | Notes |
|---|---|
| Cloudflare account | Free plan + Zero Trust free (≤50 seats) is enough |
| Domain on Cloudflare DNS | `sotyn.com` nameservers → Cloudflare |
| `platform.sotyn.com` | A/AAAA → VPS IP, **proxied** (orange cloud) |
| Platform on VPS | nginx → `127.0.0.1:7100` + static UI ([`PLATFORM-VPS-deploy.md`](./PLATFORM-VPS-deploy.md)) |
| TLS | Prefer Cloudflare **Full (Strict)** + Let’s Encrypt (or origin cert) on nginx |
| Operator emails | The 2–3 people who may open the control plane |

Nothing to install in `platform/` npm packages.

---

## 1. One-time: Zero Trust org

1. Cloudflare dashboard → **Zero Trust** (Cloudflare One).
2. Create a team name if prompted (one-time).
3. Confirm plan shows **Free** (or paid if you already upgraded).

---

## 2. Identity provider (pick one)

**Simplest for 2–3 operators:** **One-time PIN** (email OTP).

Zero Trust → **Settings → Authentication → Login methods** → enable **One-time PIN**.

Optional later: Google / Microsoft / GitHub if everyone already uses that IdP.

---

## 3. Access application for the platform

1. Zero Trust → **Access → Applications → Add an application**.
2. Type: **Self-hosted**.
3. Name: e.g. `Sotyn Platform`.
4. Application domain: `platform.sotyn.com` (path can be `*` / leave default so all paths are gated).
5. Session duration: e.g. 24 hours (your choice).
6. **Add a policy:**
   - Action: **Allow**
   - Include: **Emails** → list operator addresses (e.g. `sotyn.soft@gmail.com` and the other 1–2).
7. Save.

Only those emails pass Access. Everyone else sees Cloudflare’s block / login wall.

---

## 4. Operator day-to-day

1. Open `https://platform.sotyn.com`.
2. Cloudflare Access asks for **email** → enter allow-listed address → receive **OTP** (or IdP login).
3. After Access succeeds → **platform `/login`** → username + password as today.
4. When Access session expires, they re-do step 2; platform JWT is separate.

**They do not need:** a VPN client, or any install from the monorepo.

**Add an operator**

1. Add their email to the Access policy Include list.
2. Invite them in platform **Operators** (app account).

**Remove an operator**

1. Remove email from Access policy (and/or revoke Access sessions in Zero Trust → Users).
2. Platform **Operators → Deactivate**.

---

## 5. VPS / nginx notes

- DNS for `platform.sotyn.com` **must** be orange-clouded or Access never sees the traffic.
- Keep platform API bound to `127.0.0.1` (already).
- Optional harden: firewall **only Cloudflare IP ranges** to ports 80/443 so origin cannot be hit by bypassing DNS.
- `PLATFORM_PUBLIC_URL=https://platform.sotyn.com` so invite/reset links match the public hostname.

---

## 6. Platform app — no auth removal

Keep as built:

- `/login`, JWT, bcrypt, invite / reset / set password  
- Operator activate/deactivate  
- Audit log  

Optional later (independent of Access): login rate-limit, CORS locked to `PLATFORM_PUBLIC_URL`.

---

## 7. Smoke test checklist

1. Browser **not** on allow list → Access blocks / cannot complete OTP.  
2. Allow-listed email → OTP → platform login works.  
3. Wrong platform password still fails (Access ≠ platform auth).  
4. Agent still only on `127.0.0.1:7200`.  
5. Tenant ERP public URLs still work (no Access unless you added it).

---

## 8. If Cloudflare starts charging / free seats change

Access is only a front door — not baked into platform code.

| Exit | Notes |
|---|---|
| Pay Zero Trust seats | Fine for 2–3 people |
| Temporary | nginx IP allowlist (fragile on mobile IPs) |
| Later | Another edge identity product — still keep platform JWT |

---

## Status in the plan

| Item | Status |
|---|---|
| Decision: Cloudflare Access for platform exclusive access | ✅ documented |
| Keep platform JWT / operators | ✅ do not remove |
| Zero Trust app + policy on `platform.sotyn.com` | ❌ ops in Cloudflare dashboard |
| Productized “Access button” in platform UI | ❌ out of scope (dashboard runbook only) |

Resume: after platform nginx is up ([`PLATFORM-VPS-deploy.md`](./PLATFORM-VPS-deploy.md)), create the Access application above.
