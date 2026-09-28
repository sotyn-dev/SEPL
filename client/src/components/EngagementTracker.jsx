import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api';

// Foreground page checks count; hidden tabs, attendance and passive timers do not.
export default function EngagementTracker({ userId }) {
  const { pathname } = useLocation();
  const lastSent = useRef({ key: '', time: 0 });
  useEffect(() => {
    if (!userId || /(?:^|\/)(?:attendance|punch[^/]*|locations|login|logout)(?:\/|$)/i.test(pathname)) return;
    let pending = false;
    const report = () => {
      if (document.visibilityState !== 'visible' || pending) return;
      const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
      const key = `${userId}:${day}`;
      if (lastSent.current.key === key && Date.now() - lastSent.current.time < 300000) return;
      pending = true;
      api.post('/auth/engagement', { path: pathname }).then(() => {
        lastSent.current = { key, time: Date.now() };
      }).catch(() => {}).finally(() => { pending = false; });
    };
    let timer;
    // A brief landing-page redirect on the way to attendance is not a page check.
    const schedule = () => {
      if (document.visibilityState !== 'visible') { clearTimeout(timer); timer = null; return; }
      if (!timer) timer = setTimeout(() => { timer = null; report(); }, 10000);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('pointerdown', schedule);
    document.addEventListener('keydown', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
      document.removeEventListener('pointerdown', schedule);
      document.removeEventListener('keydown', schedule);
    };
  }, [userId, pathname]);
  return null;
}
