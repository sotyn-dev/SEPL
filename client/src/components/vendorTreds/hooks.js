import { useEffect, useState } from 'react';
import api from '../../api';
import { errorMessage, filterParams } from './model';

export function useRemote(path, params = {}, revision = 0) {
  const query = new URLSearchParams(filterParams(params)).toString();
  const key = `${path}?${query}|${revision}`;
  const [result, setResult] = useState({ key: '', data: null, error: null });
  useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    api.get(`${path}${query ? `?${query}` : ''}`, { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setResult({ key, data: response.data, error: null }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, data: null, error: errorMessage(error) }); });
    return () => controller.abort();
  }, [path, query, key]);
  return result.key === key ? { ...result, loading: false } : { data: null, error: null, loading: !!path };
}

export function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const update = event => setDesktop(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

export function useDebounced(value, delay = 350) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return current;
}
