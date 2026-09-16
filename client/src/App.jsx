import InitialPasswordChange from './components/InitialPasswordChange';
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ModuleGate } from './context/ModuleFlagsContext';
import Login from './pages/Login';
// Layout (the authenticated app shell — sidebar, header, CallProvider/WebRTC,
// AI chat, bells, ~64 icons) is lazy so it stays OUT of the entry chunk. A
// logged-out visitor's first paint is just Login; logged-in users fetch this
// chunk in parallel with their lazy page chunk under the <Suspense> below.
const Layout = lazy(() => import('./components/Layout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Leads = lazy(() => import('./pages/Leads'));
const Quotations = lazy(() => import('./pages/Quotations'));
const Estimator = lazy(() => import('./pages/Estimator'));
const SolarQuotation = lazy(() => import('./pages/SolarQuotation'));
const SolarDesignReport = lazy(() => import('./pages/SolarDesignReport'));
const SolarNetMeteringPrint = lazy(() => import('./pages/SolarNetMeteringPrint'));
const SolarRateMaster = lazy(() => import('./pages/SolarRateMaster'));
const SolarFunnel = lazy(() => import('./pages/SolarFunnel'));
const SolarMaterialMaster = lazy(() => import('./pages/SolarMaterialMaster'));
const SolarLabourMaster = lazy(() => import('./pages/SolarLabourMaster'));
const SolarProjects = lazy(() => import('./pages/SolarProjects'));
const SolarSiteDesign = lazy(() => import('./pages/SolarSiteDesign'));
const PoFocStripped = lazy(() => import('./pages/PoFocStripped'));
const PoFocPrint = lazy(() => import('./pages/PoFocPrint'));
const LabourRate = lazy(() => import('./pages/LabourRate'));
const Orders = lazy(() => import('./pages/Orders'));
const DispatchReceiving = lazy(() => import('./pages/DispatchReceiving'));
const BusinessBook = lazy(() => import('./pages/BusinessBook'));
const ItemMaster = lazy(() => import('./pages/ItemMaster'));
const PaymentRequired = lazy(() => import('./pages/PaymentRequired'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Vendors = lazy(() => import('./pages/Vendors'));
const Customers = lazy(() => import('./pages/Customers'));
const Procurement = lazy(() => import('./pages/Procurement'));
const SalesBillReceive = lazy(() => import('./pages/SalesBillReceive'));
const PriceRequired = lazy(() => import('./pages/PriceRequired'));
const Installation = lazy(() => import('./pages/Installation'));
const SalesBilling = lazy(() => import('./pages/SalesBilling'));
const Billing = lazy(() => import('./pages/Billing'));
const Complaints = lazy(() => import('./pages/Complaints'));
const HR = lazy(() => import('./pages/HR'));
const Payroll = lazy(() => import('./pages/Payroll'));
const SalarySlipPrint = lazy(() => import('./pages/SalarySlipPrint'));
const Scorecard = lazy(() => import('./pages/Scorecard'));
const Champions = lazy(() => import('./pages/Champions'));
const ModuleOwners = lazy(() => import('./pages/ModuleOwners'));
const Tools = lazy(() => import('./pages/Tools'));
const Rentals = lazy(() => import('./pages/Rentals'));
const Snags = lazy(() => import('./pages/Snags'));
const TallyBills = lazy(() => import('./pages/TallyBills'));
const ClientSnag = lazy(() => import('./pages/ClientSnag'));
const CompanyAssets = lazy(() => import('./pages/CompanyAssets'));
const Employees = lazy(() => import('./pages/Employees'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Checklists = lazy(() => import('./pages/Checklists'));
const Bank = lazy(() => import('./pages/Bank'));
const Collections = lazy(() => import('./pages/Collections'));
const ArApTracker = lazy(() => import('./pages/ArApTracker'));
const SiteChat = lazy(() => import('./pages/SiteChat'));
const SotynFlow = lazy(() => import('./pages/SotynFlow'));
const IndentFMS = lazy(() => import('./pages/IndentFMS'));
const DPR = lazy(() => import('./pages/DPR'));
const IndentLabourPayment = lazy(() => import('./pages/IndentLabourPayment'));
const LabourManagementSystem = lazy(() => import('./pages/LabourManagementSystem'));
const LabourMaster = lazy(() => import('./pages/LabourMaster'));
const BillVerification = lazy(() => import('./pages/BillVerification'));
const Delegation = lazy(() => import('./pages/Delegation'));
const PMSTasks = lazy(() => import('./pages/PMSTasks'));
const Inventory = lazy(() => import('./pages/Inventory'));
const HelpTickets = lazy(() => import('./pages/HelpTickets'));
const SystemRequirements = lazy(() => import('./pages/SystemRequirements'));
const SystemFlow = lazy(() => import('./pages/SystemFlow'));
const SystemRequirementWorkspace = lazy(() => import('./pages/SystemRequirements/Workspace'));
const VendorPOPrint = lazy(() => import('./pages/VendorPOPrint'));
const FileViewer = lazy(() => import('./pages/FileViewer'));
const ProcurementBoard = lazy(() => import('./pages/ProcurementBoard'));
const RatesItems = lazy(() => import('./pages/RatesItems'));
const RatesBoard = lazy(() => import('./pages/RatesBoard'));
const RateEnquiryPrint = lazy(() => import('./pages/RateEnquiryPrint'));
const DebitNotePrint = lazy(() => import('./pages/DebitNotePrint'));
const PaymentAdvicePrint = lazy(() => import('./pages/PaymentAdvicePrint'));
const DeliveryNotePrint = lazy(() => import('./pages/DeliveryNotePrint'));
const RentalPOPrint = lazy(() => import('./pages/RentalPOPrint'));
const IndentPrint = lazy(() => import('./pages/IndentPrint'));
const DeliveryBillPrint = lazy(() => import('./pages/DeliveryBillPrint'));
const DrawingTracker = lazy(() => import('./pages/DrawingTracker'));
const DrawingDetail = lazy(() => import('./pages/DrawingDetail'));
const DrawingRegisterPrint = lazy(() => import('./pages/DrawingRegisterPrint'));
const DrawingRevisionView = lazy(() => import('./pages/DrawingRevisionView'));
const WorkOrderPrint = lazy(() => import('./pages/WorkOrderPrint'));
const LabourRateMasterPrint = lazy(() => import('./pages/LabourRateMasterPrint'));
const WageRegisterPrint = lazy(() => import('./pages/WageRegisterPrint'));
const BillPrint = lazy(() => import('./pages/BillPrint'));
const SiteSlipPrint = lazy(() => import('./pages/SiteSlipPrint'));
const QuotationPrint = lazy(() => import('./pages/QuotationPrint'));
const UserManagement = lazy(() => import('./pages/admin/UserManagement'));
const RolesPermissions = lazy(() => import('./pages/admin/RolesPermissions'));
const DatabaseBackups = lazy(() => import('./pages/admin/DatabaseBackups'));
const Performance = lazy(() => import('./pages/admin/Performance'));
const AuditLog = lazy(() => import('./pages/admin/AuditLog'));
const WordCount = lazy(() => import('./pages/admin/WordCount'));
const Locations = lazy(() => import('./pages/admin/Locations'));
const CollectionsMD = lazy(() => import('./pages/admin/CollectionsMD'));
const AISettings = lazy(() => import('./pages/AISettings'));
const SubContractors = lazy(() => import('./pages/SubContractors'));
const SubconHiring = lazy(() => import('./pages/SubconHiring'));
const ProcurementSchedule = lazy(() => import('./pages/ProcurementSchedule'));
const CRMFunnel = lazy(() => import('./pages/CRMFunnel'));
const SotynLeads = lazy(() => import('./pages/SotynLeads'));
const ChequeFMS = lazy(() => import('./pages/ChequeFMS'));
const EmailSettings = lazy(() => import('./pages/EmailSettings'));
const EmailTriggers = lazy(() => import('./pages/EmailTriggers'));
const DashboardCMD = lazy(() => import('./pages/DashboardCMD'));
const DashboardCMDToc = lazy(() => import('./pages/DashboardCMDToc'));
const DashboardWarRoom = lazy(() => import('./pages/DashboardWarRoom'));
const FireNoc = lazy(() => import('./pages/FireNoc'));
const RentalTools = lazy(() => import('./pages/RentalTools'));
const Influencers = lazy(() => import('./pages/Influencers'));
const CRMKitting = lazy(() => import('./pages/CRMKitting'));
const HRSystem = lazy(() => import('./pages/HRSystem'));
const OfferLetterPrint = lazy(() => import('./pages/OfferLetterPrint'));
const NDAPrint = lazy(() => import('./pages/NDAPrint'));
const EmploymentAgreementPrint = lazy(() => import('./pages/EmploymentAgreementPrint'));
const PublicOffer = lazy(() => import('./pages/PublicOffer'));
const PublicEmployeeFill = lazy(() => import('./pages/PublicEmployeeFill'));
const Induction = lazy(() => import('./pages/Induction'));
const Training = lazy(() => import('./pages/Training'));

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (user?.must_change_password) return <InitialPasswordChange />;
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
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-lg text-gray-400">Loading…</div>}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
        {/* Print routes — auth-gated but rendered WITHOUT the sidebar / header
          chrome so the document fills the viewport cleanly. */}
        {/* Online file viewer (mam 2026-08-27) — Excel/Word/CSV open in a tab
          instead of downloading; Layout's link interceptor routes here. */}
        <Route path="/file-view" element={<ProtectedRoute><FileViewer /></ProtectedRoute>} />
        {/* SOP-05.2 rate-enquiry sheet — print page, no app chrome. */}
        <Route path="/rate-enquiry/:id/print" element={<ProtectedRoute><RateEnquiryPrint /></ProtectedRoute>} />
        <Route path="/vendor-po/:id/print" element={<ProtectedRoute><VendorPOPrint /></ProtectedRoute>} />
        <Route path="/debit-note/:id/print" element={<ProtectedRoute><DebitNotePrint /></ProtectedRoute>} />
        <Route path="/payment-advice/print" element={<ProtectedRoute><PaymentAdvicePrint /></ProtectedRoute>} />
        {/* Mam (2026-05-22): "delivery note make here automatically and
          show pdf here according to po" — print-on-demand DN auto-
          filled from the same Vendor PO data.  No delivery_notes
          row needed. */}
        <Route path="/vendor-po/:id/delivery-note" element={<ProtectedRoute><DeliveryNotePrint /></ProtectedRoute>} />
        <Route path="/rental-po/:id/print" element={<ProtectedRoute><RentalPOPrint /></ProtectedRoute>} />
        <Route path="/indent/:id/print" element={<ProtectedRoute><IndentPrint /></ProtectedRoute>} />
        {/* Delivery Bill working per indent, for audit (mam 2026-09-11). */}
        <Route path="/indent/:id/delivery-bill" element={<ProtectedRoute><DeliveryBillPrint /></ProtectedRoute>} />
        <Route path="/drawing-register-print" element={<ProtectedRoute><DrawingRegisterPrint /></ProtectedRoute>} />
        {/* Full-page revision viewer — outside the Layout shell so the drawing
          gets the whole window when opened in its own tab. */}
        <Route path="/drawing-view/:id" element={<ProtectedRoute><DrawingRevisionView /></ProtectedRoute>} />
        <Route path="/work-order-print/:id" element={<ProtectedRoute><WorkOrderPrint /></ProtectedRoute>} />
        <Route path="/labour-rate-master-print" element={<ProtectedRoute><LabourRateMasterPrint /></ProtectedRoute>} />
        <Route path="/wage-register-print" element={<ProtectedRoute><WageRegisterPrint /></ProtectedRoute>} />
        <Route path="/bill-print/:id" element={<ProtectedRoute><BillPrint /></ProtectedRoute>} />
        {/* SPOS site-store GRN slips (mam 2026-07-31): printable Issue/Return slip */}
        <Route path="/site-slip/:id/print" element={<ProtectedRoute><SiteSlipPrint /></ProtectedRoute>} />
        <Route path="/quotation/:indentId/print" element={<ProtectedRoute><QuotationPrint /></ProtectedRoute>} />
        <Route path="/po-foc/:id/print" element={<ProtectedRoute><PoFocPrint /></ProtectedRoute>} />
        <Route path="/payroll/slip/:employee_id" element={<ProtectedRoute><SalarySlipPrint /></ProtectedRoute>} />
        <Route path="/hr/candidates/:id/offer-letter" element={<ProtectedRoute><OfferLetterPrint /></ProtectedRoute>} />
        <Route path="/hr/candidates/:id/nda" element={<ProtectedRoute><NDAPrint /></ProtectedRoute>} />
        <Route path="/hr/candidates/:id/employment-agreement" element={<ProtectedRoute><EmploymentAgreementPrint /></ProtectedRoute>} />
        {/* Mam (2026-05-22 Batch D): public offer-accept page — NO
          ProtectedRoute wrapper.  Candidate uses the token in the
          URL as the identity; no SEPL login required. */}
        <Route path="/offer/:token" element={<PublicOffer />} />
        {/* Mam (2026-08-17): public employee self-fill form — employee fills
          their own details via a shared token link, no login. */}
        <Route path="/employee-fill/:token" element={<PublicEmployeeFill />} />
        <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
          <Route index element={<Dashboard />} />
          {/* TOC v3 role dashboards — admin-only for now, dark-navy CMD
            style.  COO / Sales / Finance variants will land as their
            HTML specs come in from MD. */}
          <Route path="dashboard/cmd" element={<AdminRoute><DashboardCMD /></AdminRoute>} />
          <Route path="dashboard/cmd-toc" element={<AdminRoute><DashboardCMDToc /></AdminRoute>} />
          <Route path="dashboard/war-room" element={<AdminRoute><DashboardWarRoom /></AdminRoute>} />
          <Route path="fire-noc" element={<ModuleRoute module="fire_noc"><FireNoc /></ModuleRoute>} />
          <Route path="drawing-tracker" element={<ModuleRoute module="drawing_tracker"><DrawingTracker /></ModuleRoute>} />
          <Route path="drawing-tracker/:id" element={<ModuleRoute module="drawing_tracker"><DrawingDetail /></ModuleRoute>} />
          <Route path="rental-tools" element={<ModuleRoute module="rental_tools"><RentalTools /></ModuleRoute>} />
          <Route path="influencers" element={<ModuleRoute module="influencers"><Influencers /></ModuleRoute>} />
          <Route path="crm-kitting" element={<ModuleRoute module="crm_kitting"><CRMKitting /></ModuleRoute>} />
          <Route path="hr-system" element={<ModuleRoute module="hr_system"><HRSystem /></ModuleRoute>} />
          {/* Mam (2026-05-22 Batch E): Induction + Training are open
            to ALL employees — no module gate so even read-only users
            can complete their training. */}
          <Route path="induction" element={<Induction />} />
          <Route path="training" element={<Training />} />
          {/* 4 Critical Systems */}
          {/* Cash Flow page deleted (mam 2026-09-03) — /cashflow now lands on the
            Cash Flow Tracker, which is where the money question is answered.
            The cash_flow_daily ledger tables are UNTOUCHED: Bank
            reconciliation, Collections and Business Book still write to them. */}
          <Route path="cashflow" element={<Navigate to="/cash-flow-tracker" replace />} />
          <Route path="bank" element={<ModuleRoute module="cashflow"><Bank /></ModuleRoute>} />
          <Route path="payment-required" element={<ModuleRoute module="payment_required"><PaymentRequired /></ModuleRoute>} />
          <Route path="attendance" element={<ModuleRoute module="attendance"><Attendance /></ModuleRoute>} />
          <Route path="collections" element={<ModuleRoute module="collections"><Collections /></ModuleRoute>} />
          {/* AR/AP Tracker → Cash Flow Tracker (mam 2026-09-03). New canonical
            path; the old one redirects so War Room deep links and anyone's
            bookmarks keep working. */}
          <Route path="cash-flow-tracker" element={<ModuleRoute module="ar_ap_tracker"><ArApTracker /></ModuleRoute>} />
          <Route path="ar-ap-tracker" element={<Navigate to="/cash-flow-tracker" replace />} />
          {/* WhatsApp is open to all signed-in users — access is by group
            membership, not the site_chat module permission (mam 2026-06-19).
            ModuleGate is the global on/off switch, NOT a permission check — it's
            separate from ModuleRoute precisely because these two have no view
            permission to check. */}
          <Route path="site-chat" element={<ModuleGate module="site_chat"><SiteChat /></ModuleGate>} />
          {/* SOTYN Flow — task boards. Full-width; access by board membership
            (super-viewers see all), so no ModuleRoute permission gate — only the
            same global ModuleGate switch as site-chat. */}
          <Route path="sotyn-flow" element={<ModuleGate module="sotyn_flow"><SotynFlow /></ModuleGate>} />
          <Route path="sotyn-flow/:boardId" element={<ModuleGate module="sotyn_flow"><SotynFlow /></ModuleGate>} />
          <Route path="indent-fms" element={<ModuleRoute module="indent_fms"><IndentFMS /></ModuleRoute>} />
          <Route path="dpr" element={<ModuleRoute module="dpr"><DPR /></ModuleRoute>} />
          {/* Mam (2026-06-01) — Project Execution & Billing pipeline. */}
          <Route path="indent-labour-payment" element={<ModuleRoute module="indent_labour_payment"><IndentLabourPayment /></ModuleRoute>} />
          <Route path="labour-management" element={<ModuleRoute module="labour_quotation"><LabourManagementSystem /></ModuleRoute>} />
          <Route path="labour-master" element={<ModuleRoute module="labour_master"><LabourMaster /></ModuleRoute>} />
          <Route path="bill-verification" element={<ModuleRoute module="bill_verification"><BillVerification /></ModuleRoute>} />
          <Route path="delegations" element={<ModuleRoute module="delegations"><Delegation /></ModuleRoute>} />
          <Route path="pms-tasks" element={<ModuleRoute module="pms_tasks"><PMSTasks /></ModuleRoute>} />
          {/* Other Modules */}
          <Route path="leads" element={<ModuleRoute module="leads"><Leads /></ModuleRoute>} />
          <Route path="quotations" element={<ModuleRoute module="quotations"><Quotations /></ModuleRoute>} />
          <Route path="estimator" element={<ModuleRoute module="ai_quotation"><Estimator /></ModuleRoute>} />
          <Route path="solar-funnel" element={<ModuleRoute module="solar_quotation"><SolarFunnel /></ModuleRoute>} />
          <Route path="solar-quotation" element={<ModuleRoute module="solar_quotation"><SolarQuotation /></ModuleRoute>} />
          <Route path="solar-quotations/:id/design-report" element={<ModuleRoute module="solar_quotation"><SolarDesignReport /></ModuleRoute>} />
          <Route path="solar-projects" element={<ModuleRoute module="solar_quotation"><SolarProjects /></ModuleRoute>} />
          <Route path="solar-projects/:id/net-metering-print" element={<ModuleRoute module="solar_quotation"><SolarNetMeteringPrint /></ModuleRoute>} />
          <Route path="solar-site-design" element={<ModuleRoute module="solar_quotation"><SolarSiteDesign /></ModuleRoute>} />
          <Route path="solar-material-master" element={<ModuleRoute module="solar_quotation"><SolarMaterialMaster /></ModuleRoute>} />
          <Route path="solar-labour-master" element={<ModuleRoute module="solar_quotation"><SolarLabourMaster /></ModuleRoute>} />
          <Route path="solar-rate-master" element={<ModuleRoute module="solar_quotation"><SolarRateMaster /></ModuleRoute>} />
          <Route path="po-foc-stripped" element={<ModuleRoute module="quotations"><PoFocStripped /></ModuleRoute>} />
          <Route path="labour-rate" element={<ModuleRoute module="labour_rates"><LabourRate /></ModuleRoute>} />
          <Route path="business-book" element={<ModuleRoute module="business_book"><BusinessBook /></ModuleRoute>} />
          <Route path="item-master" element={<ModuleRoute module="item_master"><ItemMaster /></ModuleRoute>} />
          <Route path="orders" element={<ModuleRoute module="orders"><Orders /></ModuleRoute>} />
          <Route path="dispatch-receiving" element={<ModuleRoute module="procurement"><DispatchReceiving /></ModuleRoute>} />
          <Route path="vendors" element={<ModuleRoute module="vendors"><Vendors /></ModuleRoute>} />
          <Route path="customers" element={<ModuleRoute module="customers"><Customers /></ModuleRoute>} />
          <Route path="procurement" element={<ModuleRoute module="procurement"><Procurement /></ModuleRoute>} />
          <Route path="sales-bill-receive" element={<ModuleRoute module="sales_bill_receive"><SalesBillReceive /></ModuleRoute>} />
          {/* SOP-07 flow board (mam 2026-08-28) — pipeline dashboard for
            Indent-to-Material, in mam's reference design. */}
          <Route path="procurement-board" element={<ModuleRoute module="procurement"><ProcurementBoard /></ModuleRoute>} />
          {/* SOP-05 rates board (mam 2026-08-28) — vendor & rates BEFORE indent. */}
          <Route path="rates-board" element={<ModuleRoute module="procurement"><RatesBoard /></ModuleRoute>} />
          {/* SOP-05 item-wise register (mam 2026-08-31) */}
          <Route path="rates-items" element={<ModuleRoute module="procurement"><RatesItems /></ModuleRoute>} />
          <Route path="price-required" element={<PriceRequired />} />
          <Route path="inventory" element={<ModuleRoute module="inventory"><Inventory /></ModuleRoute>} />
          <Route path="help-tickets" element={<HelpTickets />} />
          {/* ERP Management — System Flow & Implementation Control (2026-09) */}
          <Route path="system-flow" element={<ModuleRoute module="system_flow"><SystemFlow /></ModuleRoute>} />
          <Route path="system-requirements" element={<ModuleGate module="system_requirements"><SystemRequirements /></ModuleGate>} />
          <Route path="system-requirements/:id" element={<ModuleGate module="system_requirements"><SystemRequirementWorkspace /></ModuleGate>} />
          <Route path="installation" element={<ModuleRoute module="installation"><SalesBilling /></ModuleRoute>} />
          <Route path="billing" element={<ModuleRoute module="billing"><Billing /></ModuleRoute>} />
          <Route path="complaints" element={<ModuleRoute module="complaints"><Complaints /></ModuleRoute>} />
          <Route path="snags" element={<ModuleRoute module="snags"><Snags /></ModuleRoute>} />
          <Route path="tally-bills" element={<ModuleRoute module="tally_bills"><TallyBills /></ModuleRoute>} />
          <Route path="client-snag" element={<ModuleRoute module="client_snag"><ClientSnag /></ModuleRoute>} />
          <Route path="company-assets" element={<ModuleRoute module="company_assets"><CompanyAssets /></ModuleRoute>} />
          <Route path="hr" element={<ModuleRoute module="hr"><HR /></ModuleRoute>} />
          <Route path="payroll" element={<ModuleRoute module="payroll"><Payroll /></ModuleRoute>} />
          <Route path="scorecard" element={<ModuleRoute module="scoring"><Scorecard /></ModuleRoute>} />
          <Route path="champions" element={<ModuleRoute module="gamification"><Champions /></ModuleRoute>} />
          <Route path="module-owners" element={<ModuleRoute module="scoring"><ModuleOwners /></ModuleRoute>} />
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
          <Route path="admin/performance" element={<AdminRoute><Performance /></AdminRoute>} />
          <Route path="admin/audit" element={<AdminRoute><AuditLog /></AdminRoute>} />
          <Route path="admin/word-count" element={<AdminRoute><WordCount /></AdminRoute>} />
          <Route path="admin/locations" element={<AdminRoute><Locations /></AdminRoute>} />
          <Route path="admin/collections-md" element={<AdminRoute><CollectionsMD /></AdminRoute>} />
          <Route path="admin/ai-settings" element={<AdminRoute><AISettings /></AdminRoute>} />
          <Route path="admin/email-settings" element={<AdminRoute><EmailSettings /></AdminRoute>} />
          <Route path="admin/email-triggers" element={<AdminRoute><EmailTriggers /></AdminRoute>} />
          <Route path="sub-contractors" element={<ModuleRoute module="sub_contractors"><SubContractors /></ModuleRoute>} />
          <Route path="subcon-hiring" element={<ModuleRoute module="subcon_hiring"><SubconHiring /></ModuleRoute>} />
          <Route path="procurement-schedule" element={<ModuleRoute module="procurement_schedule"><ProcurementSchedule /></ModuleRoute>} />
          <Route path="crm-funnel" element={<ModuleRoute module="crm_funnel"><CRMFunnel /></ModuleRoute>} />
          <Route path="sotyn-leads" element={<ModuleRoute module="sotyn_leads"><SotynLeads /></ModuleRoute>} />
          <Route path="cheques" element={<ModuleRoute module="cheques"><ChequeFMS /></ModuleRoute>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
