import axios from 'axios';
import { getToken, setToken, clearToken } from './lib/tokenStore';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  // Resilient read: falls back to an in-memory copy when localStorage is
  // blocked/wiped (in-app browsers, private mode) — otherwise the request
  // goes out unauthenticated and the user is bounced to login.
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
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
      clearToken();
      delete api.defaults.headers.common.Authorization;
      // Only hard-redirect if we're NOT already on the login page — a 401
      // from a background poll on /login would otherwise loop the page.
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// ─── Lead-to-Dispatch Funnel helpers ─────────────────────────────────
// Thin wrappers over /api/lead-funnel so the funnel pages don't repeat
// path strings. All return the axios response's .data.
export const leadFunnel = {
  list:        (params)        => api.get('/lead-funnel/leads', { params }).then(r => r.data),
  get:         (id)            => api.get(`/lead-funnel/leads/${id}`).then(r => r.data),
  setStage:    (id, body)      => api.patch(`/lead-funnel/leads/${id}/stage`, body).then(r => r.data),
  advance:     (id, body)      => api.patch(`/lead-funnel/leads/${id}/advance`, body).then(r => r.data),
  update:      (id, body)      => api.patch(`/lead-funnel/leads/${id}`, body).then(r => r.data),
  stats:       ()             => api.get('/lead-funnel/stats').then(r => r.data),
  draftPo:     (leadId)        => api.post(`/lead-funnel/vendor-po/${leadId}/draft`).then(r => r.data),
  approvePo:   (poId, body)    => api.post(`/lead-funnel/vendor-po/${poId}/approve`, body).then(r => r.data),
  addFollowup: (body)          => api.post('/lead-funnel/followups', body).then(r => r.data),
  setFollowup: (id, body)      => api.patch(`/lead-funnel/followups/${id}`, body).then(r => r.data),
  keepInTouch: ()             => api.get('/lead-funnel/keep-in-touch').then(r => r.data),
  followupNow: (id, body)      => api.post(`/lead-funnel/leads/${id}/followup-now`, body).then(r => r.data),
  getSettings: ()             => api.get('/lead-funnel/settings').then(r => r.data),
  saveSettings:(body)          => api.put('/lead-funnel/settings', body).then(r => r.data),
  runPollNow:  ()             => api.post('/lead-funnel/run-poll-now').then(r => r.data),
};
