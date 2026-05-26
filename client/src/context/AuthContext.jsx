import { createContext, useContext, useState, useEffect } from 'react';
import api from '../api';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [userRoles, setUserRoles] = useState([]);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      api.get('/auth/me')
        .then(r => {
          setUser({
            id: r.data.id, name: r.data.name, email: r.data.email, username: r.data.username,
            role: r.data.role, department: r.data.department, phone: r.data.phone,
            approval_role: r.data.approval_role || null,
            has_recovery_code: !!r.data.has_recovery_code,
          });
          setPermissions(r.data.permissions || {});
          setUserRoles(r.data.userRoles || []);
        })
        .catch(() => logout())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [token]);

  const login = async (identifier, password) => {
    // Accept username or email — backend matches either.
    const { data } = await api.post('/auth/login', { username: identifier, email: identifier, password });
    localStorage.setItem('token', data.token);
    api.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
    setToken(data.token);
    setUser(data.user);
    setPermissions(data.permissions || {});
    setUserRoles(data.userRoles || []);
    // Best-effort: re-subscribe this device for push notifications so
    // PM2 restarts or expired endpoints don't silently lose this device.
    // Only triggers if the user previously granted permission — never
    // pops a fresh permission prompt (that lives in the bell-icon button).
    setTimeout(() => {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          import('../lib/push').then(m => m.enablePushNotifications());
        }
      } catch {}
    }, 500);
    return data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    delete api.defaults.headers.common['Authorization'];
    setToken(null);
    setUser(null);
    setPermissions({});
    setUserRoles([]);
  };

  // Permission helper functions
  const can = (module, action = 'view') => {
    if (user?.role === 'admin') return true;
    const perm = permissions[module];
    if (!perm) return false;
    const actionMap = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' };
    return !!perm[actionMap[action]];
  };

  const canView = (module) => can(module, 'view');
  const canCreate = (module) => can(module, 'create');
  const canEdit = (module) => can(module, 'edit');
  const canDelete = (module) => can(module, 'delete');
  const canApprove = (module) => can(module, 'approve');
  // The "See All" toggle in the role matrix — bypasses scope filters
  // (e.g. show every help ticket / DPR / cashflow project, not just
  // the user's own). Admin always passes.
  const canSeeAll = (module) => {
    if (user?.role === 'admin') return true;
    return !!permissions[module]?.can_see_all;
  };
  const isAdmin = () => user?.role === 'admin';

  // Called after the user successfully saves a recovery code so the
  // force-set modal stops appearing without a full /auth/me refetch.
  const markRecoveryCodeSet = () => setUser(u => u ? { ...u, has_recovery_code: true } : u);

  return (
    <AuthContext.Provider value={{
      user, token, permissions, userRoles,
      login, logout, loading,
      can, canView, canCreate, canEdit, canDelete, canApprove, canSeeAll, isAdmin,
      markRecoveryCodeSet,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
