// Module availability on the client — mirrors server/lib/features.js.
//
// This is NOT permissions. RBAC ("may this role use it") stays in AuthContext /
// ModuleRoute and is untouched. This answers "is the module switched on for the
// organisation at all", which RBAC structurally cannot express: can() short-circuits
// on role === 'admin', so an admin can never be shown a module as unavailable.
//
// The server is the real gate — every disabled module's API 404s regardless of what
// renders here. So this layer FAILS OPEN on purpose: if the fetch errors, or the
// provider is missing, everything renders exactly as it does today rather than the
// app collapsing into "everything is off".
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import api from '../api';
import { useAuth } from './AuthContext';
import { useAppSocket } from './SocketProvider';

const ModuleFlagsContext = createContext(null);

// Safe fallback when a consumer mounts outside the provider — degrades to "everything
// available" (the server still enforces), never to a blank app.
const NOOP = { access: () => ({ ok: true }), loading: false, modules: [], refresh: () => {} };
export const useModuleFlags = () => useContext(ModuleFlagsContext) || NOOP;

export function ModuleFlagsProvider({ children }) {
  const { user } = useAuth();
  const { subscribe } = useAppSocket();
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    return api.get('/module-flags')
      .then(r => setModules(r.data?.modules || []))
      .catch(() => {})                       // fail open — keep the last known state
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user?.id) { setLoading(false); return; }
    refresh();
  }, [user?.id, refresh]);

  // Live update when an admin flips a switch, so an open tab reacts immediately
  // instead of waiting for the focus refetch below. Additive: if the socket never
  // fires, the focus path still catches it.
  useEffect(() => {
    if (!user?.id) return;
    return subscribe('modules:changed', () => { refresh(); });
  }, [user?.id, subscribe, refresh]);

  // Fallback for a dropped socket — same on-focus pattern AuthContext uses to pick
  // up live permission grants.
  useEffect(() => {
    if (!user?.id) return;
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user?.id, refresh]);

  // THE single client-side gating call. Returns a REASON, not a boolean, so the
  // message is driven by why access failed. When an entitlement/orchestration layer
  // is added it becomes another branch here (checked BEFORE 'disabled') plus one
  // MESSAGES entry — no component changes anywhere.
  const access = useCallback((key) => {
    const m = modules.find(x => x.key === key);
    if (!m) return { ok: true };                     // unknown/not switchable → allowed
    if (m.enabled) return { ok: true, label: m.label };
    return { ok: false, reason: 'disabled', label: m.label, hint: m.offHint || null };
  }, [modules]);

  const value = useMemo(() => ({ access, modules, loading, refresh }),
    [access, modules, loading, refresh]);

  return <ModuleFlagsContext.Provider value={value}>{children}</ModuleFlagsContext.Provider>;
}

// Message per REASON (not per module) — the module name is interpolated from the
// registry label, so a new module needs no copy written for it.
const MESSAGES = {
  disabled: {
    title: (label) => `${label} is currently switched off`,
    body: 'This module has been turned off for your organisation.',
    adminBody: 'You turned this module off. Switch it back on in Settings → Roles & Permissions → Module availability.',
  },
  // not_entitled: added with the orchestration layer — one entry, no component change.
};

// Route guard for a switchable module. Deliberately separate from ModuleRoute (which
// keeps owning RBAC and is not modified): SOTYN Flow and SOTYN Chat have no view
// permission at all — access is board / group membership — so the two concerns never
// overlap for them. A module needing both can nest the two components.
export function ModuleGate({ module, children }) {
  const { access, loading } = useModuleFlags();
  const { isAdmin } = useAuth();

  // Hold the same centred loader the other route guards use until flags are known,
  // so a cold URL load never flashes the real page before the card.
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;

  const a = access(module);
  if (a.ok) return children;

  const msg = MESSAGES[a.reason] || MESSAGES.disabled;
  const admin = isAdmin();
  return (
    <div className="flex flex-col items-center justify-center h-96 text-gray-400 px-6 text-center">
      <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
      <h3 className="text-lg font-medium text-gray-500">{msg.title(a.label || module)}</h3>
      <p className="text-sm mt-1 max-w-md">{admin ? msg.adminBody : msg.body}</p>
      {a.hint && <p className="text-sm mt-1 max-w-md text-gray-400">{a.hint}</p>}
    </div>
  );
}
