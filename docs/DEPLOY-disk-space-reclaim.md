# Deploy guide — disk-space-reclaim (via `main`)

The branch is **merged into `main` first**, then the VPS pulls `main` as it always does.
So there is no feature-branch checkout on the server — production only ever runs `main`.
This is a pull-and-restart. **Do not run or edit `deploy-vps.sh`** — it is the one-time
fresh-clone installer, not the update path.

Flow: PR `feat/disk-space-reclaim` → `main` on GitHub, merge, then the VPS steps below.

## What this branch carries (multiple phases in one merge)

| Phase | In this branch | Deploy-time action |
|---|---|---|
| **1 — log rotation** | `setup-log-rotation.sh` (NEW — not in main) | **manual**, run once on the VPS after the pull |
| **2/3 — nightly maintenance** | `db-maintenance.js` (+VACUUM, +sotynflow.db) | auto — arms on boot at 02:15 |
| **5 — S3 seam + backup offload** | `storage.js`, `backfill-uploads-s3.js`, `backup-db.js` | **inert** unless `STORAGE_DRIVER=s3` / `BACKUP_S3=1` |
| **sweep scheduler** | `sweep-uploads.js` | **off** unless `ERP_ENABLE_SWEEP_CRON=1` |
| archive UX | chat + boards `archived_at` | auto `ALTER TABLE` on boot, idempotent |

The sequencing rule that matters: **Phase 1 reclaims the disk, Phase 5 needs disk to build.**
`git pull` + `npm install` + `npm run build` all need free space. If the box is full from
unrotated logs, reclaim FIRST — see step 0 below.

**Phase 2 changes what a backup looks like.** From this deploy on, each nightly run writes
**one `backup-<ts>.zip`** (auto-discovering every `data/*.db` — now including `sotynflow.db` —
checkpointing each and bundling them, ~70–90% smaller) instead of bare `erp-<ts>.db` files.
The Backups UI download becomes that single complete zip. Old bare-`.db` backups are still
listed and restorable, so nothing is orphaned — but tell whoever restores that the current
format is the zip.

## ENV — nothing new is required

`STORAGE_DRIVER` defaults to `local`. With it unset, the app behaves exactly as today:
files under `data/uploads/`, no bucket, and `@aws-sdk/client-s3` is never even loaded (it is
NOT a package.json dependency — lazy-loaded only on the s3 path). So the existing `.env` is
untouched by this deploy.

Everything added is opt-in with a safe default:

| Var | Default when unset | You only set it to… |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `s3` — move uploads to a bucket |
| `ERP_ENABLE_SWEEP_CRON` | off (no timer) | `1` — arm the nightly sweep |
| `ERP_SWEEP_CRON_DRYRUN` | dry-run | `0` — let the sweep actually move files |
| `BACKUP_S3` | off | `1` — also push DB backups to a bucket |

The 5 `S3_*` vars (`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`,
`S3_ENDPOINT`) are read **only** when `STORAGE_DRIVER=s3`. They are the irreducible minimum
any S3 target needs — not this branch's overhead. Leave them unset today.

**Escape hatches — leave unset; set to `1` only to switch a nightly job OFF** if it ever
misbehaves on the big production DB. Worth knowing they exist before deploy night:

| Var | Turns off |
|---|---|
| `ERP_DISABLE_DB_MAINTENANCE` | the 02:15 WAL-checkpoint + VACUUM (Phase 3) |
| `ERP_DISABLE_BACKUP_SCHEDULER` | the 02:00 nightly backup (Phase 2) |
| `ERP_DISABLE_UPLOADS_BACKFILL` | the 02:30 S3 backfill (already dormant without S3) |
| `ERP_BACKUP_DIR` | *(path, not on/off)* — where backup zips are written; defaults to `~/erp-backups` |

## Ordered deploy (run top to bottom)

### Step 0 — Measure, and reclaim FIRST if the disk is tight

```bash
df -h /                                              # how full is the disk?
ls -la /root/erp/data/*.db*                          # WAL sizes before first boot
du -sh /root/erp/data/uploads /root/erp/data/quarantine /root/.pm2/logs/* 2>/dev/null
```

If `df` shows the disk near-full, reclaim the log space **now**, before the pull — this is a
plain PM2 command and needs no new file:

```bash
pm2 flush erp        # empties erp-out.log / erp-error.log; app keeps running, no downtime
```

Why before the pull: `git pull` and the client build both need free space. A full disk makes
them fail. `pm2 flush erp` is the fastest way to make room. (Permanent log rotation comes in
step 2, once the branch has delivered its script.)

Why the `ls`: first boot on this branch checkpoints a `chat.db`/`erp.db` WAL that has never
been truncated in production. VACUUM will skip (freelist is 0), so only the WAL fold runs —
but confirm the `-wal` sizes are sane before, not after.

### Step 1 — Backup, then pull the code (Phase 5)

```bash
cd /root/erp
node server/scripts/backup-db.js        # fresh restore point before any code change

git pull origin main                    # production tracks main; fast-forward to the merge
npm install                             # NO new prod deps; safe no-op if nothing changed
cd client && npm install && npm run build && cd ..
```

### Step 2 — Set up permanent log rotation (Phase 1)

Now that the pull has delivered `setup-log-rotation.sh`, cap the logs so they can never fill
the disk again. Idempotent, persists across every future deploy/reboot, run once per VPS:

```bash
bash /root/erp/setup-log-rotation.sh
```

### Step 3 — Restart and watch the boot

```bash
pm2 restart erp
pm2 logs erp --lines 40                 # confirm the lines in the next section
```

## Verify the boot (these exact lines confirm the safe defaults)

```
[auth]     JWT secret locked in at boot (stable across restarts)
[backup]   Next scheduled run at ...T20:30:00.000Z          (02:00 IST)
[db-maint] Next scheduled run at ...T20:45:00.000Z          (02:15 IST)
[backfill] Scheduler not started: STORAGE_DRIVER is not "s3".
[sweep]    Scheduler not started: set ERP_ENABLE_SWEEP_CRON=1 to enable.
```

The `[db-maint]` three-target VACUUM summary (`erp.db, chat.db, sotynflow.db`) only prints
when it RUNS at 02:15 — not at boot. What you confirm at boot is that both new schedulers
are **dormant**: `[backfill] Scheduler not started` and `[sweep] Scheduler not started`.
Then click into SOTYN Chat → open a group → the ⋮ menu should show Archive/Delete; the
archive toggle sits at the foot of the group list.

## The morning after (the real test — not deploy night)

Boot only proves the schedulers ARMED. The Phase 2/3 machinery first runs overnight
(02:00 backup, 02:15 maintenance), so verify the next morning:

```bash
ls -lh ~/erp-backups | tail -3        # a fresh backup-<ts>.zip from 02:00 should be there
pm2 logs erp --lines 200 | grep -E "\[backup\]|\[db-maint\]"
```

Expect `[backup] Wrote backup-<ts>.zip (... MB) — N DB(s)` and a `[db-maint]` line per DB.
On this first run `db-maint` reports `VACUUM skipped` for all three (freelist is 0 — nothing
deleted yet); that is correct, not a failure. The number that should move is the **WAL** fold
(`WAL -X MB`). If a 02:15 VACUUM ever fires later (after purge/retention deletes rows), that
is the run to watch on the 217 MB `erp.db` — see the temp_store caveat below.

## Rollback

Because it is merged into `main`, rolling back means reverting the merge — not a branch
switch. Prefer a GitHub **Revert** on the merge PR (clean, auditable), then on the VPS:

```bash
cd /root/erp
git pull origin main            # pulls the revert
cd client && npm run build && cd ..
pm2 restart erp
```

The `archived_at` columns remain after a revert (harmless — old code ignores them). If a DB
restore is also needed, the pre-flight backup is the point to restore to. Do not
`git reset --hard` on the server — a force-diverged `/root/erp` breaks the next `git pull`.

## Later — turning on the sweep (separate from this deploy)

Do this only after a week of watching, never on deploy day:

```bash
# Week 1 — dry-run: arm the schedule but let it only LOG, move nothing.
#   set ERP_ENABLE_SWEEP_CRON=1  (leave ERP_SWEEP_CRON_DRYRUN unset)
# Read the nightly "[sweep] nightly DRY-RUN: quarantined=N purged=M" for a few days.
# Week 2 — arm for real:
#   set ERP_SWEEP_CRON_DRYRUN=0
```

Reclaimable **today**, independent of everything above: `data/quarantine/` — its TTL never
fired before this branch, so every file deleted-then-quarantined is still there. One manual
sweep (or the button in Backups UI) collects it.

## Known caveat — the first big VACUUM (not triggered by this deploy)

`temp_store = MEMORY` is set on `erp.db`. It is **unverified** whether SQLite routes VACUUM's
temporary rewrite through RAM; if it does, the first VACUUM that actually reclaims a large
amount (after purge/retention deletes rows) could try to materialise 150 MB+ in memory on a
1–2 GB VPS. This deploy does NOT trigger it — VACUUM skips while freelist is 0. But before
the first deletion-driven VACUUM ever runs in production, test it against a **copy** of the
prod `erp.db` and watch RSS. Escape hatch if needed: `ERP_DISABLE_DB_MAINTENANCE=1`.

## S3 — only if/when you decide to offload uploads

Not part of this deploy. When you do:

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner   # the lazy dep, installed on demand
```

Then set these in `.env` and restart:

```
STORAGE_DRIVER=s3
S3_BUCKET=<bucket>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_REGION=<region>            # e.g. us-east-1, or "auto" for Cloudflare R2
S3_ENDPOINT=<endpoint>        # e.g. https://<acct>.r2.cloudflarestorage.com  (omit for real AWS)
S3_KEY_PREFIX=tenant_sepl     # ← set this from day one; see below
```

Then use the migration button in Backups UI to move existing files. Dual-read serves old +
new during cutover.

### Set `S3_KEY_PREFIX=tenant_sepl` from the first S3 boot

Key layout is `<bucket>/<S3_KEY_PREFIX>/uploads/**` and `.../quarantine/**`.

- **Without** the prefix, files land at the bucket ROOT: `<bucket>/uploads/**`.
- **With** `S3_KEY_PREFIX=tenant_sepl`: `<bucket>/tenant_sepl/uploads/**` — the clean
  `tenant_<name>/` convention.

Set it on the very first S3 boot, **before** any file is migrated. Changing the prefix later
strands every object already written under the old prefix (they'd read as missing). It costs
nothing now and is forward-compatible: it is exactly the shape Phase 4 will later set
automatically from `TENANT_ID`, so existing objects need no move when that lands.

Note the current asymmetry (Phase 4 unifies it): `TENANT_ID` moves only the **local**
`data/<tenant>/` tree; the **bucket** key is prefixed **only** by `S3_KEY_PREFIX`. On the S3
driver, `TENANT_ID` has no effect on where objects are stored — so `S3_KEY_PREFIX` is the one
that names the S3 side today.
