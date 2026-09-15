#!/bin/bash
# Recover the mass-logout loop after JWT-secret rotation  —  RUN ON THE VPS, IN /root/erp
# =========================================================================================
# Symptom this fixes: "everyone logs out ~5s after login, again and again."
#
# Root cause: rotate-jwt-secret.sh mints a NEW RANDOM secret every run and stores
# it in app_settings.jwt_secret. If it ran more than once, a chunk of users hold
# tokens signed with an in-between random secret ("the middle-generation key")
# that the server can no longer verify — so they 401 on every request and the
# client bounces them straight back to /login. The zero-logout bridge in
# server/middleware/auth.js can migrate those tokens silently, but ONLY if it is
# told the old secret(s). This script feeds them in from the backups the rotation
# script itself left behind (.env.bak-*), via a DB row (app_settings.jwt_legacy_secrets)
# that survives pm2's env caching. Nobody gets logged out.
#
# It is SAFE to run: DIAGNOSE does read-only checks; RECOVER only ADDS old secrets
# to the accept-list (bounded by the window in auth.js) and never changes the
# current secret. It also flags the OTHER cause of a universal loop — a stale /
# duplicate backend process still serving an old secret.
#
# Usage:
#   cd /root/erp && bash recover-jwt-sessions.sh            # diagnose only
#   cd /root/erp && bash recover-jwt-sessions.sh --recover  # diagnose + write legacy list
set -euo pipefail

APP_DIR="${APP_DIR:-/root/erp}"
DB="$APP_DIR/data/erp.db"
cd "$APP_DIR"
MODE="${1:-}"

echo "==================================================================="
echo "  JWT session recovery  —  $(date)"
echo "==================================================================="

echo
echo "==> 1) Current live secret (length only, never printed):"
node -e "const D=require('better-sqlite3');const db=new D('$DB',{readonly:true});const r=db.prepare(\"SELECT length(value) len FROM app_settings WHERE key='jwt_secret'\").get();console.log('    app_settings.jwt_secret length =', r&&r.len);const l=db.prepare(\"SELECT value FROM app_settings WHERE key='jwt_legacy_secrets'\").get();console.log('    legacy accept-list currently =', l&&l.value?('set ('+l.value.split(/[,\\n]/).filter(Boolean).length+' secret(s))'):'EMPTY');"

echo
echo "==> 2) Backend processes (a SECOND/stale one serving an old secret is the"
echo "        other way EVERYONE loops — there must be exactly ONE 'erp'):"
pm2 list | grep -E "id|erp" || true
COUNT=$(pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);console.log(a.filter(p=>p.name==='erp'&&p.pm2_env.status==='online').length)}catch(e){console.log('?')}})")
echo "    online 'erp' processes = $COUNT   (expected: 1)"
if [ "$COUNT" != "1" ]; then
  echo "    !! If this is >1, that alone causes the loop. Clean up with:"
  echo "         pm2 delete erp && pm2 start ecosystem.config.js && pm2 save"
fi

echo
echo "==> 3) Old secrets found in .env backups the rotation script left behind:"
FOUND=$(grep -hoE '^JWT_SECRET=.*' .env.bak-* 2>/dev/null | sed 's/^JWT_SECRET=//' | sort -u || true)
if [ -z "$FOUND" ]; then
  echo "    (none found — check for data/erp.db.bak-* and read jwt_secret from the newest ones)"
else
  echo "$FOUND" | while read -r s; do [ -n "$s" ] && echo "    • length ${#s} (value hidden)"; done
fi

if [ "$MODE" != "--recover" ]; then
  echo
  echo "==> Diagnose-only. To migrate stuck sessions with ZERO logout, re-run:"
  echo "       bash recover-jwt-sessions.sh --recover"
  exit 0
fi

echo
echo "==> 4) RECOVER — write every discovered old secret into app_settings.jwt_legacy_secrets:"
if [ -z "$FOUND" ]; then
  echo "    Nothing to add from .env.bak-*. If you know the old secret another way,"
  echo "    set it manually:"
  echo "      node -e \"const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\\\"INSERT OR REPLACE INTO app_settings(key,value) VALUES('jwt_legacy_secrets',?)\\\").run('OLDSECRET1,OLDSECRET2')\""
  exit 1
fi
# Backup DB first.
BAK="$DB.bak-$(date +%Y%m%d-%H%M%S)"; cp "$DB" "$BAK"; echo "    DB backup -> $BAK"
# Merge discovered secrets with any already present, comma-join, and store.
printf '%s\n' "$FOUND" | node -e "
const D=require('better-sqlite3');const db=new D('$DB');
let incoming=''; process.stdin.on('data',d=>incoming+=d).on('end',()=>{
  const found=incoming.split(/\n/).map(s=>s.trim()).filter(Boolean);
  const row=db.prepare(\"SELECT value FROM app_settings WHERE key='jwt_legacy_secrets'\").get();
  const cur=(row&&row.value?row.value.split(/[,\n]/):[]).map(s=>s.trim()).filter(Boolean);
  const merged=[...new Set([...cur,...found])];
  db.prepare(\"INSERT OR REPLACE INTO app_settings(key,value) VALUES('jwt_legacy_secrets',?)\").run(merged.join(','));
  console.log('    legacy accept-list now holds',merged.length,'secret(s)');
});
"
echo
echo "==> 5) Restart so the bridge picks it up immediately:"
pm2 restart erp
echo
echo "==> DONE. Users holding an old token are now silently re-signed onto the"
echo "    current secret on their very next request — no logout. The accept-list"
echo "    self-expires (see RECOVERED_UNTIL in server/middleware/auth.js)."
echo "    Keep the DB backup ($BAK) until confirmed stable."
