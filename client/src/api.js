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
      // Ignore a 401 from a request whose token is no longer the active one.
      // A slow request still in flight from BEFORE the user (re-)logged in —
      // e.g. a stale /auth/me using an expired token — would otherwise clear
      // the brand-new token and bounce a just-logged-in user. That looked
      // like "log in, then instantly logged out" (mam 2026-06-24, Nitin Jain,
      // who carried a stale token from a previous session). Only act when the
      // token that failed is still the current session token.
      const used = err.config?.metadata?.tokenAtSend || null;
      const current = getToken();
      if (used === current) {
        clearToken();
        delete api.defaults.headers.common.Authorization;
        // Only hard-redirect if we're NOT already on the login page — a 401
        // from a background poll on /login would otherwise loop the page.
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
