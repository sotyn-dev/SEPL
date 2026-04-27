import { useState, useEffect } from 'react';
import { Link, useLocation, Outlet } from 'react-router-dom';
import HelpTicket from './HelpTicket';
import Modal from './Modal';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import {
  FiHome, FiUsers, FiTarget, FiFileText, FiShoppingCart,
  FiTruck, FiTool, FiAlertCircle, FiUserPlus,
  FiCheckSquare, FiMenu, FiX, FiLogOut, FiPackage, FiClipboard,
  FiSettings, FiShield, FiTrendingUp, FiCreditCard, FiLayers, FiBarChart2, FiBook, FiGrid, FiKey
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
  { path: '/leads', label: 'Leads / CRM', icon: FiTarget, module: 'leads' },
  { path: '/quotations', label: 'BOQ & Quotations', icon: FiFileText, module: 'quotations' },
  { path: '/business-book', label: 'Business Book', icon: FiBook, module: 'business_book' },
  { path: '/item-master', label: 'Item Master', icon: FiGrid, module: 'item_master' },
  { path: '/orders', label: 'Orders & Planning', icon: FiShoppingCart, module: 'orders' },
  { path: '/vendors', label: 'Vendors', icon: FiTruck, module: 'vendors' },
  { path: '/customers', label: 'Customers', icon: FiUsers, module: 'customers' },
  { path: '/procurement', label: 'Indent to Dispatch', icon: FiPackage, module: 'procurement' },
  { path: '/installation', label: 'Installation', icon: FiTool, module: 'installation' },
  { path: '/billing', label: 'Billing', icon: FiClipboard, module: 'billing' },
  { path: '/complaints', label: 'Complaints', icon: FiAlertCircle, module: 'complaints' },
  { path: '/hr', label: 'HR & Hiring', icon: FiUserPlus, module: 'hr' },
  { path: '/employees', label: 'Employees', icon: FiUsers, module: 'employees' },
  { path: '/expenses', label: 'Expenses', icon: LuIndianRupee, module: 'expenses' },
  { path: '/checklists', label: 'Checklists', icon: FiCheckSquare, module: 'checklists' },
];

const adminItems = [
  { path: '/admin/users', label: 'User Management', icon: FiSettings, module: 'users' },
  { path: '/admin/roles', label: 'Roles & Permissions', icon: FiShield, module: 'users' },
  { path: '/admin/word-count', label: 'Daily Activity', icon: FiBarChart2, module: 'users' },
  { path: '/admin/backups', label: 'Database Backups', icon: FiPackage, module: 'users' },
  { path: '/admin/audit', label: 'Audit Log', icon: FiShield, module: 'users' },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [pwdModal, setPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [pwdSaving, setPwdSaving] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [forceCode, setForceCode] = useState('');
  const [forceSaving, setForceSaving] = useState(false);
  const location = useLocation();
  const { user, logout, canView, isAdmin, userRoles, markRecoveryCodeSet } = useAuth();

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

  const saveRecoveryCode = async (e) => {
    e.preventDefault();
    if (!recoveryCode || recoveryCode.length < 4) { toast.error('Recovery code must be at least 4 characters'); return; }
    setRecoverySaving(true);
    try {
      const r = await api.post('/auth/recovery-code', { recovery_code: recoveryCode });
      toast.success(r.data?.message || 'Recovery code saved');
      markRecoveryCodeSet();
      setRecoveryCode('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save recovery code');
    }
    setRecoverySaving(false);
  };

  // First-login force flow: until the user sets a recovery code, every page
  // is blocked by a non-dismissible modal. Guarantees no one can be locked
  // out — they can always self-recover via "Forgot password?" later.
  const submitForceCode = async (e) => {
    e.preventDefault();
    if (!forceCode || forceCode.length < 4) { toast.error('Recovery code must be at least 4 characters'); return; }
    setForceSaving(true);
    try {
      await api.post('/auth/recovery-code', { recovery_code: forceCode });
      toast.success('Recovery code saved. Keep it private!');
      markRecoveryCodeSet();
      setForceCode('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    }
    setForceSaving(false);
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

  const visibleMenu = menuItems.filter(item => canView(item.module));

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
              <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-lg shadow-red-900/40">
                <span className="text-red-700 font-extrabold text-xs">SE</span>
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

      {/* Change Password Modal — also lets the user set a personal recovery
          code so they can self-recover via "Forgot password?" on the login
          page without needing the developer / SSH access. */}
      <Modal isOpen={pwdModal} onClose={() => setPwdModal(false)} title="Account Security">
        <form onSubmit={changePassword} className="space-y-4">
          <h4 className="text-sm font-semibold text-gray-700 -mb-1">Change Password</h4>
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
            <button type="button" onClick={() => setPwdModal(false)} className="btn btn-secondary">Close</button>
            <button type="submit" disabled={pwdSaving} className="btn btn-primary">{pwdSaving ? 'Saving...' : 'Change Password'}</button>
          </div>
        </form>

        <div className="border-t my-5"></div>

        <form onSubmit={saveRecoveryCode} className="space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-1 flex items-center gap-2">
              <FiKey size={14} className="text-red-600" /> Recovery Code
            </h4>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              Set a personal code (a phrase only you know — e.g. <em>"my-school-1995"</em>) so you can reset your password yourself from the
              <span className="font-medium"> "Forgot password?"</span> link on the login page. Without this, only an admin can unlock you.
            </p>
          </div>
          <div>
            <label className="label">New Recovery Code</label>
            <input
              className="input"
              type="text"
              value={recoveryCode}
              onChange={e => setRecoveryCode(e.target.value)}
              placeholder="Minimum 4 characters — keep it private"
              minLength={4}
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={recoverySaving || !recoveryCode} className="btn btn-primary">
              {recoverySaving ? 'Saving...' : 'Save Recovery Code'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden w-full">
        <header className="bg-white shadow-sm border-b border-gray-200 px-3 md:px-6 py-2.5 flex items-center gap-2">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0">
            <FiMenu size={20} />
          </button>
          <h2 className="text-sm md:text-lg font-semibold text-gray-800 truncate">
            {[...menuItems, ...adminItems].find(m => m.path === location.pathname)?.label || 'SEPL ERP'}
          </h2>
        </header>
        <main className="flex-1 overflow-y-auto p-2 md:p-6 bg-slate-50">
          <Outlet />
        </main>
      </div>
      <HelpTicket />

      {/* Force-set recovery code on first login. Non-dismissible — no
          backdrop click, no close button, no logout shortcut. The user
          MUST set a code before they can use the app. Once set, this
          modal never appears again for them. Result: every user is
          guaranteed to have self-recovery, so no future lockout. */}
      {user && user.has_recovery_code === false && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-xl bg-red-100 flex items-center justify-center text-red-600 flex-shrink-0">
                <FiKey size={22} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-800">Set your recovery code</h2>
                <p className="text-[12px] text-gray-500">One-time setup — takes 10 seconds</p>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[12px] text-amber-900 mb-4 leading-relaxed">
              Pick a phrase only you know (e.g. <em>"my-school-1995"</em> or <em>"mumbai-2018"</em>).
              If you ever forget your password, this code lets you reset it yourself
              from the login page — no waiting for IT.
              <span className="block mt-1 font-semibold">Write it down somewhere safe before saving.</span>
            </div>
            <form onSubmit={submitForceCode} className="space-y-3">
              <div>
                <label className="label">Your Recovery Code</label>
                <input
                  className="input"
                  type="text"
                  value={forceCode}
                  onChange={e => setForceCode(e.target.value)}
                  placeholder="Minimum 4 characters"
                  minLength={4}
                  autoFocus
                  required
                />
              </div>
              <button
                type="submit"
                disabled={forceSaving || !forceCode || forceCode.length < 4}
                className="btn btn-primary w-full py-3"
              >
                {forceSaving ? 'Saving...' : 'Save & Continue'}
              </button>
              <button
                type="button"
                onClick={logout}
                className="text-[11px] text-gray-400 hover:text-gray-600 w-full text-center"
              >
                Sign out instead
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
