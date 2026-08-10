#!/bin/bash
# One-shot PM2 log-rotation setup for the SEPL ERP.
#
# WHY: the app logs every request via console.* (with timestamps), and PM2
# streams all stdout/stderr into /root/.pm2/logs/erp-*.log with NO size cap and
# NO rotation — so those files grow unbounded and fill the VPS disk. The
# pm2-logrotate module adds a size cap + retention + gzip. Its config is stored
# in ~/.pm2 and persists across `pm2 reload` and reboots, so this only needs to
# run ONCE per VPS (safe to re-run — every step is idempotent).
#
# Usage (on the VPS as root):
#   bash /root/erp/setup-log-rotation.sh
#
# This does NOT touch deploy-vps.sh or the app; it only configures PM2 logging.

set -u

# Tunables (env-overridable): keep total log footprint well under ~1 GB.
MAX_SIZE="${LOGROTATE_MAX_SIZE:-20M}"       # rotate a log once it passes this size
RETAIN="${LOGROTATE_RETAIN:-10}"            # keep this many rotated files per log
COMPRESS="${LOGROTATE_COMPRESS:-true}"      # gzip rotated files
ROTATE_INTERVAL="${LOGROTATE_INTERVAL:-0 0 * * *}"  # also rotate daily at midnight
WORKER_INTERVAL="${LOGROTATE_WORKER:-30}"   # size-check frequency (seconds)
APP_NAME="${PM2_APP_NAME:-erp}"

echo "=========================================="
echo "  PM2 log rotation setup"
echo "=========================================="

# 1. PM2 must be present.
if ! command -v pm2 >/dev/null 2>&1; then
  echo "❌ pm2 not found on PATH. Install PM2 first (npm install -g pm2)."
  exit 1
fi

# 2. Install the module (no-op if already installed).
echo ">>> Installing pm2-logrotate module..."
pm2 install pm2-logrotate

# 3. Configure size cap, retention, compression, schedule.
echo ">>> Applying rotation config..."
pm2 set pm2-logrotate:max_size "$MAX_SIZE"
pm2 set pm2-logrotate:retain "$RETAIN"
pm2 set pm2-logrotate:compress "$COMPRESS"
pm2 set pm2-logrotate:rotateInterval "$ROTATE_INTERVAL"
pm2 set pm2-logrotate:workerInterval "$WORKER_INTERVAL"

# 4. Truncate the current (possibly huge) logs to reclaim disk immediately.
#    Only if the app process exists — a fresh box may not have it yet.
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo ">>> Flushing current $APP_NAME logs to reclaim space now..."
  pm2 flush "$APP_NAME"
else
  echo ">>> ('$APP_NAME' process not running yet — skipping flush.)"
fi

# 5. Show the resulting config so the run is verifiable.
echo ""
echo ">>> Effective pm2-logrotate config:"
pm2 conf pm2-logrotate 2>/dev/null | grep -E 'pm2-logrotate' || true

echo ""
echo "=========================================="
echo "  DONE. Logs now cap at $MAX_SIZE, keep $RETAIN rotations (gzip=$COMPRESS)."
echo "  Persists across deploys/reboots — no need to run again."
echo "=========================================="
