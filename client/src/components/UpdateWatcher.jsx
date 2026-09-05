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
// How it applies — a tab is "mid-work" when an overlay/modal is open, a
// field is focused, OR anything was typed/changed on this page since it was
// entered (page-level forms like DPR / Solar design / the joiner form have
// no modal and the focus wanders to a button or the body — review
// 2026-09-05). Mid-work tabs are NEVER reloaded on their own; the update
// applies at the next page change (a natural safe point) or on Update now.
//   - tab hidden and not mid-work → reload silently;
//   - tab visible and not mid-work → "updating in 10s" banner, Update now /
//     Later ("Later" = wait for the next page change);
//   - mid-work → banner only, applies at the next page change.
// Never automatic on storage-blocked browsers (in-app WhatsApp/Instagram,
// private mode): their token lives only in memory and a reload = sign in
// again — they get the banner and choose the moment (tokenStore.js).
// Loop guard: reloaded for this same build < 2 min ago and still mismatched
// (a proxy/cache serving a stale page) → no more auto-reloads in this tab,
// banner with Update only. Everything clears once the server reports this
// tab's own build (a deploy-window race resolves itself after pm2 reload).
// The stale-chunk recovery in main.jsx stays as the backstop.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppSocket } from '../context/SocketProvider';
import { isStorageBlocked } from '../lib/tokenStore';

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

// An overlay/modal is open, or the user is in a field.
const focusBusy = () => {
  try {
    if (document.querySelector('.fixed.inset-0')) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  } catch { return false; }
};

const applyNow = (build) => {
  try { sessionStorage.setItem(LOOP_KEY, JSON.stringify({ build, at: Date.now() })); } catch { /* storage blocked */ }
  window.location.reload();
};

export default function UpdateWatcher() {
  const { subscribe } = useAppSocket();
  const location = useLocation();
  const [pending, setPending] = useState(null);      // the new build id
  const [countdown, setCountdown] = useState(null);  // seconds left, or null
  const [deferred, setDeferred] = useState(false);   // "Later"
  const [loopSuspect, setLoopSuspect] = useState(false);
  const [blocked] = useState(() => { try { return isStorageBlocked(); } catch { return false; } });
  // Refs mirror the state for the handlers, which are bound once
  // (kept in sync from an effect, after each commit).
  const pendingRef = useRef(null);
  const deferredRef = useRef(false);
  const loopRef = useRef(false);
  const dirtyRef = useRef(false);   // typed/changed something on this page
  const lastCheck = useRef(0);
  useEffect(() => { pendingRef.current = pending; deferredRef.current = deferred; loopRef.current = loopSuspect; }, [pending, deferred, loopSuspect]);

  const busy = () => focusBusy() || dirtyRef.current;
  // May this tab reload on its own right now?
  const autoOk = () => !busy() && !deferredRef.current && !loopRef.current && !blocked;

  // A build id from either source → decide what to do with it.
  const consider = (build) => {
    if (!MY_BUILD || !build) return;
    if (build === MY_BUILD) {
      // The server is on our build (again) — nothing pending any more.
      if (pendingRef.current || loopRef.current) { setPending(null); setLoopSuspect(false); setDeferred(false); }
      return;
    }
    if (loopRef.current) { setPending(build); return; }
    // Reloaded for this exact build < 2 min ago and still mismatched → loop.
    try {
      const prev = JSON.parse(sessionStorage.getItem(LOOP_KEY) || 'null');
      if (prev && prev.build === build && Date.now() - prev.at < 120000) { setLoopSuspect(true); setPending(build); return; }
    } catch { /* ignore */ }
    if (document.visibilityState === 'hidden' && autoOk()) return applyNow(build);
    setPending(build);
  };
  const considerRef = useRef(consider);

  const check = async (force = false) => {
    if (!MY_BUILD) return;
    const now = Date.now();
    if (!force && now - lastCheck.current < THROTTLE_MS) return;
    lastCheck.current = now;
    try {
      const r = await fetch('/api/version', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const j = await r.json();
      considerRef.current(j.build);
    } catch { /* offline / server restarting — the next trigger retries */ }
  };
  const checkRef = useRef(check);
  const autoOkRef = useRef(autoOk);
  useEffect(() => { considerRef.current = consider; checkRef.current = check; autoOkRef.current = autoOk; });

  // Sources: socket push + polling triggers + "typed on this page".
  useEffect(() => {
    if (!MY_BUILD) return;
    const off = subscribe('app:version', (d) => considerRef.current(d?.build));
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkRef.current();
      else if (pendingRef.current && autoOkRef.current()) applyNow(pendingRef.current);
    };
    const onFocus = () => checkRef.current();
    const onOnline = () => checkRef.current(true);
    const onInput = () => { dirtyRef.current = true; };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    const timer = setInterval(() => checkRef.current(true), POLL_MS);
    checkRef.current(true);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onInput, true);
      clearInterval(timer);
    };
  }, [subscribe]);

  // Route change = the natural safe point: whatever was typed on the old
  // page is behind us, so apply a pending build here (unless a field is
  // already focused on the new page, a loop is suspected, or storage is
  // blocked). "Later" is honoured until here, as the banner says.
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === lastPath.current) return;
    lastPath.current = location.pathname;
    dirtyRef.current = false;
    if (pendingRef.current && !loopRef.current && !blocked && !focusBusy()) applyNow(pendingRef.current);
    else checkRef.current();
  }, [location.pathname, blocked]);

  // Countdown: one 1-second ticker while a build is pending and auto-apply
  // is allowed. Not mid-work → counts 10 → 0 and reloads. Mid-work → the
  // count pauses at "waiting" and restarts from 10 once they are free.
  useEffect(() => {
    if (!pending || deferred || loopSuspect || blocked) return;
    let left = null;
    const tick = () => {
      if (focusBusy() || dirtyRef.current) { left = null; setCountdown(null); return; }
      left = left == null ? COUNTDOWN_S : left - 1;
      if (left <= 0) { clearInterval(t); applyNow(pending); return; }
      setCountdown(left);
    };
    const t = setInterval(tick, 1000);
    const t0 = setTimeout(tick, 0);   // first evaluation right away
    return () => { clearInterval(t); clearTimeout(t0); };
  }, [pending, deferred, loopSuspect, blocked]);

  if (!pending) return null;
  const count = (!deferred && !loopSuspect && !blocked) ? countdown : null;
  const note = loopSuspect ? 'could not switch automatically — click Update'
    : blocked ? 'tap Update when you are free — you will sign in again'
    : count != null ? `updating in ${count}s`
    : deferred ? 'will apply when you move to the next page'
    : 'waiting till you finish here — applies when you move to the next page';
  return (
    // Phones: just under the header (the AI chat panel owns the bottom).
    // Desktop: bottom-centre pill.
    <div className="fixed z-[60] max-w-[95vw] left-1/2 -translate-x-1/2 top-16 sm:top-auto sm:bottom-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 rounded-full bg-indigo-700 text-white shadow-xl px-4 py-2 text-xs sm:text-sm">
        <span className="font-semibold">🔄 New version ready</span>
        <span className="text-indigo-100">{note}</span>
        <button type="button" onClick={() => applyNow(pending)}
          className="px-3 py-1 rounded-full bg-white text-indigo-700 font-bold hover:bg-indigo-50">Update now</button>
        {count != null && (
          <button type="button" onClick={() => { setDeferred(true); setCountdown(null); }}
            className="px-2 py-1 rounded-full text-indigo-100 hover:text-white hover:bg-indigo-600">Later</button>
        )}
      </div>
    </div>
  );
}
