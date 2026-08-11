import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, setToken } from './lib/api.js';
import LoginPage from './pages/LoginPage.jsx';
import OrgsPage from './pages/OrgsPage.jsx';
import OrgOverviewPage from './pages/OrgOverviewPage.jsx';
import EntitlementsPage from './pages/EntitlementsPage.jsx';
import BrandPage from './pages/BrandPage.jsx';
import PlansPage from './pages/PlansPage.jsx';
import SurfacesPage from './pages/SurfacesPage.jsx';
import DeployPage from './pages/DeployPage.jsx';

const linkClass = ({ isActive }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition whitespace-nowrap ${
    isActive
      ? 'bg-blue-800/10 text-blue-900'
      : 'text-slate-600 hover:text-blue-900 hover:bg-slate-100'
  }`;

function BrandRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/orgs/${slug}/brand`} replace />;
}

function Shell({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api('/api/auth/me')
      .then(async (r) => {
        if (!r.ok) return;
        const d = await r.json();
        setUser(d.user);
      })
      .catch(() => {});
  }, []);

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setToken('');
    navigate('/login', { replace: true });
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      <header className="border-b border-slate-200 bg-white sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2.5">
          <div className="flex items-center gap-3">
            <NavLink to="/" className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0" onClick={closeMenu}>
              <img
                src="/sotyn-logo.png"
                alt="sotyn.ai"
                className="h-8 sm:h-9 w-auto max-w-[140px] sm:max-w-none object-contain object-left rounded"
              />
              <span className="hidden sm:inline text-[10px] uppercase tracking-[0.22em] text-blue-800 font-semibold border-l border-slate-200 pl-3">
                Platform
              </span>
            </NavLink>

            <nav className="hidden md:flex gap-1 min-w-0 overflow-x-auto items-center flex-1">
              <NavLink to="/" end className={linkClass}>Companies</NavLink>
              <NavLink to="/deploy" className={linkClass}>Deploy</NavLink>
              <NavLink to="/plans" className={linkClass}>Plans</NavLink>
              <span className="px-2 py-1.5 text-xs text-slate-400 cursor-default" title="Later">Audit</span>
              <span className="px-2 py-1.5 text-xs text-slate-400 cursor-default" title="Later">Operators</span>
              <NavLink to="/dev/surfaces" className={linkClass}>Dev</NavLink>
            </nav>

            <div className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
              {user && (
                <span className="hidden lg:inline text-xs text-slate-500">{user.username}</span>
              )}
              <button
                type="button"
                onClick={logout}
                className="hidden sm:inline-flex text-xs font-medium text-slate-600 hover:text-blue-900 px-2.5 py-1.5 rounded-md border border-slate-200 hover:border-slate-300 bg-white"
              >
                Sign out
              </button>
              <button
                type="button"
                className="md:hidden inline-flex items-center justify-center min-w-[2.5rem] h-9 px-2 rounded-md border border-slate-200 text-xs font-medium text-slate-700 bg-white"
                aria-expanded={menuOpen}
                aria-label="Menu"
                onClick={() => setMenuOpen((o) => !o)}
              >
                {menuOpen ? 'Close' : 'Menu'}
              </button>
            </div>
          </div>

          {menuOpen && (
            <nav className="md:hidden mt-3 pt-3 border-t border-slate-100 flex flex-col gap-1 pb-1">
              <NavLink to="/" end className={linkClass} onClick={closeMenu}>Companies</NavLink>
              <NavLink to="/deploy" className={linkClass} onClick={closeMenu}>Deploy</NavLink>
              <NavLink to="/plans" className={linkClass} onClick={closeMenu}>Plans</NavLink>
              <span className="px-3 py-1.5 text-xs text-slate-400">Audit · later</span>
              <span className="px-3 py-1.5 text-xs text-slate-400">Operators · later</span>
              <NavLink to="/dev/surfaces" className={linkClass} onClick={closeMenu}>Dev</NavLink>
              <button
                type="button"
                onClick={() => { closeMenu(); logout(); }}
                className="mt-1 text-left px-3 py-1.5 text-sm text-slate-600"
              >
                Sign out{user ? ` (${user.username})` : ''}
              </button>
            </nav>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-4 py-5 sm:py-8">{children}</main>
    </div>
  );
}

function RequireAuth({ children }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <Shell>{children}</Shell>;
}

function Authed({ children }) {
  return <RequireAuth>{children}</RequireAuth>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Authed><OrgsPage /></Authed>} />
      <Route path="/deploy" element={<Authed><DeployPage /></Authed>} />
      <Route path="/plans" element={<Authed><PlansPage /></Authed>} />
      <Route path="/orgs/:slug" element={<Authed><OrgOverviewPage /></Authed>} />
      <Route path="/orgs/:slug/entitlements" element={<Authed><EntitlementsPage /></Authed>} />
      <Route path="/orgs/:slug/brand" element={<Authed><BrandPage /></Authed>} />
      <Route path="/brand/:slug" element={<BrandRedirect />} />
      <Route path="/dev/surfaces" element={<Authed><SurfacesPage /></Authed>} />
      <Route path="/surfaces" element={<Navigate to="/dev/surfaces" replace />} />
    </Routes>
  );
}
