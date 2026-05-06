import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import Quotations from './pages/Quotations';
import Orders from './pages/Orders';
import BusinessBook from './pages/BusinessBook';
import ItemMaster from './pages/ItemMaster';
import PaymentRequired from './pages/PaymentRequired';
import Attendance from './pages/Attendance';
import Vendors from './pages/Vendors';
import Customers from './pages/Customers';
import Procurement from './pages/Procurement';
import PriceRequired from './pages/PriceRequired';
import Installation from './pages/Installation';
import Billing from './pages/Billing';
import Complaints from './pages/Complaints';
import HR from './pages/HR';
import Payroll from './pages/Payroll';
import SalarySlipPrint from './pages/SalarySlipPrint';
import Scorecard from './pages/Scorecard';
import Tools from './pages/Tools';
import Rentals from './pages/Rentals';
import Employees from './pages/Employees';
import Expenses from './pages/Expenses';
import Checklists from './pages/Checklists';
import CashFlow from './pages/CashFlow';
import Collections from './pages/Collections';
import IndentFMS from './pages/IndentFMS';
import DPR from './pages/DPR';
import Delegation from './pages/Delegation';
import PMSTasks from './pages/PMSTasks';
import Inventory from './pages/Inventory';
import HelpTickets from './pages/HelpTickets';
import VendorPOPrint from './pages/VendorPOPrint';
import IndentPrint from './pages/IndentPrint';
import UserManagement from './pages/admin/UserManagement';
import RolesPermissions from './pages/admin/RolesPermissions';
import DatabaseBackups from './pages/admin/DatabaseBackups';
import AuditLog from './pages/admin/AuditLog';
import WordCount from './pages/admin/WordCount';
import Locations from './pages/admin/Locations';
import CollectionsMD from './pages/admin/CollectionsMD';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  return user ? children : <Navigate to="/login" />;
}

function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  return isAdmin() ? children : <Navigate to="/" />;
}

function ModuleRoute({ module, children }) {
  const { canView, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!canView(module)) return (
    <div className="flex flex-col items-center justify-center h-96 text-gray-400">
      <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      <h3 className="text-lg font-medium text-gray-500">Access Denied</h3>
      <p className="text-sm mt-1">You don't have permission to access this module. Contact your admin.</p>
    </div>
  );
  return children;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="flex items-center justify-center h-screen text-lg">Loading...</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      {/* Print routes — auth-gated but rendered WITHOUT the sidebar / header
          chrome so the document fills the viewport cleanly. */}
      <Route path="/vendor-po/:id/print" element={<ProtectedRoute><VendorPOPrint /></ProtectedRoute>} />
      <Route path="/indent/:id/print" element={<ProtectedRoute><IndentPrint /></ProtectedRoute>} />
      <Route path="/payroll/slip/:employee_id" element={<ProtectedRoute><SalarySlipPrint /></ProtectedRoute>} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        {/* 4 Critical Systems */}
        <Route path="cashflow" element={<ModuleRoute module="cashflow"><CashFlow /></ModuleRoute>} />
        <Route path="payment-required" element={<ModuleRoute module="payment_required"><PaymentRequired /></ModuleRoute>} />
        <Route path="attendance" element={<ModuleRoute module="attendance"><Attendance /></ModuleRoute>} />
        <Route path="collections" element={<ModuleRoute module="collections"><Collections /></ModuleRoute>} />
        <Route path="indent-fms" element={<ModuleRoute module="indent_fms"><IndentFMS /></ModuleRoute>} />
        <Route path="dpr" element={<ModuleRoute module="dpr"><DPR /></ModuleRoute>} />
        <Route path="delegations" element={<ModuleRoute module="delegations"><Delegation /></ModuleRoute>} />
        <Route path="pms-tasks" element={<ModuleRoute module="pms_tasks"><PMSTasks /></ModuleRoute>} />
        {/* Other Modules */}
        <Route path="leads" element={<ModuleRoute module="leads"><Leads /></ModuleRoute>} />
        <Route path="quotations" element={<ModuleRoute module="quotations"><Quotations /></ModuleRoute>} />
        <Route path="business-book" element={<ModuleRoute module="business_book"><BusinessBook /></ModuleRoute>} />
        <Route path="item-master" element={<ModuleRoute module="item_master"><ItemMaster /></ModuleRoute>} />
        <Route path="orders" element={<ModuleRoute module="orders"><Orders /></ModuleRoute>} />
        <Route path="vendors" element={<ModuleRoute module="vendors"><Vendors /></ModuleRoute>} />
        <Route path="customers" element={<ModuleRoute module="customers"><Customers /></ModuleRoute>} />
        <Route path="procurement" element={<ModuleRoute module="procurement"><Procurement /></ModuleRoute>} />
        <Route path="price-required" element={<PriceRequired />} />
        <Route path="inventory" element={<ModuleRoute module="inventory"><Inventory /></ModuleRoute>} />
        <Route path="help-tickets" element={<HelpTickets />} />
        <Route path="installation" element={<ModuleRoute module="installation"><Installation /></ModuleRoute>} />
        <Route path="billing" element={<ModuleRoute module="billing"><Billing /></ModuleRoute>} />
        <Route path="complaints" element={<ModuleRoute module="complaints"><Complaints /></ModuleRoute>} />
        <Route path="hr" element={<ModuleRoute module="hr"><HR /></ModuleRoute>} />
        <Route path="payroll" element={<ModuleRoute module="payroll"><Payroll /></ModuleRoute>} />
        <Route path="scorecard" element={<ModuleRoute module="scoring"><Scorecard /></ModuleRoute>} />
        {/* Legacy /weekly-score URL → redirect to Scorecard's Team Overview tab.
            Kept so any bookmarked links / push notification deep-links don't 404. */}
        <Route path="weekly-score" element={<Navigate to="/scorecard" replace />} />
        <Route path="tools" element={<ModuleRoute module="tools"><Tools /></ModuleRoute>} />
        <Route path="rentals" element={<ModuleRoute module="rentals"><Rentals /></ModuleRoute>} />
        <Route path="employees" element={<ModuleRoute module="employees"><Employees /></ModuleRoute>} />
        <Route path="expenses" element={<ModuleRoute module="expenses"><Expenses /></ModuleRoute>} />
        <Route path="checklists" element={<ModuleRoute module="checklists"><Checklists /></ModuleRoute>} />
        {/* Admin Routes */}
        <Route path="admin/users" element={<AdminRoute><UserManagement /></AdminRoute>} />
        <Route path="admin/roles" element={<AdminRoute><RolesPermissions /></AdminRoute>} />
        <Route path="admin/backups" element={<AdminRoute><DatabaseBackups /></AdminRoute>} />
        <Route path="admin/audit" element={<AdminRoute><AuditLog /></AdminRoute>} />
        <Route path="admin/word-count" element={<AdminRoute><WordCount /></AdminRoute>} />
        <Route path="admin/locations" element={<AdminRoute><Locations /></AdminRoute>} />
        <Route path="admin/collections-md" element={<AdminRoute><CollectionsMD /></AdminRoute>} />
      </Route>
    </Routes>
  );
}
