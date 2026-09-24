// The one IP on this deployment a caller cannot choose.
//
// Lifted from routes/publicSotynLead.js (2026-09-07 audit) so a second public
// POST route does not re-derive it — and re-make the same mistake. The reasoning
// there, unchanged:
//
// Our nginx (deploy-vps.sh) sets ONLY `X-Real-IP $remote_addr`; it never sets
// X-Forwarded-For. A caller's own X-Forwarded-For therefore reaches Node
// untouched, and because index.js sets `trust proxy: 1`, Express derives req.ip
// FROM that forged header. req.ip is spoofable here, and so is XFF[0]: either
// one lets a bot mint a fresh rate-limit bucket per request.
//
// X-Real-IP is safe because nginx OVERWRITES whatever the caller sent with the
// real socket peer — but only for traffic that actually came through nginx. So
// it is trusted only when the connection itself came from local nginx; anywhere
// else (dev, a direct hit) the socket address is already the truth.
function clientIp(req) {
  const sock = (req && req.socket && req.socket.remoteAddress) || '';
  const viaLocalNginx = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  if (viaLocalNginx) {
    const real = String((req.headers && req.headers['x-real-ip']) || '').trim();
    if (real) return real;
  }
  return sock || (req && req.ip) || 'unknown';
}

module.exports = { clientIp };
