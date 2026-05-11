import { useState, useEffect } from 'react';
import { Link, useLocation, Outlet } from 'react-router-dom';
import HelpTicket from './HelpTicket';
import AnnouncementBell from './AnnouncementBell';
import EnablePushButton from './EnablePushButton';
import AIAgentChat from './AIAgentChat';
import Modal from './Modal';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import {
  FiHome, FiUsers, FiTarget, FiFileText, FiShoppingCart,
  FiTruck, FiTool, FiAlertCircle, FiUserPlus,
  FiCheckSquare, FiMenu, FiX, FiLogOut, FiPackage, FiClipboard, FiChevronRight,
  FiSettings, FiShield, FiTrendingUp, FiCreditCard, FiLayers, FiBarChart2, FiBook, FiGrid, FiKey, FiMapPin, FiHelpCircle
} from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

const menuItems = [
  { path: '/', label: 'Dashboard', icon: FiHome, module: 'dashboard' },
  { path: '/cashflow', label: 'Cash Flow', icon: FiTrendingUp, module: 'cashflow' },
  { path: '/payment-required', label: 'Payment Required', icon: LuIndianRupee, module: 'payment_required' },
  { path: '/attendance', label: 'Attendance', icon: FiCheckSquare, module: 'attendance' },
  { path: '/collections', label: 'Collection Engine', icon: FiCreditCard, module: 'collections' },
  { path: '/dpr', label: 'DPR', icon: FiBarChart2, module: 'dpr' },
  { path: '/delegations', label: 'Delegations', icon: FiCheckSquare, module: 'delegations' },
  { path: '/pms-tasks', label: 'PMS Tasks', icon: FiLayers, module: 'pms_tasks' },
  { path: '/leads', label: 'Sales Funnel', icon: FiTarget, module: 'leads' },
  { path: '/quotations', label: 'BOQ & Quotations', icon: FiFileText, module: 'quotations' },
  { path: '/business-book', label: 'Business Book', icon: FiBook, module: 'business_book' },
  { path: '/item-master', label: 'Item Master', icon: FiGrid, module: 'item_master' },
  { path: '/orders', label: 'Orders & Planning', icon: FiShoppingCart, module: 'orders' },
  { path: '/vendors', label: 'Vendors', icon: FiTruck, module: 'vendors' },
  { path: '/sub-contractors', label: 'Sub-Contractors', icon: FiUserPlus, module: null },
  { path: '/customers', label: 'Customers', icon: FiUsers, module: 'customers' },
  { path: '/procurement', label: 'Indent to Dispatch', icon: FiPackage, module: 'procurement' },
  { path: '/price-required', label: 'Price Required', icon: LuIndianRupee, module: null },
  { path: '/inventory', label: 'Inventory', icon: FiPackage, module: 'inventory' },
  { path: '/tools', label: 'Tools', icon: FiTool, module: 'tools' },
  { path: '/rentals', label: 'Room Rentals', icon: FiHome, module: 'rentals' },
  { path: '/installation', label: 'Installation', icon: FiTool, module: 'installation' },
  { path: '/billing', label: 'Billing', icon: FiClipboard, module: 'billing' },
  { path: '/complaints', label: 'Complaints', icon: FiAlertCircle, module: 'complaints' },
  { path: '/snags', label: 'Snag List', icon: FiAlertCircle, module: 'snags' },
  { path: '/company-assets', label: 'Company Assets', icon: FiPackage, module: 'company_assets' },
  { path: '/hr', label: 'HR & Hiring', icon: FiUserPlus, module: 'hr' },
  { path: '/payroll', label: 'Payroll', icon: LuIndianRupee, module: 'payroll' },
  { path: '/scorecard', label: 'Scorecard (MIS)', icon: FiBarChart2, module: 'scoring' },
  { path: '/employees', label: 'Employees', icon: FiUsers, module: 'employees' },
  { path: '/expenses', label: 'Expenses', icon: LuIndianRupee, module: 'expenses' },
  { path: '/checklists', label: 'Checklists', icon: FiCheckSquare, module: 'checklists' },
  // Help Tickets is open to everyone — module=null bypasses canView gate.
  { path: '/help-tickets', label: 'Help Tickets', icon: FiHelpCircle, module: null },
];

const adminItems = [
  { path: '/admin/users', label: 'User Management', icon: FiSettings, module: 'users' },
  { path: '/admin/roles', label: 'Roles & Permissions', icon: FiShield, module: 'users' },
  { path: '/admin/word-count', label: 'Daily Activity', icon: FiBarChart2, module: 'users' },
  { path: '/admin/locations', label: 'Location Tracking', icon: FiMapPin, module: 'users' },
  { path: '/admin/collections-md', label: 'MD Collections', icon: FiTrendingUp, module: 'users' },
  { path: '/admin/backups', label: 'Database Backups', icon: FiPackage, module: 'users' },
  { path: '/admin/audit', label: 'Audit Log', icon: FiShield, module: 'users' },
  { path: '/admin/ai-settings', label: 'AI Settings', icon: FiSettings, module: 'users' },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [pwdModal, setPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [pwdSaving, setPwdSaving] = useState(false);
  const location = useLocation();
  const { user, logout, canView, isAdmin, userRoles } = useAuth();

  const changePassword = async (e) => {
    e.preventDefault();
    if (pwdForm.new_password !== pwdForm.confirm) { toast.error('New password and confirmation do not match'); return; }
    if (!pwdForm.new_password || pwdForm.new_password.length < 4) { toast.error('New password must be at least 4 characters'); return; }
    setPwdSaving(true);
    try {
      await api.post('/auth/change-password', { current_password: pwdForm.current_password, new_password: pwdForm.new_password });
      toast.success('Password changed');
      setPwdModal(false);
      setPwdForm({ current_password: '', new_password: '', confirm: '' });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    }
    setPwdSaving(false);
  };

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setSidebarOpen(true);
      else setSidebarOpen(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close sidebar on mobile when route changes
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [location.pathname, isMobile]);

  // GLOBAL LOCATION TRACKING — was Attendance-page-only before, but mam's
  // team often closes that tab and just uses Leads / Procurement / etc.
  // Running it from the Layout means as long as ANY ERP page is open in
  // the browser (or installed PWA), GPS pings every 30 seconds. Each ping
  // also acts as a heartbeat for backend auto-punch.
  // Limitations: a fully-closed browser cannot ping. For 24/7 tracking
  // even when the app is closed, we'd need a native Android wrapper.
  useEffect(() => {
    if (!user) return;                    // not logged in -> no tracking
    if (!navigator.geolocation) return;   // no GPS support
    let cancelled = false;
    let wakeLock = null;

    const trackLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          // accuracy is the radius of GPS uncertainty in meters. Backend
          // uses it to apply a tolerance to the geofence check so users
          // physically on site aren't tagged "Outside" because of indoor
          // GPS drift / cloud cover noise.
          api.post('/attendance/track-location', {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy || 0,
            address: '',
          }).catch(() => {});
        },
        () => {},                              // permission denied / timeout — silent
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
      );
    };

    // Best-effort wake lock so phone screen / tab doesn't fully suspend
    // mid-day; not all browsers support this — silently ignore if missing.
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (e) { /* ignore */ }
    };
    requestWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestWakeLock();
    });

    trackLocation();
    const interval = setInterval(trackLocation, 30 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (wakeLock && wakeLock.release) wakeLock.release().catch(() => {});
    };
  }, [user?.id]);

  // module === null means "always visible" (e.g. Help Tickets — open to everyone)
  const visibleMenu = menuItems.filter(item => item.module == null || canView(item.module));

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && isMobile && (
        <div className="fixed inset-0 bg-black/60 z-30" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:relative z-40 h-full bg-gradient-to-b from-red-800 to-red-900 text-white flex flex-col transition-transform duration-300 flex-shrink-0 ${isMobile ? 'w-[80vw] max-w-[260px]' : 'w-64'} ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 border-b border-white/10 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-2">
              {/* Real SEPL logo (served from /sepl-logo.webp). If the file
                  is missing, fall back to the 'SE' monogram so the header
                  never looks broken. */}
              <div className="w-9 h-9 bg-white rounded-lg flex items-center justify-center shadow-lg shadow-red-900/40 overflow-hidden p-0.5">
                <img
                  src="/sepl-logo.webp"
                  alt="SEPL"
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    if (!e.target.dataset.fallback) {
                      e.target.dataset.fallback = '1';
                      e.target.style.display = 'none';
                      const txt = e.target.parentElement.querySelector('span');
                      if (txt) txt.style.display = '';
                    }
                  }}
                />
                <span className="text-red-700 font-extrabold text-xs" style={{ display: 'none' }}>SE</span>
              </div>
              <div>
                <h1 className="text-sm font-extrabold tracking-tight">SEPL ERP</h1>
                <p className="text-[9px] text-red-200 -mt-0.5">Secured Engineers</p>
              </div>
            </div>
          </div>
          {isMobile && <button className="p-1.5 hover:bg-white/10 rounded" onClick={() => setSidebarOpen(false)}><FiX size={18} /></button>}
        </div>
        <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {visibleMenu.map(item => (
            <Link key={item.path} to={item.path}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === item.path ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
              <item.icon size={16} />
              <span className="truncate">{item.label}</span>
            </Link>
          ))}
          {isAdmin() && (
            <>
              <div className="pt-3 pb-1 px-3"><span className="text-[10px] font-semibold text-red-200 uppercase">Admin</span></div>
              {adminItems.map(item => (
                <Link key={item.path} to={item.path}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === item.path ? 'bg-white/15 text-white font-medium' : 'text-red-100 hover:bg-white/10 hover:text-white'}`}>
                  <item.icon size={16} />
                  <span className="truncate">{item.label}</span>
                </Link>
              ))}
            </>
          )}
        </nav>
        <div className="p-3 border-t border-white/10">
          <div className="text-sm text-red-50">{user?.name}</div>
          {user?.username && <div className="text-[10px] text-red-200 font-mono">@{user.username}</div>}
          <div className="text-[10px] text-red-300 mb-1">{user?.email}</div>
          <div className="flex flex-wrap gap-1 mb-2">
            {userRoles.map((r, i) => (
              <span key={i} className="text-[9px] bg-white/20 text-white px-1.5 py-0.5 rounded">{r}</span>
            ))}
          </div>
          <button onClick={() => setPwdModal(true)} className="flex items-center gap-2 px-3 py-1.5 text-sm text-red-100 hover:text-white hover:bg-white/10 rounded w-full mb-1">
            <FiKey size={14} /> <span>Change Password</span>
          </button>
          <button onClick={logout} className="flex items-center gap-2 px-3 py-1.5 text-sm text-yellow-200 hover:text-white hover:bg-white/10 rounded w-full">
            <FiLogOut size={15} /> <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Change Password Modal */}
      <Modal isOpen={pwdModal} onClose={() => setPwdModal(false)} title="Change Password">
        <form onSubmit={changePassword} className="space-y-4">
          <div>
            <label className="label">Current Password</label>
            <input className="input" type="password" autoComplete="current-password" value={pwdForm.current_password} onChange={e => setPwdForm({ ...pwdForm, current_password: e.target.value })} required />
          </div>
          <div>
            <label className="label">New Password</label>
            <input className="input" type="password" autoComplete="new-password" value={pwdForm.new_password} onChange={e => setPwdForm({ ...pwdForm, new_password: e.target.value })} required minLength={4} />
          </div>
          <div>
            <label className="label">Confirm New Password</label>
            <input className="input" type="password" autoComplete="new-password" value={pwdForm.confirm} onChange={e => setPwdForm({ ...pwdForm, confirm: e.target.value })} required />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setPwdModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={pwdSaving} className="btn btn-primary">{pwdSaving ? 'Saving...' : 'Change Password'}</button>
          </div>
        </form>
      </Modal>

      {/* Floating "expand sidebar" tab — only when sidebar is collapsed
          on desktop. Mam: 'if I hide sidebar then show expand'. Sticky
          to the left edge so it's impossible to miss. */}
      {!sidebarOpen && !isMobile && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed left-0 top-1/2 -translate-y-1/2 z-30 bg-red-700 hover:bg-red-600 text-white pl-1.5 pr-2.5 py-3 rounded-r-lg shadow-lg shadow-red-900/30 flex items-center gap-1 transition-all hover:pl-2.5 group"
          title="Expand sidebar"
        >
          <FiChevronRight size={18} />
          <span className="text-[10px] font-bold uppercase tracking-wider hidden group-hover:inline">Menu</span>
        </button>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden w-full">
        <header className="bg-white shadow-sm border-b border-gray-200 px-3 md:px-6 py-2.5 flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0 text-gray-700"
            title={sidebarOpen ? 'Hide sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? <FiMenu size={20} /> : <FiChevronRight size={20} />}
          </button>
          <h2 className="text-sm md:text-lg font-semibold text-gray-800 truncate flex-1">
            {[...menuItems, ...adminItems].find(m => m.path === location.pathname)?.label || 'SEPL ERP'}
          </h2>
          {/* Push notification toggle — phone / laptop / desktop each
              need to be enabled separately. Mam's MD requirement. */}
          <EnablePushButton />
          {/* Announcement bell — every page has it. Admin can post from the
              dropdown panel; everyone else sees the unread badge + list. */}
          <AnnouncementBell />
        </header>
        <main className="flex-1 overflow-y-auto p-2 md:p-6 bg-slate-50">
          <Outlet />
        </main>
      </div>
      <HelpTicket />
      <AIAgentChat />
    </div>
  );
}
