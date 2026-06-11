import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
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
  update:      (id, body)      => api.patch(`/lead-funnel/leads/${id}`, body).then(r => r.data),
  stats:       ()             => api.get('/lead-funnel/stats').then(r => r.data),
  draftPo:     (leadId)        => api.post(`/lead-funnel/vendor-po/${leadId}/draft`).then(r => r.data),
  approvePo:   (poId, body)    => api.post(`/lead-funnel/vendor-po/${poId}/approve`, body).then(r => r.data),
  addFollowup: (body)          => api.post('/lead-funnel/followups', body).then(r => r.data),
  setFollowup: (id, body)      => api.patch(`/lead-funnel/followups/${id}`, body).then(r => r.data),
  getSettings: ()             => api.get('/lead-funnel/settings').then(r => r.data),
  saveSettings:(body)          => api.put('/lead-funnel/settings', body).then(r => r.data),
  runPollNow:  ()             => api.post('/lead-funnel/run-poll-now').then(r => r.data),
};
