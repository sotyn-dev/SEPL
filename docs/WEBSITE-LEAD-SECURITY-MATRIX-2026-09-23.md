# Website-lead webhook — security test matrix, 23 September 2026

Route: `POST /api/webhooks/website-lead` (`server/routes/webhooks.js`)
Branch: `fix/website-lead-no-browser-secret`
Tests: `server/routes/__tests__/websiteLead.route.test.js` — **16 cases, 16 passing**

```
node --test server/routes/__tests__/websiteLead.route.test.js
```

Case 4 tests the property "no secret opens this route when none is configured",
which covers the exposed value without writing it down again. To assert the real
historical value specifically, recover it from history and pass it in — it is
never echoed, and never reaches the test output:

```
LEAKED_SECRET="$(git show f70726f7:server/routes/webhooks.js | grep -m1 'WEBSITE_WEBHOOK_SECRET ||' | sed "s/.*|| *'//; s/'.*//")" \
  node --test server/routes/__tests__/websiteLead.route.test.js
```

Run that way on 23 Sep 2026: 16 passing, the historical value refused on all five carriers.

## Why the auth model changed

From 21 September 2026 the public website appended `WEBSITE_WEBHOOK_SECRET` to the
webhook URL inside the JavaScript of every page, so the credential was readable by
anyone who opened View Source. Found 22 September.

The route also shipped a **fallback value in the source**, so the secret was in the
public git history of the ERP as well as in the website's HTML. A value committed to
a repository and inlined into a static bundle is not a credential.

The fix does not try to give a static site a secret it cannot keep. Instead:

- **The website is recognised by `Origin`.** A browser sets that header itself and
  page script cannot forge it, so a form on `securedengineers.com` is admitted and a
  form on any other site is not. Same reasoning and same shape as
  `routes/publicSotynLead.js` already uses for the sotyn.ai forms.
- **The secret path is server-to-server only, and has no fallback.** Unset, it is
  simply closed.
- **The route is write-only.** It inserts one `sales_funnel` row and returns its
  number. It never reads a lead back and never lists anything.

Origin is an authenticity signal, not an authorisation control, so it is backed by
the honeypot, field validation, per-IP limits and idempotency — each tested below.
Origin alone is **not** treated as sufficient to protect anything privileged, and no
privileged capability sits behind this route.

## The matrix

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | No `Origin`, no secret | 401 | pass |
| 2 | Forged / look-alike `Origin` — `evil-securedengineers.com`, `securedengineers.com.attacker.dev`, `www.securedengineers.com.evil.test`, plain `http://`, literal `null`, case-mangled, non-default port | 401 for all 7 | pass |
| 3 | Real site `Origin` (both apex and `www`) | 201, one row each | pass |
| 4 | **Any secret at all** while none is configured — in `x-webhook-secret`, `x-api-key`, `Authorization: Bearer`, `?secret=` and the JSON body; run once with the real historical value | 401 for all 5 | pass |
| 5 | SQL injection in `name` (`Robert'); DROP TABLE sales_funnel;--`), `<script>` in company, NUL byte in details | 201, stored verbatim, table intact | pass |
| 6 | Missing `name` | 400, nothing written | pass |
| 7 | Honeypot field filled | 200 `success:true`, **no row** — a bot must not learn it was caught | pass |
| 8 | Body above the 1 MB parser limit | ≥400, never 201 | pass |
| 9 | Value band `₹50 lakh – ₹1 crore` | stored as ₹50 lakh, the floor | pass |
| 10 | **Replay** — same website reference four times | first 201, then 200 `duplicate:true` with the same `lead_no`; exactly one row | pass |
| 11 | **Concurrency** — four simultaneous copies of one submission | exactly one row | pass |
| 12 | Burst of 12 from one address | 9th is the first 429 | pass |
| 13 | **Refused requests spend the allowance** | 8 × 401, then a genuine enquiry is 429 | pass — see finding A |
| 14 | Rotating `X-Forwarded-For` | still limited; the header is not read | pass |
| 15 | `X-Real-IP` from a loopback socket | honoured, one allowance per address | pass — see finding B |
| 16 | Configured secret, server-to-server | 201 with no `Origin`; near-miss secret 401; 20 in a row not limited | pass |

Case 11 deserves a note. The idempotency check is a `SELECT` then an `INSERT` with no
transaction and no unique index, so a true race could in principle insert twice. Under
four concurrent requests on this build it does not, because `better-sqlite3` is
synchronous and the single-process server serialises them. **That is a property of the
deployment, not of the code.** If the ERP ever runs more than one process, or moves off
SQLite, case 11 is the test that will catch it — which is why it asserts the row count
rather than the status codes.

## Findings

### A. A refused request spends the rate-limit allowance (availability, medium)

The limiter sits in front of the handler, so **every** request counts — including the
401s. Eight refusals from one address leave a genuine visitor on that address with
nothing left for ten minutes. Behind a factory's single NAT that is everyone in the
building, and the website retries a slow post, so three enquiries that each retry twice
already reach nine.

This is a lead-loss risk, not a theoretical one. Two options, both small:

1. Count only requests that reach the handler, so refusals and honeypot hits do not
   spend a real visitor's allowance.
2. Raise the burst window from 8 per 10 minutes to something a shared office IP will
   not trip — 20 per 10 minutes still stops a scripted flood.

**Not changed in this branch.** It trades spam resistance against enquiry loss, and
that is the director's call, not mine.

### B. `X-Real-IP` is trusted from any loopback connection (latent, low)

`clientIp()` trusts `X-Real-IP` only when the socket peer is loopback, because nginx
overwrites the header for traffic it forwards. The security property this depends on is
that **nothing except nginx can open a loopback connection to the Node port.** If the
port is ever bound publicly, or another process on the box can reach it, `X-Real-IP`
becomes a free rate-limit bypass. Worth an explicit `listen 127.0.0.1` check on the
next VPS review.

### C. Lead capture depends on a table the schema bootstrap does not create (latent, low)

`sales_funnel` carries `influencer_id INTEGER REFERENCES influencers(id)` and the
connection sets `PRAGMA foreign_keys = ON`, so SQLite refuses **every** insert into
`sales_funnel` while the `influencers` table is missing. `initializeDatabase()` creates
211 tables and that is not one of them — `server/routes/influencers.js` creates it, as a
side effect of being required.

On the live server every route is required at boot, so both happen and nothing is wrong
today. But on a fresh database — a new deployment, a restore, a DR rebuild — lead
capture returns 500 on every enquiry until an unrelated route module has loaded. Found
because the test harness boots the schema without mounting all routes, and every insert
failed with `no such table: main.influencers`.

Suggested fix, separately: move the `influencers` table into `initializeDatabase()`
alongside the other 211, so the sales funnel does not depend on module load order.

## What still has to happen before this is closed

1. Merge this branch and deploy the ERP.
2. Deploy the website change that stops publishing the secret (`sotyn-dev/secured-engineers-website` PR #141), which also adds build gate **E6** — a credential in a lead endpoint URL fails the build.
3. **Then** rotate `WEBSITE_WEBHOOK_SECRET` on the server only. Never in the site's build.

Order matters: rotating before the website ships would break nothing (the site no longer
sends a secret) but rotating before the ERP ships would close the only path the current
site has.

The old value is not printed here, in the tests, or in any report — only tested as a
string that must now be refused.
