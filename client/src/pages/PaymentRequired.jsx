import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiSearch, FiFilter, FiEye, FiCheck, FiX, FiClock, FiCheckCircle, FiXCircle, FiUpload, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { LuIndianRupee } from 'react-icons/lu';

const CATEGORIES = ['TA/DA', 'Purchase', 'Labour', 'Transport', 'Salary', 'Compliance'];
const STATUSES = ['pending', 'step1_approved', 'accounts_approved', 'dues_checked', 'velocity_checked', 'final_approved', 'rejected'];
const STATUS_LABELS = { pending: 'Pending', step1_approved: 'Step 1 Approved', accounts_approved: 'Accounts Approved', dues_checked: 'Dues Checked', velocity_checked: 'Velocity Checked', final_approved: 'Final Approved', rejected: 'Rejected' };
const STEPS = [
  { step: 1, name: 'Category Approval' },
  { step: 2, name: 'Accountant Approval' },
  { step: 3, name: 'Velocity Check (Auto)' },
  { step: 4, name: 'Billing Engineer' },
  { step: 5, name: 'Payment Release' },
];
const TADA_STEPS = [
  { step: 1, name: 'HR Approval' },
  { step: 2, name: 'Accountant Approval' },
  { step: 5, name: 'Payment Release' },
];

// Default 'Required By Date' is today + 5 days — immediate payments can't be
// processed so we set a realistic lead time.
const defaultRequiredByDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
};

const emptyForm = {
  employee_name: '', site_id: '', site_name: '', department: '', contact_number: '',
  category: '', amount: 0, purpose: '', payment_mode: 'Bank', required_by_date: defaultRequiredByDate(),
  travel_from_to: '', travel_dates: '', mode_of_travel: '', stay_details: '',
  ticket_upload: '', start_km: 0, end_km: 0, km_photo: '',
  indent_number: '', item_description: '', vendor_name: '', quotation_link: '',
  labour_type: '', number_of_workers: 0, work_duration: '', site_engineer_name: '',
  vehicle_type: '', from_to_location: '', material_description: '', driver_vendor_name: '',
};

export default function PaymentRequired() {
  const { canCreate, canApprove, canDelete, user } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [requests, setRequests] = useState([]);
  const [stats, setStats] = useState(null);
  const [sites, setSites] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [modal, setModal] = useState(null);
  const [viewData, setViewData] = useState(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', category: '' });
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    api.get(`/payment-required?${params}`).then(r => setRequests(r.data)).catch(() => {});
    api.get('/payment-required/stats').then(r => setStats(r.data)).catch(() => {});
  }, [search, filters]);

  useEffect(() => {
    load();
    // ?all=1 → any employee raising a payment request can pick from ALL
    // sites (not just ones they're assigned to as a site engineer). Matches
    // mam's ask on 2026-04-23.
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => {});
    api.get('/hr/employees').then(r => setEmployees(r.data)).catch(() => {});
  }, [load]);

  // Mandatory-proof validation per category + mode (mam: 'if proof
  // mandatory then why missing'). Block submission until every required
  // receipt is attached — same rules as the approval-modal audit view.
  const requiredProofsMissing = (f) => {
    const missing = [];
    if (f.category === 'TA/DA') {
      if (['Bus','Train','Flight'].includes(f.mode_of_travel) && !f.ticket_upload) {
        missing.push('Travel Ticket');
      }
      if (['Car','Bike'].includes(f.mode_of_travel)) {
        if (!f.km_photo) missing.push('Start KM Photo');
        if (!f.end_km_photo) missing.push('End KM Photo');
      }
    }
    if (f.category === 'Purchase' && !f.quotation_link) {
      missing.push('Quotation / Purchase Order');
    }
    return missing;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const missing = requiredProofsMissing(form);
    if (missing.length > 0) {
      return toast.error(`Upload required proof${missing.length > 1 ? 's' : ''} before submitting: ${missing.join(', ')}`, { duration: 7000 });
    }
    try {
      const res = await api.post('/payment-required', form);
      toast.success(`Request ${res.data.request_no} created`);
      setModal(null); setForm({ ...emptyForm }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const [approvalRemarks, setApprovalRemarks] = useState('');

  const handleApprove = async (id) => {
    if (!approvalRemarks || approvalRemarks.trim().length < 5) {
      return toast.error('Please enter approval reason (minimum 5 characters)');
    }
    try {
      const res = await api.put(`/payment-required/${id}/approve`, { remarks: approvalRemarks });
      toast.success(res.data.message); setApprovalRemarks(''); load(); setModal(null); setViewData(null);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const handleReject = async (id) => {
    if (!approvalRemarks || approvalRemarks.trim().length < 5) {
      return toast.error('Please enter rejection reason (minimum 5 characters)');
    }
    try {
      const res = await api.put(`/payment-required/${id}/reject`, { remarks: approvalRemarks });
      toast.success(res.data.message); setApprovalRemarks(''); load(); setModal(null); setViewData(null);
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const viewRequest = async (id) => {
    const { data } = await api.get(`/payment-required/${id}`);
    setViewData(data); setModal('view');
  };

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><LuIndianRupee className="text-orange-600" /> Payment Required</h1>
          <p className="text-sm text-gray-500">Request payments with multi-level approval workflow</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('payment-requests',
            ['Req No','Employee','Site','Category','Amount','Purpose','Step','Status','Required By','Created'],
            requests.map(r => [r.request_no, r.employee_name, r.site_name, r.category, r.amount, r.purpose, r.current_step, r.status, r.required_by_date, r.created_at]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload size={16} /> Export Excel</button>
          {canCreate('payment_required') && (
            <button onClick={() => { setForm({ ...emptyForm, employee_name: user?.name || '', required_by_date: defaultRequiredByDate() }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={16} /> New Request</button>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {['dashboard', 'all', 'pending', 'approved', 'rejected'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'} text-sm`}>{t === 'all' ? 'All Requests' : t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {/* Dashboard */}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="card p-4 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Requests</p><p className="text-2xl font-bold">{stats.total}</p></div>
            <div className="card p-4 border-l-4 border-orange-500"><p className="text-xs text-gray-500">Total Amount</p><p className="text-2xl font-bold text-orange-600">{fmt(stats.totalAmount)}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Pending</p><p className="text-2xl font-bold text-amber-600">{stats.pending}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-emerald-600">{stats.approved}</p></div>
            <div className="card p-4 border-l-4 border-red-500"><p className="text-xs text-gray-500">Rejected</p><p className="text-2xl font-bold text-red-600">{stats.rejected}</p></div>
          </div>

          {/* Category breakdown */}
          {stats.byCategory?.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {stats.byCategory.map(c => (
                <div key={c.category} className="card p-3"><p className="text-xs text-gray-500">{c.category}</p><p className="font-bold">{c.count} requests</p><p className="text-sm text-gray-600">{fmt(c.amount)}</p></div>
              ))}
            </div>
          )}

          {/* Pending approvals */}
          {stats.pendingApprovals?.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <div className="p-4 border-b bg-amber-50"><h4 className="font-semibold text-amber-800">Pending Approvals</h4></div>
              <table><thead><tr><th>Req No</th><th>Employee</th><th>Category</th><th>Amount</th><th>Step</th><th>Actions</th></tr></thead>
                <tbody>{stats.pendingApprovals.map(r => (
                  <tr key={r.id}>
                    <td className="font-bold text-red-600 cursor-pointer" onClick={() => viewRequest(r.id)}>{r.request_no}</td>
                    <td>{r.employee_name}</td><td><span className="badge badge-blue">{r.category}</span></td>
                    <td className="font-semibold">{fmt(r.amount)}</td>
                    <td><span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">Step {r.current_step}/2</span></td>
                    <td><div className="flex gap-1">
                      <button onClick={() => viewRequest(r.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                      {canApprove('payment_required') && <>
                        <button onClick={() => viewRequest(r.id)} className="p-1 hover:bg-amber-50 rounded text-amber-600 font-bold text-xs">Review</button>
                      </>}
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Request List */}
      {tab !== 'dashboard' && (
        <>
          <div className="flex gap-3">
            <div className="relative flex-1"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" placeholder="Search by employee, request no, purpose, site..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <select className="select w-40" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}><option value="">All Categories</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
            <select className="select w-40" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}><option value="">All Status</option>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select>
          </div>

          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Req No</th><th>Employee</th><th>Site</th><th>Category</th><th>Amount</th><th>Purpose</th><th>Step</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
              {requests.filter(r => {
                if (tab === 'pending') return !['final_approved', 'rejected'].includes(r.status);
                if (tab === 'approved') return r.status === 'final_approved';
                if (tab === 'rejected') return r.status === 'rejected';
                return true;
              }).map(r => (
                <tr key={r.id}>
                  <td className="font-bold text-red-600 cursor-pointer" onClick={() => viewRequest(r.id)}>{r.request_no}</td>
                  <td className="font-medium">{r.employee_name}</td>
                  <td className="text-sm">{r.site_display || r.site_name || '-'}</td>
                  <td><span className={`badge ${r.category === 'TA/DA' ? 'badge-purple' : r.category === 'Purchase' ? 'badge-blue' : r.category === 'Labour' ? 'badge-green' : 'badge-gray'}`}>{r.category}</span></td>
                  <td className="font-semibold">{fmt(r.amount)}</td>
                  <td className="text-sm max-w-[280px]">
                    {/* Show full purpose text, wrap to multiple lines for
                        long entries. Hover shows it again as a tooltip
                        for screen-reader / extra-long cases. Below the
                        purpose we also show the category-specific extra
                        detail (item_description for Purchase, stay_details
                        for TA/DA, etc.) so the row carries everything mam
                        typed without having to open the request. */}
                    <div className="whitespace-normal break-words leading-snug" title={r.purpose}>{r.purpose}</div>
                    {(r.item_description || r.material_description || r.stay_details || r.travel_from_to) && (
                      <div className="text-[10px] text-gray-500 mt-0.5 leading-tight whitespace-normal break-words">
                        {r.item_description && <span>📦 {r.item_description}</span>}
                        {r.material_description && <span>🚚 {r.material_description}</span>}
                        {r.stay_details && <span>🏨 {r.stay_details}</span>}
                        {r.travel_from_to && <span>✈️ {r.travel_from_to}</span>}
                      </div>
                    )}
                  </td>
                  <td><span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{r.current_step}/5</span></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-xs">{r.created_at?.split('T')[0]}</td>
                  <td><div className="flex gap-1">
                    <button onClick={() => viewRequest(r.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><FiEye size={15} /></button>
                    {canApprove('payment_required') && r.status !== 'final_approved' && r.status !== 'rejected' && <>
                      <button onClick={() => viewRequest(r.id)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded font-bold text-xs" title="Review & Approve/Reject">Review</button>
                    </>}
                    {canDelete('payment_required') && <button onClick={async () => {
                      if (!confirm(`Delete request "${r.request_no}"?`)) return;
                      try { await api.delete(`/payment-required/${r.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
              {requests.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No requests found</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* View Request Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(null); setViewData(null); }} title={`${viewData?.request_no || ''} - ${viewData?.employee_name || ''}`} wide>
        {viewData && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between bg-gradient-to-r from-orange-50 to-amber-50 p-4 rounded-lg">
              <div><h3 className="text-lg font-bold text-orange-800">{viewData.request_no}</h3><p className="text-sm text-orange-600">{viewData.category} - {viewData.purpose}</p></div>
              <div className="text-right"><p className="text-2xl font-bold text-orange-700">{fmt(viewData.amount)}</p><StatusBadge status={viewData.status} /></div>
            </div>

            {/* Approval Progress */}
            <div className="flex gap-1">
              {(viewData.workflow || (viewData.category === 'TA/DA' ? TADA_STEPS : STEPS)).map(s => {
                const approval = viewData.approvals?.find(a => a.step === s.step);
                const isCurrent = viewData.current_step === s.step && viewData.status !== 'final_approved' && viewData.status !== 'rejected';
                return (
                  <div key={s.step} className={`flex-1 text-center p-2 rounded text-[11px] font-medium ${approval?.action === 'approved' ? 'bg-emerald-100 text-emerald-700' : approval?.action === 'rejected' ? 'bg-red-100 text-red-700' : isCurrent ? 'bg-amber-100 text-amber-700 ring-2 ring-amber-400' : 'bg-gray-100 text-gray-400'}`}>
                    <div className="font-bold">Step {s.step}</div>
                    <div className="text-[10px]">{s.name}</div>
                    {approval && <div className="text-[9px] mt-1">{approval.approved_by_name}</div>}
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><span className="text-gray-400">Employee:</span> <span className="font-medium">{viewData.employee_name}</span></div>
              <div><span className="text-gray-400">Site:</span> <span className="font-medium">{viewData.site_display || viewData.site_name || '-'}</span></div>
              <div><span className="text-gray-400">Department:</span> <span className="font-medium">{viewData.department || '-'}</span></div>
              <div><span className="text-gray-400">Contact:</span> <span className="font-medium">{viewData.contact_number || '-'}</span></div>
              <div><span className="text-gray-400">Payment Mode:</span> <span className="font-medium">{viewData.payment_mode}</span></div>
              <div><span className="text-gray-400">Required By:</span> <span className="font-medium">{viewData.required_by_date || '-'}</span></div>
            </div>

            {/* Category fields */}
            {viewData.category === 'TA/DA' && (
              <div className="border rounded p-3 bg-purple-50"><h5 className="font-semibold text-sm text-purple-700 mb-2">TA/DA Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Travel:</span> {viewData.travel_from_to}</div>
                  <div><span className="text-gray-400">Dates:</span> {viewData.travel_dates}</div>
                  <div><span className="text-gray-400">Mode:</span> {viewData.mode_of_travel}</div>
                  <div><span className="text-gray-400">Stay:</span> {viewData.stay_details}</div>
                </div></div>
            )}
            {viewData.category === 'Purchase' && (
              <div className="border rounded p-3 bg-red-50"><h5 className="font-semibold text-sm text-red-700 mb-2">Purchase Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Indent No:</span> {viewData.indent_number}</div>
                  <div><span className="text-gray-400">Vendor:</span> {viewData.vendor_name}</div>
                  <div className="col-span-2"><span className="text-gray-400">Items:</span> {viewData.item_description}</div>
                </div></div>
            )}
            {viewData.category === 'Labour' && (
              <div className="border rounded p-3 bg-green-50"><h5 className="font-semibold text-sm text-green-700 mb-2">Labour Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Type:</span> {viewData.labour_type}</div>
                  <div><span className="text-gray-400">Workers:</span> {viewData.number_of_workers}</div>
                  <div><span className="text-gray-400">Duration:</span> {viewData.work_duration}</div>
                  <div><span className="text-gray-400">Site Engineer:</span> {viewData.site_engineer_name}</div>
                </div></div>
            )}
            {viewData.category === 'Transport' && (
              <div className="border rounded p-3 bg-gray-50"><h5 className="font-semibold text-sm text-gray-700 mb-2">Transport Details</h5>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-400">Vehicle:</span> {viewData.vehicle_type}</div>
                  <div><span className="text-gray-400">From-To:</span> {viewData.from_to_location}</div>
                  <div><span className="text-gray-400">Material:</span> {viewData.material_description}</div>
                  <div><span className="text-gray-400">Driver/Vendor:</span> {viewData.driver_vendor_name}</div>
                </div></div>
            )}

            {viewData.rejection_remarks && <div className="bg-red-50 p-3 rounded text-sm"><strong className="text-red-700">Rejected:</strong> {viewData.rejection_remarks}</div>}

            {/* Proofs / Receipts — shown prominently so approver can verify
                tickets / KM photos / quotations / attachments before clicking
                Approve or Reject. Images show as thumbnails, PDFs/docs show
                as a 📄 card. Click any tile to open full-size in a new tab.
                If a proof is missing, an "Upload now" button appears so the
                approver / creator can attach it before deciding. */}
            {(() => {
              // Build a list of expected proof slots based on category.
              // Each slot has: field (DB column), label, tint, and required flag.
              const slots = [];
              if (viewData.category === 'TA/DA') {
                if (['Bus','Train','Flight'].includes(viewData.mode_of_travel)) {
                  slots.push({ field: 'ticket_upload', label: 'Travel Ticket', tint: 'purple', required: true });
                }
                if (['Car','Bike'].includes(viewData.mode_of_travel)) {
                  slots.push({ field: 'km_photo', label: `Start KM Photo${viewData.start_km ? ` (${viewData.start_km} km)` : ''}`, tint: 'orange', required: true });
                  slots.push({ field: 'end_km_photo', label: `End KM Photo${viewData.end_km ? ` (${viewData.end_km} km)` : ''}`, tint: 'emerald', required: true });
                }
              }
              if (viewData.category === 'Purchase') {
                slots.push({ field: 'quotation_link', label: 'Quotation / Purchase Order', tint: 'red', required: true });
              }
              // Always allow a generic attachment slot at the end
              slots.push({ field: 'attachment_link', label: 'Other Attachment', tint: 'blue', required: false });

              const isImg = (url) => /\.(jpg|jpeg|png|webp|gif|bmp|heic)(\?|$)/i.test(url);
              const tintMap = {
                purple: 'border-purple-300 bg-purple-50',
                orange: 'border-orange-300 bg-orange-50',
                emerald: 'border-emerald-300 bg-emerald-50',
                red: 'border-red-300 bg-red-50',
                blue: 'border-blue-300 bg-blue-50',
              };

              const isFinalised = viewData.status === 'final_approved' || viewData.status === 'rejected';

              // Upload helper — kept available so legacy / in-flight
              // requests that landed before mandatory-proof validation
              // can still attach receipts. Backend PATCH endpoint logs
              // updated_by + updated_at for audit.
              const uploadProof = async (field, file) => {
                if (!file) return;
                try {
                  const fd = new FormData();
                  fd.append('file', file);
                  const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                  await api.patch(`/payment-required/${viewData.id}/proof`, { field, url: up.data.url });
                  toast.success('Proof attached');
                  const { data } = await api.get(`/payment-required/${viewData.id}`);
                  setViewData(data);
                } catch (err) {
                  toast.error(err.response?.data?.error || 'Upload failed');
                }
              };

              const filledCount = slots.filter(s => viewData[s.field]).length;

              return (
                <div className="border-2 border-blue-300 rounded-lg p-3 bg-blue-50/40">
                  <h5 className="font-bold text-sm text-blue-800 mb-2 flex items-center gap-1">
                    📎 Proofs / Receipts {filledCount > 0 && <span className="text-blue-600">({filledCount})</span>}
                  </h5>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {slots.map((s, i) => {
                      const url = viewData[s.field];
                      if (url) {
                        // Filled — show as clickable thumbnail
                        return (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className={`block rounded-lg border ${tintMap[s.tint]} overflow-hidden hover:shadow-md hover:scale-[1.02] transition-all`}
                            title={`Click to open ${s.label}`}
                          >
                            {isImg(url) ? (
                              <img src={url} alt={s.label} className="w-full h-32 object-cover bg-white" />
                            ) : (
                              <div className="h-32 flex flex-col items-center justify-center bg-white">
                                <span className="text-4xl">📄</span>
                                <span className="text-[10px] text-gray-500 mt-1">PDF / Document</span>
                              </div>
                            )}
                            <div className="px-2 py-1.5 bg-white border-t">
                              <div className="text-xs font-semibold truncate">{s.label}</div>
                              <div className="text-[10px] text-blue-600 underline">Click to view full size</div>
                            </div>
                          </a>
                        );
                      }
                      // Empty slot — show upload tile (only if not finalised).
                      // Required ones get a red "MISSING" treatment; optional
                      // ones a softer gray "Optional" tile.
                      if (isFinalised) return null;
                      return (
                        <label
                          key={i}
                          className={`block rounded-lg border-2 border-dashed ${s.required ? 'border-red-300 bg-red-50/50' : 'border-gray-300 bg-gray-50'} overflow-hidden cursor-pointer hover:shadow-md transition-all`}
                        >
                          <div className="h-32 flex flex-col items-center justify-center text-center px-2">
                            <span className="text-3xl">{s.required ? '⚠️' : '➕'}</span>
                            <span className="text-[11px] font-bold mt-1 text-gray-700">{s.required ? 'MISSING' : 'Optional'}</span>
                            <span className="text-[10px] text-gray-500 mt-0.5">Click to upload</span>
                          </div>
                          <div className="px-2 py-1.5 bg-white border-t">
                            <div className="text-xs font-semibold truncate">{s.label}</div>
                            <div className="text-[10px] text-blue-600 underline">Choose file…</div>
                          </div>
                          <input
                            type="file"
                            accept="image/*,.pdf"
                            className="hidden"
                            onChange={e => uploadProof(s.field, e.target.files?.[0])}
                          />
                        </label>
                      );
                    })}
                  </div>
                  {filledCount === 0 && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-2">
                      ⚠️ No proofs uploaded with this request. New requests are blocked at filing time if proofs are missing — for legacy requests like this one, click any tile above to attach the receipt before approving.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Approval trail */}
            {viewData.approvals?.length > 0 && (
              <div><h5 className="font-semibold text-sm mb-2">Approval Trail</h5>
                <div className="space-y-1">{viewData.approvals.map(a => (
                  <div key={a.id} className={`text-xs p-2 rounded flex justify-between ${a.action === 'approved' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                    <span><strong>Step {a.step}:</strong> {a.step_name} - <span className={a.action === 'approved' ? 'text-emerald-600' : 'text-red-600'}>{a.action.toUpperCase()}</span> by {a.approved_by_name}</span>
                    <span className="text-gray-400">{a.approved_at}</span>
                  </div>
                ))}</div>
              </div>
            )}

            {/* Action buttons - role based */}
            {viewData.status !== 'final_approved' && viewData.status !== 'rejected' && viewData.can_approve_current && (
              <div className="border-2 border-amber-300 rounded-lg p-4 bg-amber-50 space-y-3">
                <h5 className="font-bold text-amber-800">Your Approval Required - Step {viewData.current_step}: {viewData.workflow?.[viewData.current_step - 1]?.name}</h5>
                <div>
                  <label className="label text-amber-700">Reason / Remarks (Required) *</label>
                  <textarea className="input" rows="3" value={approvalRemarks} onChange={e => setApprovalRemarks(e.target.value)}
                    placeholder="Enter detailed reason for approval or rejection (minimum 5 characters)..." required />
                </div>
                <div className="flex gap-3">
                  <button onClick={() => handleApprove(viewData.id)} className="btn btn-success flex-1 py-3 text-base font-bold">Approve</button>
                  <button onClick={() => handleReject(viewData.id)} className="btn btn-danger flex-1 py-3 text-base font-bold">Reject</button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* New Request Modal */}
      <Modal isOpen={modal === 'add'} onClose={() => setModal(null)} title="New Payment Request" wide>
        <form onSubmit={handleSave} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">

          {/* Common fields */}
          <div className="border rounded-lg p-3 bg-gray-50">
            <h4 className="font-semibold text-sm text-gray-700 mb-3">Request Details</h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Employee Name *</label>
                <SearchableSelect
                  options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                  value={form.employee_name || null}
                  valueKey="name" displayKey="label"
                  placeholder="Search employee…"
                  onChange={(emp) => {
                    F('employee_name', emp?.name || '');
                    if (emp) { F('department', emp.department || ''); F('contact_number', emp.phone || ''); }
                  }}
                />
              </div>
              <div>
                <label className="label">Site Name *</label>
                <SearchableSelect
                  options={sites}
                  value={form.site_id || null}
                  valueKey="id" displayKey="name"
                  placeholder="Search site…"
                  onChange={(site) => { F('site_id', site?.id || ''); F('site_name', site?.name || ''); }}
                />
              </div>
              <div><label className="label">Department</label><input className="input" value={form.department} onChange={e => F('department', e.target.value)} /></div>
              <div><label className="label">Contact Number</label><input className="input" value={form.contact_number} onChange={e => F('contact_number', e.target.value)} /></div>
              <div><label className="label">Category *</label>
                <select className="select" value={form.category} onChange={e => F('category', e.target.value)} required>
                  <option value="">Select</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div><label className="label">Amount Required (Rs) *</label><input className="input" type="number" value={form.amount} onChange={e => F('amount', +e.target.value)} required /></div>
              <div className="col-span-2"><label className="label">Purpose / Description *</label><input className="input" value={form.purpose} onChange={e => F('purpose', e.target.value)} required /></div>
              <div><label className="label">Payment Mode</label>
                <select className="select" value={form.payment_mode} onChange={e => F('payment_mode', e.target.value)}>
                  <option>Cash</option><option>Bank</option><option>UPI</option>
                </select>
              </div>
              <div>
                <label className="label">Required By Date</label>
                <input className="input" type="date" value={form.required_by_date}
                  min={defaultRequiredByDate()}
                  onChange={e => F('required_by_date', e.target.value)} />
                <p className="text-[10px] text-gray-400 mt-0.5">Earliest: {defaultRequiredByDate()} (today + 5 days).</p>
              </div>
            </div>
          </div>

          {/* TA/DA fields */}
          {form.category === 'TA/DA' && (
            <div className="border rounded-lg p-3 bg-purple-50">
              <h4 className="font-semibold text-sm text-purple-700 mb-3">TA/DA Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Travel From-To *</label><input className="input" value={form.travel_from_to} onChange={e => F('travel_from_to', e.target.value)} required /></div>
                <div><label className="label">Travel Dates *</label><input className="input" value={form.travel_dates} onChange={e => F('travel_dates', e.target.value)} required /></div>
                <div><label className="label">Mode of Travel *</label>
                  <select className="select" value={form.mode_of_travel} onChange={e => F('mode_of_travel', e.target.value)} required>
                    <option value="">Select</option><option>Bus</option><option>Train</option><option>Flight</option><option>Car</option><option>Bike</option><option>Auto</option>
                  </select>
                </div>
                <div><label className="label">Stay Details</label><input className="input" value={form.stay_details} onChange={e => F('stay_details', e.target.value)} placeholder="Hotel name, duration..." /></div>
              </div>

              {/* Bus/Train/Flight → Ticket upload */}
              {['Bus','Train','Flight'].includes(form.mode_of_travel) && (
                <div className="mt-3 p-3 bg-white rounded border border-purple-200">
                  <label className="label">Upload Ticket *</label>
                  {form.ticket_upload ? (
                    <div className="flex items-center gap-2"><a href={form.ticket_upload} className="text-red-600 text-sm underline" target="_blank" rel="noreferrer">Ticket uploaded</a><button type="button" onClick={() => F('ticket_upload', '')} className="text-red-500 text-xs">Remove</button></div>
                  ) : (
                    <input type="file" onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('ticket_upload', res.data.url); toast.success('Ticket uploaded'); } catch { toast.error('Failed'); }
                      e.target.value = '';
                    }} className="text-xs" />
                  )}
                </div>
              )}

              {/* Car/Bike → KM + 2 Separate Photos */}
              {['Car','Bike'].includes(form.mode_of_travel) && (
                <div className="mt-3 p-3 bg-white rounded border border-purple-200 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2 p-2 bg-red-50 rounded">
                      <label className="label">Start KM *</label>
                      <input className="input" type="number" value={form.start_km || ''} onChange={e => F('start_km', +e.target.value)} required />
                      <label className="label text-[10px]">Start KM Meter Photo *</label>
                      {form.km_photo ? (
                        <div className="flex items-center gap-2"><a href={form.km_photo} className="text-red-600 text-xs underline truncate" target="_blank" rel="noreferrer">Photo uploaded</a><button type="button" onClick={() => F('km_photo', '')} className="text-red-500 text-[10px]">Remove</button></div>
                      ) : (
                        <input type="file" accept="image/*" onChange={async (e) => {
                          const file = e.target.files[0]; if (!file) return;
                          try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('km_photo', res.data.url); toast.success('Start photo uploaded'); } catch { toast.error('Failed'); }
                          e.target.value = '';
                        }} className="text-[10px] w-full" />
                      )}
                    </div>
                    <div className="space-y-2 p-2 bg-emerald-50 rounded">
                      <label className="label">End KM *</label>
                      <input className="input" type="number" value={form.end_km || ''} onChange={e => F('end_km', +e.target.value)} required />
                      <label className="label text-[10px]">End KM Meter Photo *</label>
                      {form.end_km_photo ? (
                        <div className="flex items-center gap-2"><a href={form.end_km_photo} className="text-red-600 text-xs underline truncate" target="_blank" rel="noreferrer">Photo uploaded</a><button type="button" onClick={() => F('end_km_photo', '')} className="text-red-500 text-[10px]">Remove</button></div>
                      ) : (
                        <input type="file" accept="image/*" onChange={async (e) => {
                          const file = e.target.files[0]; if (!file) return;
                          try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('end_km_photo', res.data.url); toast.success('End photo uploaded'); } catch { toast.error('Failed'); }
                          e.target.value = '';
                        }} className="text-[10px] w-full" />
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-purple-700 font-bold text-center">Total Distance: {Math.max(0, (form.end_km || 0) - (form.start_km || 0))} km</p>
                </div>
              )}

              {/* Auto → no proof needed */}
              {form.mode_of_travel === 'Auto' && (
                <div className="mt-3 p-2 bg-emerald-50 rounded text-xs text-emerald-700">No proof required for Auto</div>
              )}
            </div>
          )}

          {/* Purchase fields */}
          {form.category === 'Purchase' && (
            <div className="border rounded-lg p-3 bg-red-50">
              <h4 className="font-semibold text-sm text-red-700 mb-3">Purchase Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Indent Number *</label><input className="input" value={form.indent_number} onChange={e => F('indent_number', e.target.value)} required /></div>
                <div><label className="label">Vendor Name *</label><input className="input" value={form.vendor_name} onChange={e => F('vendor_name', e.target.value)} required /></div>
                <div className="col-span-2"><label className="label">Item Description</label><textarea className="input" rows="2" value={form.item_description} onChange={e => F('item_description', e.target.value)} /></div>
                <div><label className="label">Purchase Order Upload *</label>
                  {form.quotation_link ? (
                    <div className="flex items-center gap-2"><a href={form.quotation_link} className="text-red-600 text-sm underline">Quotation uploaded</a><button type="button" onClick={() => F('quotation_link', '')} className="text-red-500 text-xs">Remove</button></div>
                  ) : (
                    <input type="file" onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try { const fd = new FormData(); fd.append('file', file); const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); F('quotation_link', res.data.url); toast.success('Uploaded'); } catch { toast.error('Failed'); }
                      e.target.value = '';
                    }} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700" />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Labour fields */}
          {form.category === 'Labour' && (
            <div className="border rounded-lg p-3 bg-green-50">
              <h4 className="font-semibold text-sm text-green-700 mb-3">Labour Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Labour Type *</label><select className="select" value={form.labour_type} onChange={e => F('labour_type', e.target.value)} required><option value="">Select</option><option>Skilled</option><option>Unskilled</option><option>Semi-skilled</option><option>Contractor</option></select></div>
                <div><label className="label">Number of Workers *</label><input className="input" type="number" value={form.number_of_workers} onChange={e => F('number_of_workers', +e.target.value)} required /></div>
                <div><label className="label">Work Duration</label><input className="input" value={form.work_duration} onChange={e => F('work_duration', e.target.value)} placeholder="e.g. 5 days, 2 weeks" /></div>
                <div><label className="label">Site Engineer Name</label><input className="input" value={form.site_engineer_name} onChange={e => F('site_engineer_name', e.target.value)} /></div>
              </div>
            </div>
          )}

          {/* Transport fields */}
          {form.category === 'Transport' && (
            <div className="border rounded-lg p-3 bg-gray-50">
              <h4 className="font-semibold text-sm text-gray-700 mb-3">Transport Details</h4>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Vehicle Type *</label><select className="select" value={form.vehicle_type} onChange={e => F('vehicle_type', e.target.value)} required><option value="">Select</option><option>Truck</option><option>Pickup</option><option>Tempo</option><option>Car</option><option>Auto</option><option>Crane</option></select></div>
                <div><label className="label">From-To Location *</label><input className="input" value={form.from_to_location} onChange={e => F('from_to_location', e.target.value)} required /></div>
                <div><label className="label">Material Description</label><input className="input" value={form.material_description} onChange={e => F('material_description', e.target.value)} /></div>
                <div><label className="label">Driver / Vendor Name</label><input className="input" value={form.driver_vendor_name} onChange={e => F('driver_vendor_name', e.target.value)} /></div>
              </div>
            </div>
          )}

          {/* Approval workflow info */}
          {form.category && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
              <strong>Approval Flow:</strong> {form.category === 'TA/DA' ? (
                <span>HR → Accountant → Payment Release</span>
              ) : (
                <span>{form.category === 'Purchase' ? 'Purchase Head' : form.category === 'Labour' ? 'Site Engineer' : 'Purchase Dept'} → Accountant → Velocity (Auto) → Billing Engineer → Payment Release</span>
              )}
            </div>
          )}

          {/* Missing-proofs banner — visible before Submit so the user
              knows what's blocking the request. Same rules as the
              approval-modal audit view + handleSave validation. */}
          {(() => {
            const missing = requiredProofsMissing(form);
            if (missing.length === 0) return null;
            return (
              <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 text-sm text-red-800">
                <div className="font-bold flex items-center gap-1">⚠️ Missing required proof{missing.length > 1 ? 's' : ''}:</div>
                <ul className="list-disc ml-5 mt-1 text-xs">
                  {missing.map(m => <li key={m}>{m}</li>)}
                </ul>
                <p className="text-[11px] mt-1.5 text-red-700">Submit is blocked until you attach {missing.length > 1 ? 'these receipts' : 'this receipt'}. Proof must be uploaded at request time.</p>
              </div>
            );
          })()}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={requiredProofsMissing(form).length > 0}>Submit Request</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
