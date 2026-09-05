// Live update after a deploy (mam 2026-09-05: "every user needs to refresh
// for new features which i update in vps — it should be automatic").
//
// How a tab learns a new build is live:
//   1. the shell socket — the server sends `app:version {build}` on every
//      connection; `pm2 reload` drops every socket, they reconnect within
//      seconds, so every logged-in tab hears about the new build at once;
//   2. GET /api/version on tab focus / visibility / online / route change
//      (throttled) and every 10 min — covers the login page (no socket) and
//      any tab whose socket is down.
// `build` is the entry chunk's filename (index-<hash>.js) — the server reads
// it from the index.html it serves, this tab knows its own from
// import.meta.url. Different name = different build. (No git commit here:
// client/dist is built BEFORE the commit that ships it, so a commit hash
// would always be one behind.)
//
// How it applies:
//   - tab hidden and nothing in progress → reload silently (they'll come
//     back to the new version);
//   - tab visible and idle → "updating in 10s" banner with Update now / Later;
//   - a modal is open or a field is focused → banner only, no countdown; it
//     applies by itself at the next page change or once the tab is hidden
//     and idle. "Later" = the same deferral.
// A reload-loop guard: if we already reloaded for this same build a moment
// ago and the mismatch is still there, stop auto-reloading and leave the
// banner up — a broken proxy/cache must not turn into a flicker loop.
// The stale-chunk recovery in main.jsx stays as the backstop for tabs that
// navigate before hearing about the build.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppSocket } from '../context/SocketProvider';

const COUNTDOWN_S = 10;
const POLL_MS = 10 * 60 * 1000;
const THROTTLE_MS = 60 * 1000;
const LOOP_KEY = 'live-update-reloaded';

// This tab's own build id — the entry chunk this code is running from. In
// the Vite dev server import.meta.url is /src/main.jsx → null → watcher off.
const MY_BUILD = (() => {
  try {
    const m = new URL(import.meta.url).pathname.match(/(index-[A-Za-z0-9_-]+\.js)$/);
    return m ? m[1] : null;
  } catch { return null; }
})();

// "Mid-work" = an overlay/modal is open, or the user is in a field.
const isBusy = () => {
  try {
    if (document.querySelector('.fixed.inset-0')) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  } catch { return false; }
};

export default function UpdateWatcher() {
  const { subscribe } = useAppSocket();
  const location = useLocation();
  const [pending, setPending] = useState(null);      // the new build id
  const [countdown, setCountdown] = useState(null);  // seconds left, or null
  const [deferred, setDeferred] = useState(false);   // "Later" / busy
  const [loopSuspect, setLoopSuspect] = useState(false);
  const lastCheck = useRef(0);
  const pendingRef = useRef(null);
  pendingRef.current = pending;

  const applyNow = (build) => {
    try { sessionStorage.setItem(LOOP_KEY, JSON.stringify({ build, at: Date.now() })); } catch { /* storage blocked */ }
    window.location.reload();
  };

  // A build id from either source → decide whether it is new and safe to apply.
  const consider = (build) => {
    if (!MY_BUILD || !build || build === MY_BUILD) return;
    // Reloaded for this exact build < 2 min ago and still mismatched → loop.
    try {
      const prev = JSON.parse(sessionStorage.getItem(LOOP_KEY) || 'null');
      if (prev && prev.build === build && Date.now() - prev.at < 120000) { setLoopSuspect(true); setPending(build); return; }
    } catch { /* ignore */ }
    if (document.visibilityState === 'hidden' && !isBusy()) return applyNow(build);
    setPending(build);
  };

  const check = async (force = false) => {
    if (!MY_BUILD) return;
    const now = Date.now();
    if (!force && now - lastCheck.current < THROTTLE_MS) return;
    lastCheck.current = now;
    try {
      const r = await fetch('/api/version', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      consider(j.build);
    } catch { /* offline / server restarting — the next trigger retries */ }
  };

  // Sources: socket push + polling triggers.
  useEffect(() => {
    if (!MY_BUILD) return;
    const off = subscribe('app:version', (d) => consider(d?.build));
    const onVisible = () => { if (document.visibilityState === 'visible') check(); else if (pendingRef.current && !isBusy() && !loopSuspect) applyNow(pendingRef.current); };
    const onFocus = () => check();
    const onOnline = () => check(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    const timer = setInterval(() => check(true), POLL_MS);
    check(true);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onFocus); window.removeEventListener('online', onOnline); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, loopSuspect]);

  // Route change = a natural safe point: apply a pending build there
  // (unless a field is already focused on the new page or we suspect a loop).
  const firstPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === firstPath.current) return;
    firstPath.current = location.pathname;
    if (pendingRef.current && !loopSuspect && !isBusy()) applyNow(pendingRef.current);
    else check();
  }, [location.pathname]);

  // Countdown: one 1-second ticker while a build is pending and not deferred.
  // Idle → counts 10 → 0 and reloads. Busy (modal / field) → the count pauses
  // at "waiting" and restarts from 10 once they are free again.
  useEffect(() => {
    if (!pending || deferred || loopSuspect) { setCountdown(null); return; }
    let left = null;
    const tick = () => {
      if (isBusy()) { left = null; setCountdown(null); return; }
      left = left == null ? COUNTDOWN_S : left - 1;
      if (left <= 0) { clearInterval(t); applyNow(pending); return; }
      setCountdown(left);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, deferred, loopSuspect]);

  if (!pending) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[95vw]" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 rounded-full bg-indigo-700 text-white shadow-xl px-4 py-2 text-xs sm:text-sm">
        <span className="font-semibold">🔄 New version ready</span>
        <span className="text-indigo-100">
          {loopSuspect ? 'could not switch automatically — click Update'
            : countdown != null ? `updating in ${countdown}s`
            : deferred ? 'will apply when you move to the next page'
            : 'waiting till you finish here'}
        </span>
        <button type="button" onClick={() => applyNow(pending)}
          className="px-3 py-1 rounded-full bg-white text-indigo-700 font-bold hover:bg-indigo-50">Update now</button>
        {countdown != null && (
          <button type="button" onClick={() => { setDeferred(true); setCountdown(null); }}
            className="px-2 py-1 rounded-full text-indigo-100 hover:text-white hover:bg-indigo-600">Later</button>
        )}
      </div>
    </div>
  );
}
