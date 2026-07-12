#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ONE-TIME Redis setup for the SEPL ERP. Run this ON THE VPS, once, with sudo:
#
#     sudo bash scripts/setup-redis.sh
#
# It installs redis-server, sets the ONE policy the job queue requires
# (maxmemory-policy noeviction), persists it, and enables Redis on boot. Safe to
# re-run (idempotent). After this, deploy the app with scripts/deploy.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
log(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo (needs apt + systemctl)."; exit 1; }

log "Installing redis-server"
apt-get update -y
apt-get install -y redis-server

log "Enabling + starting redis-server (also on boot)"
systemctl enable --now redis-server

log "Setting maxmemory-policy = noeviction and persisting it"
# noeviction is REQUIRED: under memory pressure Redis must reject writes rather
# than silently drop queued jobs / cached keys. (We deliberately do NOT set a
# maxmemory cap — the cache+queue footprint is tiny; an unset limit avoids the
# 'reached maxmemory + noeviction ⇒ writes rejected' foot-gun. Uncomment below
# only if you want a hard cap.)
redis-cli CONFIG SET maxmemory-policy noeviction
# redis-cli CONFIG SET maxmemory 512mb
redis-cli CONFIG REWRITE || warn "CONFIG REWRITE failed — set 'maxmemory-policy noeviction' in /etc/redis/redis.conf manually so it survives a restart."

log "Verify"
redis-cli ping
redis-cli CONFIG GET maxmemory-policy
systemctl is-enabled redis-server || true

log "Redis is ready. Next: bash scripts/deploy.sh"
