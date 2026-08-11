const KEY = 'sotyn_platform_token';

export function getToken() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isForm && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !path.includes('/api/auth/login') && !path.includes('/api/auth/password-token') && !path.includes('/api/auth/forgot-password')) {
    const p = typeof window !== 'undefined' ? window.location.pathname : '';
    const onPublic = p.startsWith('/login') || p.startsWith('/invite/') || p.startsWith('/reset/');
    setToken('');
    if (typeof window !== 'undefined' && !onPublic) {
      window.location.replace('/login');
    }
  }
  return res;
}

/** Multipart upload helper (do not set Content-Type — browser sets boundary). */
export async function uploadFile(path, file, fieldName = 'file') {
  const fd = new FormData();
  fd.append(fieldName, file);
  return api(path, { method: 'POST', body: fd });
}
