import axios from 'axios';
import { getToken, setToken, clearToken } from './lib/tokenStore';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  // Resilient read: falls back to an in-memory copy when localStorage is
  // blocked/wiped (in-app browsers, private mode) — otherwise the request
  // goes out unauthenticated and the user is bounced to login.
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Remember which token this request went out with, so a 401 can tell
  // whether it's still the active session or a stale in-flight request.
  config.metadata = { ...(config.metadata || {}), tokenAtSend: token || null };
  return config;
});

// When a normal data request rejects the CURRENT token, don't trust that one
// endpoint to end the session — but re-validate immediately via /auth/me
// (debounced) so a genuinely dead token logs out cleanly NOW instead of the
// user seeing a stray "Invalid token" toast and waiting for the 2-min poll.
let _revalidateAt = 0;
function revalidateSession() {
  const now = Date.now();
  if (now - _revalidateAt < 5000) return;   // debounce — at most once / 5s
  _revalidateAt = now;
  api.get('/auth/me').catch(() => {});       // its own 401 → the handler below logs out
}

api.interceptors.response.use(
  res => {
    // Sliding session: the server hands back a fresh token once the current
    // one is past a day old. Swap it in so an active user never gets logged
    // out (mam 2026-06-12). Subsequent requests read it from the token store.
    const fresh = res.headers?.['x-refresh-token'];
    if (fresh) {
      setToken(fresh);
      api.defaults.headers.common.Authorization = `Bearer ${fresh}`;
    }
    return res;
  },
  err => {
    if (err.response?.status === 401) {
      // Bulletproof logout policy (mam, repeatedly: "automatically logout —
      // very bad"). The ONLY thing that may end a session is the definitive
      // session check, GET /auth/me, rejecting the CURRENT token. Two guards:
      //
      //   1. Only /auth/me 401s log out. A 401 from ANY other endpoint — a
      //      stale in-flight request from a previous session, a flaky call, or
      //      an endpoint that wrongly returns 401 instead of 403 — is ignored
      //      and never drops a working session. AuthContext re-pulls /auth/me
      //      on mount, on tab focus, and every 2 min, so a genuinely dead
      //      token is still caught and logged out promptly.
      //   2. Even for /auth/me, only act if the token that failed is still the
      //      active one — a slow stale /auth/me resolving AFTER the user
      //      re-logged in must not clear the brand-new token (the "log in,
      //      then instantly logged out" race — Nitin Jain, 2026-06-24).
      const url = err.config?.url || '';
      const used = err.config?.metadata?.tokenAtSend || null;
      const current = getToken();
      const isSessionCheck = url.includes('/auth/me');
      if (isSessionCheck && current && used === current) {
        clearToken();
        delete api.defaults.headers.common.Authorization;
        // Only hard-redirect if we're NOT already on the login page — a 401
        // from a background poll on /login would otherwise loop the page.
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      } else if (!isSessionCheck && used && used === current) {
        // A data endpoint rejected the current token. Re-validate the session
        // now (clean logout if truly dead, ignored if a blip), and don't let
        // the raw "Invalid token" text surface as a page error toast — pages
        // fall back to their own friendly message instead (mam 2026-06-25).
        revalidateSession();
        if (err.response.data && /token/i.test(err.response.data.error || '')) {
          err.response.data = { ...err.response.data, error: null };
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
