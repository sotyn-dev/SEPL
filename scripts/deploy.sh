#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Automated deploy for the SEPL ERP (API `erp` + background worker `erp-worker`).
# Run this ON THE VPS from anywhere inside the repo:
#
#     bash scripts/deploy.sh            # deploy origin/main   (normal)
#     bash scripts/deploy.sh <branch>   # deploy origin/<branch>
#
# It does the whole checklist in one shot and is safe to re-run:
#   git fetch + hard reset → npm install (rebuilds client via postinstall) →
#   pm2 startOrReload (starts erp-worker the first time, reloads both after) →
#   pm2 save → smoke test.
#
# Redis is an ACCELERATOR: if it's down this still deploys fine, the app just
# runs in fallback mode. The smoke test at the end tells you whether the Redis
# speedups are actually engaged. See docs/REDIS_DEPLOY.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BRANCH="${1:-main}"
cd "$(dirname "$0")/.."            # repo root (this script lives in scripts/)
ROOT="$(pwd)"

log(){  printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die(){  printf '\033[1;31m[error] %s\033[0m\n' "$*"; exit 1; }

[ -f package.json ] && [ -f ecosystem.config.js ] || die "Not in the ERP repo root ($ROOT)."
command -v git  >/dev/null || die "git not found."
command -v npm  >/dev/null || die "npm not found."
command -v pm2  >/dev/null || die "pm2 not found — install it once: npm i -g pm2"

log "Deploying origin/$BRANCH   (cwd: $ROOT)"

log "Fetch + hard reset to origin/$BRANCH"
git fetch origin
git reset --hard "origin/$BRANCH"
git --no-pager log --oneline -1

log "npm install (installs deps; postinstall rebuilds the client bundle)"
npm install

# Redis reachability is advisory only.
if command -v redis-cli >/dev/null && redis-cli ping >/dev/null 2>&1; then
  log "Redis reachable (PONG)"
else
  warn "Redis not reachable — the app will run in FALLBACK mode (no cache/queue/adapter)."
  warn "Run 'sudo bash scripts/setup-redis.sh' once to install + enable Redis, then re-deploy."
fi

log "pm2 startOrReload (starts erp-worker if new, reloads both otherwise)"
pm2 startOrReload ecosystem.config.js
pm2 save
pm2 status

log "Waiting for boot, then running the smoke test"
sleep 4
if node server/scripts/redis-smoke.js; then
  log "✅ Deploy complete — smoke test PASSED, Redis acceleration is live."
else
  warn "Deploy is live, but the smoke test flagged an issue (see above)."
  warn "The app still works via fallbacks. Usual cause: erp-worker not running or Redis down."
  warn "Check:  pm2 status   |   pm2 logs erp-worker --lines 30"
fi
