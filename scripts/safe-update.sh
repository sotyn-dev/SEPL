#!/usr/bin/env bash
# Update a RUNNING ERP to origin/main — without touching its data or secrets.
#
#   cd /root/erp && bash scripts/safe-update.sh
#
# deploy-vps.sh is a FIRST-TIME PROVISIONING script: it deletes /root/erp —
# the live database included — and rewrites .env. Never use it to update.
#
# This script only:
#   1. refuses to run over uncommitted changes on the server;
#   2. backs up the database (sqlite3 .backup when available, else a copy);
#   3. fast-forwards to origin/main — never a reset, never a merge commit;
#   4. STOPS BEFORE UPDATING if dependencies or the web client changed, so a
#      heavier step is a decision, not a side effect — and so PM2's automatic
#      restart (max_memory_restart) can never load code whose dependencies are
#      not installed;
#   5. reloads PM2 and checks the server answers.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${PM2_APP:-erp}"
DB="${ERP_DB_PATH:-data/erp.db}"
PORT="${PORT:-5000}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "There are uncommitted changes on this server — not updating." >&2
  echo "Look at them first: git status && git diff" >&2
  exit 1
fi

mkdir -p data/pre-update-backups
BACKUP="data/pre-update-backups/erp.db.$(date +%F-%H%M%S)"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$BACKUP'"
else
  cp -a "$DB" "$BACKUP"
fi
echo "Database backed up to $BACKUP"

OLD="$(git rev-parse HEAD)"
git fetch --quiet origin main
if [ "$OLD" = "$(git rev-parse origin/main)" ]; then
  echo "Already up to date at $(git rev-parse --short HEAD)."
  exit 0
fi

# Decide before touching anything: a dependency or client change needs a step
# this script will not take on its own.
if ! git diff --quiet "$OLD" origin/main -- package.json package-lock.json; then
  echo "package.json / package-lock.json change in origin/main — NOT updated; the server is untouched." >&2
  echo "Update by hand: git merge --ff-only origin/main && npm ci --omit=dev --ignore-scripts \\" >&2
  echo "  && npm rebuild better-sqlite3 sharp && pm2 reload $APP --update-env" >&2
  exit 2
fi
if ! git diff --quiet "$OLD" origin/main -- client/; then
  echo "client/ changes in origin/main — NOT updated; the server is untouched." >&2
  echo "Update by hand: git merge --ff-only origin/main && (cd client && npm ci && npm run build) && pm2 reload $APP --update-env" >&2
  exit 2
fi

if ! git merge --ff-only --quiet origin/main; then
  echo "origin/main cannot be fast-forwarded onto this checkout — nothing changed. Stop and look." >&2
  exit 1
fi
NEW="$(git rev-parse HEAD)"
echo "Updated $(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW"):"
git log --oneline "$OLD..$NEW" | head -40

pm2 reload "$APP" --update-env
sleep 4
if curl -fsS "http://127.0.0.1:${PORT}/api/webhooks/health" >/dev/null; then
  echo "ERP is answering."
else
  echo "The ERP did not answer on port ${PORT} — check: pm2 logs $APP --lines 80" >&2
  echo "To go back: git reset --hard $OLD && pm2 reload $APP (the database backup is $BACKUP)." >&2
  exit 1
fi
if curl -fsS "http://127.0.0.1:${PORT}/api/public/energy-desk/health" 2>/dev/null; then echo; fi
