# Trusted-device cookie — build spec for SEPL ERP

Hand this file to the developer (or Claude Code). Implement **this**, not a rewrite of auth and not Better Auth / SuperTokens.

**Repo:** SEPL ERP (`server/` Express + SQLite, `client/` React, JWT in `localStorage`).  
**Do not** replace `generateToken` / `authMiddleware`. The device cookie is **extra**, beside the existing Bearer JWT.

---

## 1. What we are building (plain language)

Today login only checks username + password, then issues a JWT. The server does not know if this is the employee’s usual phone or a new one.

**Trusted device** (industry pattern: “remember this device”):

1. After a successful login, the server creates a random secret, stores a **hash** of it in SQLite, and sets it as an **HttpOnly cookie** on that browser.
2. Next login from the **same browser**: cookie is sent automatically → server finds the row → **known device**.
3. Login with **no cookie** (new phone, new Chrome profile, Incognito, cookies cleared) → **new device**.

This is **not** IMEI. Clearing cookies = new device. That is correct.

**JWT** = “this HTTP request is logged in.”  
**Device cookie** = “this browser was seen before for this user.”

---

## 2. Out of scope (do not do in this ticket)

- Do not add SMS/WhatsApp OTP unless a follow-up ticket says so. This ticket is: detect + log + tell admin + show the user. Optionally **block** new-device login until admin approves — see §7; default is **allow login but flag**.
- Do not disable Inspect / screenshots.
- Do not use FingerprintJS.
- Do not treat IP as “new device” (Jio IPv6 rotates). IP is stored only as context on the row.

---

## 3. Grounds for “new device”

| Signal | Use? |
|---|---|
| Cookie `sepl_did` present, hash matches `trusted_devices` for **this** `user_id`, `revoked_at` IS NULL, `expires_at` in the future | **Known device** |
| No cookie, or cookie unknown / expired / revoked / belongs to another user | **New device** |
| User-Agent / IP | Store on the row for humans. **Do not** use as the primary match. |

First production deploy: every user’s next login looks “new” once. After that, their usual browser is known.

---

## 4. Database (SQLite)

Add in `server/db/schema.js` with the same `CREATE TABLE IF NOT EXISTS` style as other tables. Also add a **safeIndexes** entry if that is the project pattern.

```sql
CREATE TABLE IF NOT EXISTS trusted_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,          -- SHA-256 hex of the cookie secret
  user_agent TEXT,                          -- first seen / last seen UA, max 200 chars
  ip TEXT,                                  -- last login IP (context only)
  label TEXT,                               -- optional, e.g. "Chrome on Android"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,             -- now + 30 days; refresh on each known-device login
  revoked_at DATETIME                       -- set when user/admin revokes or password changes
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_hash ON trusted_devices(token_hash);
```

**Never store the raw cookie value** in the DB. Store `crypto.createHash('sha256').update(secret, 'utf8').digest('hex')`.

---

## 5. Cookie rules

| Attribute | Value |
|---|---|
| Name | `sepl_did` |
| Value | 32+ bytes cryptographically random, hex or base64url (the **secret**, not the hash) |
| HttpOnly | **true** (JS must not read it) |
| Secure | **true** in production (HTTPS). false only on localhost http |
| SameSite | `Lax` |
| Path | `/` |
| Max-Age | 30 days (2592000). Refresh on each successful **known-device** login (sliding). |

CORS in `server/index.js` already has `credentials: true`.  
Client: `client/src/api.js` axios instance uses `baseURL: '/api'` (same origin via Vite proxy) — cookies on `/` will be sent. If any axios instance uses another origin, set `withCredentials: true`.

Install `cookie-parser` if not already used; parse cookies on `POST /api/auth/login`.

---

## 6. Login flow (`POST /api/auth/login` in `server/routes/auth.js`)

Keep existing password / `active` / JWT logic. **After** the user is authenticated and **before** `res.json`:

1. Read cookie `sepl_did`.
2. If present, hash it, `SELECT` from `trusted_devices` where `token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`.
3. **Known:**
   - Update `last_seen_at`, `ip`, `user_agent`, `expires_at` (+30 days).
   - Re-set the **same** cookie Max-Age 30 days (or rotate secret: new secret, new hash, delete old row — rotation is nicer; either is OK if documented).
   - `logAuditEvent` with `action: 'LOGIN'`, and in `after_json` or `body_summary`: `{ device: 'known', trusted_device_id: <id> }`.
4. **New:**
   - Generate new secret, insert row, `Set-Cookie`.
   - `logAuditEvent` `action: 'LOGIN'` plus `{ device: 'new', trusted_device_id: <id> }`.
   - Also log `action: 'NEW_DEVICE_LOGIN'` (same user, ip, ua) so admin can filter easily.
   - Notify: see §8.
5. Response JSON: keep `token`, `user`, `permissions`. **Add**:
   ```json
   "device": { "status": "known" | "new", "id": 123 }
   ```
   Do **not** put the cookie secret in JSON.

Failed login (`401`/`403`): do **not** set or refresh the device cookie.

---

## 7. Policy on new device (default)

**Default (this ticket):** still issue JWT and let them in. Flag + notify. This matches “detect new device” without locking out the field on first cookie rollout.

**If product later wants lock:** env `REQUIRE_KNOWN_DEVICE=1` → new device returns `403` `{ error: 'New device. Contact admin.' }` and does **not** issue JWT. Do not enable this until every real user has logged in once on their usual phone.

---

## 8. Notify admin on new device

Reuse existing audit. Minimum:

- `NEW_DEVICE_LOGIN` in `audit_log` (must appear in Admin → Audit log with ip + user_agent).

If the app already has in-app notifications or Sentry, also ping there. Do **not** invent SMS for this ticket.

Optional UI: banner for **admins** on dashboard: “N new-device logins in last 24h” querying `action = 'NEW_DEVICE_LOGIN'`.

---

## 9. Revoke devices (required)

When **this user** changes password (`POST /api/auth/change-password`):  
`UPDATE trusted_devices SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL`.  
Next login from every browser is “new”. That is intended (stops a stolen cookie after they change password).

Same on **admin reset password** (`POST /api/auth/users/:id/reset-password`).

Same when **admin sets `active = 0`**.

**API for the logged-in user:**

- `GET /api/auth/devices` — list own rows: id, label, user_agent, ip, created_at, last_seen_at, expires_at (never `token_hash`).
- `DELETE /api/auth/devices/:id` — revoke own device by id.

**API for admin:**

- `GET /api/auth/users/:id/devices` — list that user’s devices (`adminOnly`).
- `DELETE /api/auth/users/:id/devices/:deviceId` — revoke.

---

## 10. Client (`client/src`)

- Login page: if `data.device.status === 'new'`, show a non-blocking notice: “This browser is not recognised. Admin has been notified.” Do not block login (unless §7 lock is on).
- Optional settings page: list devices from `GET /api/auth/devices` + “Remove” → DELETE.

Do not try to read `sepl_did` from JavaScript (HttpOnly).

---

## 11. Files to touch (expected)

| File | Change |
|---|---|
| `server/db/schema.js` | `trusted_devices` table + index |
| `server/routes/auth.js` | login cookie logic; change-password / reset / disable revoke; device list/revoke routes |
| `server/index.js` | `cookie-parser` if needed |
| `server/package.json` | `cookie-parser` if added |
| `client/src/pages/` login + optional devices UI |
| `client/src/api.js` | only if cookie not sent (same-origin `/api` should be fine) |

Keep comments in the same style as existing `auth.js` / `schema.js` (why, not essay).

---

## 12. Acceptance tests

1. Login user A in Chrome → cookie set, `device.status === "new"` first time, audit `NEW_DEVICE_LOGIN`.
2. Logout, login user A same Chrome → `device.status === "known"`, **no** new `NEW_DEVICE_LOGIN`.
3. Incognito login user A → `new` again, second row in `trusted_devices`.
4. Login user B in user A’s Chrome → cookie replaced or ignored for B; B gets their own row. Never attach A’s device row to B.
5. User A change password → all A’s devices `revoked_at` set; next login `new`.
6. Cookie copied to another machine (paste `sepl_did`) **will** look known until revoked — document this. HttpOnly reduces XSS theft; it does not stop someone with file access to the browser profile.
7. JWT still works as today: `Authorization: Bearer`. Requests without cookie but with valid JWT still work (API clients, old tabs). Device check is **login only**, not every API call.

---

## 13. Security notes for the implementer

- Secret: `crypto.randomBytes(32).toString('base64url')`.
- Compare hashes with a fixed-time compare if you compare raw secrets; looking up by hash in SQL is enough.
- Cap devices per user (e.g. 20); if over, revoke oldest `last_seen_at`.
- Do not log the raw cookie in `audit_log` / `body_summary`.

---

## 14. Suggested Claude Code prompt

Paste this:

> Read `docs/TRUSTED-DEVICE-BUILD-SPEC.md` and implement it against the existing SEPL ERP. Do not replace JWT auth. Do not add SMS OTP. Follow the spec’s table, cookie flags, login flow, revoke-on-password-change, and acceptance tests. Match existing code style in `server/routes/auth.js` and `server/db/schema.js`.

---

## 15. Follow-up (not this ticket)

Login OTP to `users.phone` on **new device only**. Cookie answers “have we seen this browser?” OTP answers “does the thief also have the SIM?” Together they match how banks do it.
