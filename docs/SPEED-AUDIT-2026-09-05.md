# SOTYN.AI — Speed / Hang Audit (2026-09-05)

*Why the ERP stalls, what was measured on the live server, what was fixed, and how to see slowness live without the VPS terminal.*

---

## 1. The one fact behind every hang

The server is **one Node process on better-sqlite3, which is synchronous**. Every SQL statement blocks the whole process. So one slow request — from any user, on any page — freezes **every page for every user** until it finishes. There is no pool to hide behind; only cheaper queries, indexes, caching and smaller payloads help.

## 2. Live evidence (production, 2026-09-05 ~17:30 IST)

60 probes of the trivial `/api/health` endpoint, 1.5 s apart, from outside:

| Measure | Value |
|---|---|
| Samples with > 0.5 s server-side wait | 16 of 60 (27%) |
| p90 server-side wait | 0.82 s |
| Longest single wait | 3.6 s |

A trivial endpoint that waits 3.6 s means something else was holding the event loop for 3.6 s. That is the "hang" users feel.

## 3. Method (repeatable)

1. Copy `data/erp.db` to a scratch folder and inflate the growth tables to a year's scale (`inflate.js` in the session scratchpad: 25k PMS tasks, 60k attendance, 400k location pings, 150k audit rows, 4k indents…).
2. Start a second server on it: `PORT=5077 ERP_DB_PATH=<copy> ERP_SQL_PROFILE=40 node server/index.js`.
3. Enumerate every `router.get()` (480 URLs) and hit each one sequentially, recording ms and bytes.
4. For the slow ones, aggregate the `[sql Nms]` profiler lines to name the exact statement, then `EXPLAIN QUERY PLAN` it.

`ERP_DB_PATH` and `ERP_SQL_PROFILE` were added for this and are safe to leave unset in production.

## 4. What was found and fixed

All 461 reachable GET endpoints, before → after, on the inflated copy:

| Endpoint | Before | After | Root cause → fix |
|---|---|---|---|
| Champions leaderboard | 86.2 s | 10.9 s* | Full scorecard computed per user × week (~100×). Expression indexes on the due-day filter + RACI row cache |
| Scorecard commitments graph | 51.2 s | 5.6 s* | Same |
| Scorecard weekly | 19.1 s | 4.1 s* | Same |
| Scorecard | 8.6 s | 3.1 s* | 96 `COUNT(*)` calls evaluating `date()/strftime()` per row → expression index (25 ms → <0.1 ms each) |
| Extra-indent quotation | 13.6 s | <0.1 s | Per-line lookup full-scanning PO items by lower-cased name → expression index on `LOWER(TRIM(description))` |
| Order Planning rates register | 7.4 s | <0.1 s | 3 correlated subqueries per PO line on unindexed `indent_items.item_master_id` / `order_planning_items.po_item_id` |
| DPR loss dashboard | 3.9 s | 0.17 s | One streak query per row → one grouped query + in-memory walk (verified identical on 800 rows) |
| RACI performance / breakdown | 1.2 s / 1.0 s | 1.5 s* / <0.5 s | `OR` across two tables in a per-indent subquery forced a full scan of delivery notes → two indexed lookups + `delivery_notes(indent_id)` |
| Admin Location live map | 1.0 s | <0.5 s | `location_tracking(user_id, time)` |
| Attendance list (bare call) | 5.3 s / 42 MB | 2.5 s / 19 MB | No filter returned every punch ever → default last 31 days (the UI always filters) |
| Labour Master dashboard | HTTP 500 | 200 | `GROUP BY name` resolved to the worker's own name column — an error on one query, silently wrong grouping on the other |
| **Total server time, all endpoints** | **234 s** | **64 s** | |

\* Still high **only on the inflated copy**, where one user owns all 25,000 tasks and one indent has 3,000 vendor POs; every remaining statement is index-driven (verified with `EXPLAIN QUERY PLAN`). Real data has hundreds of tasks per user and a handful of POs per indent.

Also fixed in the same pass:

- **Payroll** walked every day of a leave's full range before clipping to the month — one mistyped `to_date` (year 2999) was a request that never returned. Clamped to the month.
- **System Requirements workspace** called a hook after its loading return (React "rendered more hooks" → whole-ERP blank screen once that module is switched on). Moved above the guard; a scan found no other page with the pattern.
- **Location pings written twice**: the Attendance page and the app shell both posted a location every 30 s. The page now posts only its GPS-off heartbeat.
- **No client timeout**: a stalled request spun forever. Policy now: page data 60 s, writes 5 min, exports/backups/uploads/imports/AI 10 min; the error reads "The server took too long to respond".
- **Bulk load-once cache** (`server/lib/readCache.js`): expensive user-independent reads (RACI module rows) are computed once and shared for 15 s; every write request clears it, so a read after a write is always fresh.

## 5. See it live: Admin ▸ Settings ▸ Performance

`/admin/performance` (admin only) shows, from the running server's memory:

- **Stalls** — every time the event loop stopped for > 1 s, with the request that was running (the culprit).
- **Slow requests** — everything over 2 s, newest first, with user and status.
- **Routes by blocking time** — which endpoints cost the most, ranked by total time (ids collapsed to `:id`).
- In-flight requests this second, memory, DB and WAL size.

Auto-refreshes every 15 s. "Reset" clears the counters (e.g. after a deploy). The same lines still go to `pm2 logs erp | grep -E '\[slow\]|\[lag\]'`.

To name the exact SQL behind a slow route on the VPS: restart once with `ERP_SQL_PROFILE=100` in the environment and grep the log for `[sql`. Turn it off again afterwards.

## 6. Still open (next class to fix)

**Return-everything lists.** These endpoints send every row to the browser and let the page filter; on a year of data each is 10–22 MB and 2–4 s of blocked server time per open:

| Endpoint | Payload on the year-scale copy |
|---|---|
| `/api/orders/po` | 22 MB |
| `/api/procurement/indents` | 20 MB |
| `/api/pms-tasks` | 18 MB |
| `/api/procurement/item-rates` | 18 MB |
| `/api/quotations/po-foc` | 14 MB |
| `/api/procurement/pending-po-items` | 11 MB |
| `/api/dpr`, `/api/indent-fms/tracker`, `/api/sales-funnel` | 5–6 MB |

The fix is server-side paging (`?page=&per=`) with the shared `Pagination` component on each page — a per-page client change, not a query fix. Ordered by payload above.

Smaller items: 35 search boxes fire a request per keystroke with no debounce; the VPS still has no swap (a memory-starved OOM restart shows up as a stall with "no request in flight").
