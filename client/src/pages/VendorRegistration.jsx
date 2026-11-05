import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import {
  FiPlus, FiRefreshCw, FiSearch, FiExternalLink, FiUploadCloud,
  FiCheckCircle, FiClock, FiAlertTriangle, FiLock, FiEye, FiEyeOff,
  FiCopy, FiFolder, FiCheckSquare, FiCalendar, FiUser, FiSettings,
  FiMail, FiActivity, FiTag, FiFileText, FiTrash2, FiEdit3,
  FiTrendingUp, FiSend, FiInbox, FiShield
} from 'react-icons/fi';
import { LuBadgeCheck } from 'react-icons/lu';

const STAGES = [
  { id: 'company_identified', label: 'Company Identified', short: 'Identified', color: 'bg-slate-100 text-slate-700 border-slate-300' },
  { id: 'portal_found', label: 'Portal Found', short: 'Portal Found', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'requirements_checked', label: 'Requirements Checked', short: 'Req Checked', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { id: 'registration_submitted', label: 'Registration Submitted', short: 'Submitted', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'proof_uploaded', label: 'Proof Uploaded', short: 'Proof Uploaded', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  { id: 'awaiting_credentials', label: 'Awaiting Credentials', short: 'Awaiting', color: 'bg-orange-50 text-orange-700 border-orange-200' },
  { id: 'credentials_received', label: 'Credentials Received', short: 'Empaneled', color: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
];

const STAGE_ORDER = STAGES.map(s => s.id);

const CATEGORIES = [
  'MEP Contractor',
  'Industrial & Manufacturing',
  'FMCG & Food Processing',
  'EPC & Infrastructure',
  'Power & Energy',
  'Commercial Real Estate',
  'Hospitality & Healthcare',
  'Government / PSU',
  'Automotive & Engineering',
];

const DEFAULT_DOCUMENTS = [
  { id: 'gst', name: 'GST Certificate', ready: false },
  { id: 'pan', name: 'Company PAN Card', ready: false },
  { id: 'bank', name: 'Cancelled Cheque & Bank Details', ready: false },
  { id: 'financials', name: 'Last 3 Years Balance Sheet / ITR', ready: false },
  { id: 'msme', name: 'MSME / Udyam Certificate', ready: false },
  { id: 'mep_certs', name: 'MEP Project Completion Certificates', ready: false },
  { id: 'elec_license', name: 'Electrical Contractor License', ready: false },
  { id: 'iso_safety', name: 'ISO / Safety Policy Certifications', ready: false },
  { id: 'pf_esic', name: 'PF & ESIC Registration Proofs', ready: false },
];

export default function VendorRegistration() {
  const { user, isAdmin } = useAuth();

  // State
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [registrations, setRegistrations] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [activeTab, setActiveTab] = useState('pipeline'); // 'pipeline' | 'table' | 'overdue' | 'vault' | 'marketing'
  
  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [detailTab, setDetailTab] = useState('overview'); // 'overview' | 'checklist' | 'proof' | 'vault' | 'emails' | 'history'

  // Forms
  const [addForm, setAddForm] = useState({
    company_name: '',
    portal_url: '',
    company_category: 'MEP Contractor',
    source_of_portal: 'Web Search',
    registration_owner_name: 'Anchal',
    registered_email: 'vendor.registration@sotyn.com',
    mep_categories: 'HVAC, Electrical, Plumbing, Fire Fighting, Solar',
    requirements_notes: '',
  });

  const [vaultForm, setVaultForm] = useState({
    vendor_id_code: '',
    portal_username: '',
    password: '',
    portal_login_url: '',
    credential_notes: '',
  });

  const [revealedPassword, setRevealedPassword] = useState('');
  const [revealingPassword, setRevealingPassword] = useState(false);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [scanningMailbox, setScanningMailbox] = useState(false);

  // Settings state
  const [settingsForm, setSettingsForm] = useState({
    reminder_first_days: '2',
    reminder_followup_days: '5',
    default_registered_email: 'vendor.registration@sotyn.com',
    email_imap_host: '',
    email_imap_port: '993',
    email_imap_user: '',
    email_imap_pass: '',
    email_lookback_days: '30',
  });

  // Fetch Dashboard Stats
  const fetchDashboard = useCallback(async () => {
    try {
      const res = await api.get('/vendor-registration/dashboard');
      setDashboard(res.data);
    } catch (err) {
      console.warn('Dashboard fetch error:', err.message);
    }
  }, []);

  // Fetch Registrations
  const fetchRegistrations = useCallback(async () => {
    try {
      const params = {};
      if (search) params.q = search;
      if (statusFilter) params.status = statusFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (ownerFilter) params.owner_id = ownerFilter;
      if (activeTab === 'overdue') params.overdue = '1';
      if (activeTab === 'marketing') params.marketing_status = 'ready_for_marketing';

      const res = await api.get('/vendor-registration', { params });
      setRegistrations(res.data.rows || []);
    } catch (err) {
      toast.error('Failed to load vendor registrations');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, statusFilter, categoryFilter, ownerFilter, activeTab]);

  // Load single record details
  const openDetail = async (id, initialTab = 'overview') => {
    try {
      const res = await api.get(`/vendor-registration/${id}`);
      setSelectedRecord(res.data);
      setDetailTab(initialTab);
      setRevealedPassword('');
      setVaultForm({
        vendor_id_code: res.data.vendor_id_code || '',
        portal_username: res.data.portal_username || '',
        password: '',
        portal_login_url: res.data.portal_login_url || res.data.portal_url || '',
        credential_notes: res.data.credential_notes || '',
      });
      setShowDetailModal(true);
    } catch (err) {
      toast.error('Failed to load registration details');
    }
  };

  useEffect(() => {
    fetchDashboard();
    fetchRegistrations();
  }, [fetchDashboard, fetchRegistrations]);

  // Handle stage advancement
  const advanceStage = async (recordId, currentStage, targetStage = null) => {
    let nextStage = targetStage;
    if (!nextStage) {
      const currentIdx = STAGE_ORDER.indexOf(currentStage);
      if (currentIdx !== -1 && currentIdx < STAGE_ORDER.length - 1) {
        nextStage = STAGE_ORDER[currentIdx + 1];
      }
    }
    if (!nextStage) return;

    try {
      await api.post(`/vendor-registration/${recordId}/stage`, {
        stage: nextStage,
        notes: `Advanced to ${nextStage} by user`,
      });
      toast.success(`Advanced to ${nextStage.replace(/_/g, ' ')}`);
      fetchDashboard();
      fetchRegistrations();
      if (selectedRecord && selectedRecord.id === recordId) {
        openDetail(recordId, detailTab);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to advance stage');
    }
  };

  // Handle Create
  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!addForm.company_name.trim() || !addForm.portal_url.trim()) {
      toast.error('Company Name and Portal URL are required');
      return;
    }
    try {
      await api.post('/vendor-registration', addForm);
      toast.success('Company portal added to tracking pipeline!');
      setShowAddModal(false);
      setAddForm({
        company_name: '',
        portal_url: '',
        company_category: 'MEP Contractor',
        source_of_portal: 'Web Search',
        registration_owner_name: 'Anchal',
        registered_email: 'vendor.registration@sotyn.com',
        mep_categories: 'HVAC, Electrical, Plumbing, Fire Fighting, Solar',
        requirements_notes: '',
      });
      fetchDashboard();
      fetchRegistrations();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    }
  };

  // Handle Vault Save
  const handleSaveVault = async (e) => {
    e.preventDefault();
    if (!selectedRecord) return;
    try {
      await api.post(`/vendor-registration/${selectedRecord.id}/credentials`, vaultForm);
      toast.success('Credentials stored securely in Encrypted Vault!');
      openDetail(selectedRecord.id, 'vault');
      fetchDashboard();
      fetchRegistrations();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save credentials');
    }
  };

  // Reveal Password
  const handleRevealPassword = async () => {
    if (!selectedRecord) return;
    setRevealingPassword(true);
    try {
      const res = await api.get(`/vendor-registration/${selectedRecord.id}/reveal-password`);
      setRevealedPassword(res.data.password);
      toast.success('Password revealed from vault');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Access denied');
    } finally {
      setRevealingPassword(false);
    }
  };

  // Toggle checklist item
  const handleChecklistToggle = async (checkId) => {
    if (!selectedRecord) return;
    const updated = (selectedRecord.required_documents || []).map(doc => {
      if (doc.id === checkId) return { ...doc, ready: !doc.ready };
      return doc;
    });

    try {
      await api.put(`/vendor-registration/${selectedRecord.id}`, {
        required_documents: updated,
      });
      setSelectedRecord(prev => ({ ...prev, required_documents: updated }));
      toast.success('Checklist updated');
    } catch (err) {
      toast.error('Failed to update checklist');
    }
  };

  // Proof File Upload
  const handleProofFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedRecord) return;
    setUploadingProof(true);

    const formData = new FormData();
    formData.append('file', file);

    try {
      // 1. Upload via standard storage API
      const upRes = await api.post('/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const fileUrl = upRes.data.url;

      // 2. Attach to vendor registration
      await api.post(`/vendor-registration/${selectedRecord.id}/proof`, {
        file_url: fileUrl,
        filename: file.name,
        file_size: file.size,
        mime_type: file.type,
        doc_type: file.type.includes('pdf') ? 'ack_pdf' : 'screenshot',
        title: file.type.includes('pdf') ? 'Acknowledgement Slip / PDF' : 'Submission Screenshot Proof',
      });

      toast.success('Submission proof uploaded and linked!');
      openDetail(selectedRecord.id, 'proof');
      fetchDashboard();
      fetchRegistrations();
    } catch (err) {
      toast.error('File upload failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setUploadingProof(false);
      e.target.value = '';
    }
  };

  // Scan mailbox
  const handleScanMailbox = async () => {
    setScanningMailbox(true);
    toast('Scanning SOTYN registration mailbox...', { icon: '📬' });
    try {
      const res = await api.post('/vendor-registration/scan-mailbox');
      if (res.data.configured === false) {
        toast.error(res.data.message || 'Mailbox not configured');
        setShowSettingsModal(true);
      } else {
        toast.success(res.data.message || 'Mailbox scan completed');
        fetchDashboard();
        fetchRegistrations();
        if (selectedRecord) openDetail(selectedRecord.id, detailTab);
      }
    } catch (err) {
      toast.error('Mailbox scan error: ' + (err.response?.data?.error || err.message));
    } finally {
      setScanningMailbox(false);
    }
  };

  // Handover to Marketing
  const handleMarketingHandover = async () => {
    if (!selectedRecord) return;
    try {
      await api.post(`/vendor-registration/${selectedRecord.id}/handover-marketing`, {
        campaign_type: 'MEP Works, Solar & EPC Tenders',
      });
      toast.success('Vendor transferred to Marketing & BD Pipeline!');
      openDetail(selectedRecord.id, 'overview');
      fetchDashboard();
      fetchRegistrations();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to handover');
    }
  };

  // Record Follow-up
  const handleRecordFollowup = async (notes) => {
    if (!selectedRecord) return;
    try {
      await api.post(`/vendor-registration/${selectedRecord.id}/followup`, { notes });
      toast.success('Follow-up recorded');
      openDetail(selectedRecord.id, 'history');
      fetchDashboard();
      fetchRegistrations();
    } catch (err) {
      toast.error('Failed to log follow-up');
    }
  };

  // Open Settings
  const openSettings = async () => {
    try {
      const res = await api.get('/vendor-registration/settings');
      setSettingsForm(prev => ({ ...prev, ...res.data }));
      setShowSettingsModal(true);
    } catch (err) {
      toast.error('Failed to load settings');
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      await api.put('/vendor-registration/settings', settingsForm);
      toast.success('Settings saved');
      setShowSettingsModal(false);
    } catch (err) {
      toast.error('Failed to save settings');
    }
  };

  // Grouped by stage for Kanban
  const kanbanColumns = useMemo(() => {
    const map = {};
    for (const s of STAGES) map[s.id] = [];
    for (const r of registrations) {
      if (map[r.status]) {
        map[r.status].push(r);
      } else if (r.status === 'additional_info_required' || r.status === 'activation_pending') {
        map['awaiting_credentials'].push(r);
      } else {
        map['company_identified'].push(r);
      }
    }
    return map;
  }, [registrations]);

  return (
    <div className="w-full px-3 sm:px-6 py-3 space-y-3.5">
      {/* ── Top Header (Slim & Uncongested) ────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-1">
        <div className="flex items-center gap-2.5">
          <span className="p-2 rounded-xl bg-indigo-600 text-white shadow-2xs flex-shrink-0">
            <LuBadgeCheck size={20} />
          </span>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 tracking-tight">
              SOTYN Vendor Registration & Empanelment
            </h1>
            <p className="text-xs text-gray-500">
              MEP contractor portal discovery, compliance checklist, credential vault & BD marketing pipeline
            </p>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={() => { setRefreshing(true); fetchDashboard(); fetchRegistrations(); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors shadow-2xs"
          >
            <FiRefreshCw className={refreshing ? 'animate-spin' : ''} size={13} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleScanMailbox}
            disabled={scanningMailbox}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 transition-colors disabled:opacity-50 shadow-2xs"
          >
            <FiMail className={scanningMailbox ? 'animate-bounce' : ''} size={13} />
            <span>{scanningMailbox ? 'Scanning...' : 'Scan Inbox'}</span>
          </button>

          <button
            onClick={openSettings}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors shadow-2xs"
          >
            <FiSettings size={13} />
            <span>SLA & Config</span>
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs transition-colors"
          >
            <FiPlus size={14} />
            <span>Add Company Portal</span>
          </button>
        </div>
      </div>

      {/* ── KPI Dashboard Cards (Slim & Compact) ────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <div className="bg-white p-3 rounded-xl border border-gray-200/80 shadow-2xs">
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between">
            <span>Total Portals</span>
            <FiFolder className="text-gray-400" size={14} />
          </div>
          <div className="text-xl font-bold text-gray-900 mt-1">{dashboard?.counters?.totalPortals ?? 0}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Identified & Onboarded</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-gray-200/80 shadow-2xs">
          <div className="text-[11px] font-semibold text-blue-600 uppercase tracking-wider flex items-center justify-between">
            <span>Submitted</span>
            <FiUploadCloud className="text-blue-500" size={14} />
          </div>
          <div className="text-xl font-bold text-blue-600 mt-1">{dashboard?.counters?.submitted ?? 0}</div>
          <div className="text-[10px] text-blue-400 mt-0.5">Applied on portals</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-gray-200/80 shadow-2xs">
          <div className="text-[11px] font-semibold text-amber-600 uppercase tracking-wider flex items-center justify-between">
            <span>Awaiting Login</span>
            <FiClock className="text-amber-500" size={14} />
          </div>
          <div className="text-xl font-bold text-amber-600 mt-1">{dashboard?.counters?.awaiting ?? 0}</div>
          <div className="text-[10px] text-amber-500 mt-0.5">Under enterprise review</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-gray-200/80 shadow-2xs">
          <div className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider flex items-center justify-between">
            <span>Empaneled</span>
            <LuBadgeCheck className="text-emerald-500" size={16} />
          </div>
          <div className="text-xl font-bold text-emerald-600 mt-1">{dashboard?.counters?.received ?? 0}</div>
          <div className="text-[10px] text-emerald-500 mt-0.5">Vendor ID & Vault ready</div>
        </div>

        <div className={`p-3 rounded-xl border shadow-2xs transition-colors ${dashboard?.counters?.followupsDue > 0 ? 'bg-rose-50/80 border-rose-200' : 'bg-white border-gray-200/80'}`}>
          <div className="text-[11px] font-semibold text-rose-600 uppercase tracking-wider flex items-center justify-between">
            <span>Follow-up Due</span>
            <FiAlertTriangle className={dashboard?.counters?.followupsDue > 0 ? 'text-rose-500 animate-pulse' : 'text-gray-400'} size={14} />
          </div>
          <div className={`text-xl font-bold mt-1 ${dashboard?.counters?.followupsDue > 0 ? 'text-rose-600' : 'text-gray-900'}`}>
            {dashboard?.counters?.followupsDue ?? 0}
          </div>
          <div className="text-[10px] text-rose-500 mt-0.5">Day 2 & Day 5 SLA alerts</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-gray-200/80 shadow-2xs">
          <div className="text-[11px] font-semibold text-purple-600 uppercase tracking-wider flex items-center justify-between">
            <span>Ready for BD</span>
            <FiTrendingUp className="text-purple-500" size={14} />
          </div>
          <div className="text-xl font-bold text-purple-600 mt-1">{dashboard?.counters?.readyForMarketing ?? 0}</div>
          <div className="text-[10px] text-purple-500 mt-0.5">Marketing pipeline bridge</div>
        </div>
      </div>

      {/* ── View Selector & Search Filter Bar (Clean & Lightweight) ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
        {/* View Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none flex-wrap">
          <button
            onClick={() => setActiveTab('pipeline')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shadow-2xs ${
              activeTab === 'pipeline' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
            }`}
          >
            Pipeline (Kanban)
          </button>
          <button
            onClick={() => setActiveTab('table')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shadow-2xs ${
              activeTab === 'table' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
            }`}
          >
            All Portals ({registrations.length})
          </button>
          <button
            onClick={() => setActiveTab('overdue')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-2xs ${
              activeTab === 'overdue' ? 'bg-rose-600 text-white' : 'text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200'
            }`}
          >
            <FiClock size={13} />
            <span>Pending Follow-ups</span>
          </button>
          <button
            onClick={() => setActiveTab('vault')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-2xs ${
              activeTab === 'vault' ? 'bg-emerald-600 text-white' : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200'
            }`}
          >
            <FiLock size={13} />
            <span>Credential Vault</span>
          </button>
          <button
            onClick={() => setActiveTab('marketing')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-2xs ${
              activeTab === 'marketing' ? 'bg-purple-600 text-white' : 'text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200'
            }`}
          >
            <FiTrendingUp size={13} />
            <span>Marketing Pipeline</span>
          </button>
        </div>

        {/* Search & Category Filter */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative w-full sm:w-64">
            <FiSearch className="absolute left-3 top-2.5 text-gray-400" size={13} />
            <input
              type="text"
              placeholder="Search company, portal URL, app #..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 shadow-2xs"
            />
          </div>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="text-xs py-1.5 px-2.5 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 whitespace-nowrap shadow-2xs"
          >
            <option value="">All Categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* ── Main View Area ────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center p-12 text-gray-400">
          <FiRefreshCw className="animate-spin mr-2" size={20} />
          <span>Loading registrations...</span>
        </div>
      ) : activeTab === 'pipeline' ? (
        /* ── Kanban Pipeline View (Professional 260px wide columns with horizontal scroll) ────────────────────────────── */
        <div className="flex gap-3.5 overflow-x-auto pb-4 pt-1 items-start">
          {STAGES.map((stage) => {
            const items = kanbanColumns[stage.id] || [];
            return (
              <div key={stage.id} className="bg-gray-50/90 rounded-2xl p-3 border border-gray-200/80 flex flex-col w-[265px] flex-shrink-0 shadow-2xs">
                {/* Column Header */}
                <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-gray-200">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-gray-800 truncate" title={stage.label}>
                      {stage.label}
                    </span>
                    <span className="px-2 py-0.5 text-[11px] font-bold bg-white text-gray-700 rounded-full border border-gray-200 shadow-2xs">
                      {items.length}
                    </span>
                  </div>
                </div>

                {/* Cards Container */}
                <div className="space-y-2.5 flex-1 overflow-y-auto max-h-[70vh] pr-0.5">
                  {items.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-xs italic">No portals</div>
                  ) : (
                    items.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => openDetail(item.id)}
                        className={`bg-white p-3.5 rounded-xl border shadow-2xs hover:shadow-xs transition-all cursor-pointer group relative ${
                          item.is_overdue ? 'border-rose-300 ring-1 ring-rose-300/40' : 'border-gray-200 hover:border-indigo-300'
                        }`}
                      >
                        {/* Overdue Alert Tag */}
                        {item.is_overdue === 1 && (
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 px-2 py-1 rounded-lg mb-2 border border-rose-200">
                            <FiClock size={12} className="text-rose-600" />
                            <span>Follow-up Overdue</span>
                          </div>
                        )}

                        <div className="flex items-start justify-between gap-1.5">
                          <h4 className="text-xs font-bold text-gray-900 group-hover:text-indigo-600 transition-colors line-clamp-1" title={item.company_name}>
                            {item.company_name}
                          </h4>
                          <span className="text-[10px] text-gray-400 whitespace-nowrap bg-gray-50 px-1.5 py-0.5 rounded font-mono">
                            {item.days_in_pipeline}d
                          </span>
                        </div>

                        <div className="text-[11px] text-gray-500 mt-1 line-clamp-1 flex items-center gap-1">
                          <span className="truncate">{item.company_category || 'MEP Contractor'}</span>
                        </div>

                        {/* Portal Link */}
                        <div className="mt-2 flex items-center justify-between text-[11px] bg-gray-50/70 p-1.5 rounded-lg">
                          <a
                            href={item.portal_url.startsWith('http') ? item.portal_url : `https://${item.portal_url}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline max-w-[170px] truncate font-medium"
                          >
                            <span className="truncate">{item.portal_url.replace(/https?:\/\//, '')}</span>
                            <FiExternalLink size={11} className="flex-shrink-0" />
                          </a>

                          {item.has_password && (
                            <span title="Credentials Vault Secured" className="text-emerald-600 bg-emerald-50 p-1 rounded">
                              <FiLock size={12} />
                            </span>
                          )}
                        </div>

                        {/* Owner & Advance Stage Button */}
                        <div className="mt-2.5 pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
                          <span className="text-[11px] text-gray-600 truncate flex items-center gap-1">
                            <FiUser size={12} className="text-gray-400" />
                            <span>{item.registration_owner_name || 'Anchal'}</span>
                          </span>

                          {stage.id !== 'credentials_received' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                advanceStage(item.id, item.status);
                              }}
                              title="Advance to next step"
                              className="text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1 shadow-2xs"
                            >
                              <span>Next</span>
                              <span>→</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : activeTab === 'vault' ? (
        /* ── Secure Credential Vault View ─────────────────────── */
        <div className="space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="p-2 rounded-xl bg-emerald-600 text-white">
                <FiLock size={20} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-emerald-900">Encrypted Corporate Credential Vault</h3>
                <p className="text-xs text-emerald-700">
                  Portals where SOTYN is officially empaneled. Passwords are encrypted at rest with AES-256-GCM and strictly role-gated.
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 bg-white text-emerald-800 rounded-lg border border-emerald-200">
              {registrations.filter(r => r.credentials_received === 1 || r.status === 'credentials_received').length} Empaneled Portals
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {registrations
              .filter(r => r.credentials_received === 1 || r.status === 'credentials_received')
              .map(item => (
                <div key={item.id} className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-gray-900">{item.company_name}</h4>
                      <p className="text-xs text-gray-500">{item.company_category}</p>
                    </div>
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                      <LuBadgeCheck size={14} /> Empaneled
                    </span>
                  </div>

                  <div className="bg-gray-50 p-2.5 rounded-lg space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Vendor ID / Code:</span>
                      <span className="font-mono font-semibold text-gray-900">{item.vendor_id_code || 'Issued'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Portal User:</span>
                      <span className="font-mono text-gray-800">{item.portal_username || item.registered_email || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Password:</span>
                      <span className="font-mono text-gray-600">•••••••• (Secured)</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <a
                      href={item.portal_login_url || item.portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline font-medium"
                    >
                      <span>Open Portal</span>
                      <FiExternalLink size={12} />
                    </a>

                    <button
                      onClick={() => openDetail(item.id, 'vault')}
                      className="text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors"
                    >
                      View & Decrypt
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : activeTab === 'marketing' ? (
        /* ── Marketing & BD Pipeline Bridge View ──────────────── */
        <div className="space-y-4">
          <div className="bg-purple-50 border border-purple-200 p-4 rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="p-2 rounded-xl bg-purple-600 text-white">
                <FiTrendingUp size={20} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-purple-900">Marketing & Tendering Pipeline</h3>
                <p className="text-xs text-purple-700">
                  Companies where vendor empanelment is complete. BD and marketing teams can now bid on MEP tenders and send introduction decks.
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 bg-white text-purple-800 rounded-lg border border-purple-200">
              {registrations.filter(r => r.marketing_status === 'ready_for_marketing' || r.marketing_status === 'campaign_active').length} Active for BD
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {registrations
              .filter(r => r.marketing_status === 'ready_for_marketing' || r.marketing_status === 'campaign_active' || r.credentials_received === 1)
              .map(item => (
                <div key={item.id} className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-gray-900">{item.company_name}</h4>
                      <p className="text-xs text-gray-500">{item.company_category}</p>
                    </div>
                    <span className="text-[11px] font-semibold text-purple-700 bg-purple-50 px-2 py-0.5 rounded-md border border-purple-200">
                      {item.marketing_status === 'campaign_active' ? 'BD Campaign Active' : 'Ready for BD'}
                    </span>
                  </div>

                  <div className="text-xs text-gray-600 bg-gray-50 p-2.5 rounded-lg space-y-1">
                    <div><span className="font-medium text-gray-500">MEP Focus:</span> {item.mep_categories || 'HVAC, Electrical, Fire, Plumbing'}</div>
                    <div><span className="font-medium text-gray-500">Vendor Code:</span> <span className="font-mono font-semibold">{item.vendor_id_code || 'Registered'}</span></div>
                    {item.marketing_notes && <div><span className="font-medium text-gray-500">Notes:</span> {item.marketing_notes}</div>}
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      onClick={() => openDetail(item.id, 'overview')}
                      className="text-xs text-indigo-600 font-medium hover:underline"
                    >
                      View Details
                    </button>
                    <a
                      href={item.portal_login_url || item.portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-white bg-purple-600 hover:bg-purple-700 px-3 py-1.5 rounded-lg font-medium transition-colors"
                    >
                      <span>Check Tenders</span>
                      <FiExternalLink size={12} />
                    </a>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : (
        /* ── All Portals Table / Overdue View ─────────────────── */
        <div className="bg-white rounded-xl border border-gray-200 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50/80 border-b border-gray-200 text-gray-600 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-3">Company & Category</th>
                  <th className="py-3 px-3">Portal Link</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3">Owner</th>
                  <th className="py-3 px-3">App / Vendor No</th>
                  <th className="py-3 px-3">Proof</th>
                  <th className="py-3 px-3">Next Follow-up</th>
                  <th className="py-3 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {registrations.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-gray-400 italic">
                      No registrations found matching criteria
                    </td>
                  </tr>
                ) : (
                  registrations.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => openDetail(item.id)}
                      className={`hover:bg-indigo-50/40 cursor-pointer transition-colors ${
                        item.is_overdue ? 'bg-rose-50/40' : ''
                      }`}
                    >
                      <td className="py-3 px-3">
                        <div className="font-bold text-gray-900">{item.company_name}</div>
                        <div className="text-[11px] text-gray-400">{item.company_category}</div>
                      </td>

                      <td className="py-3 px-3">
                        <a
                          href={item.portal_url.startsWith('http') ? item.portal_url : `https://${item.portal_url}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline max-w-[180px] truncate"
                        >
                          <span className="truncate">{item.portal_url.replace(/https?:\/\//, '')}</span>
                          <FiExternalLink size={11} className="flex-shrink-0" />
                        </a>
                      </td>

                      <td className="py-3 px-3">
                        <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                          STAGES.find(s => s.id === item.status)?.color || 'bg-gray-100 text-gray-700 border-gray-300'
                        }`}>
                          {item.status.replace(/_/g, ' ')}
                        </span>
                      </td>

                      <td className="py-3 px-3">
                        <span className="text-gray-700">{item.registration_owner_name || 'Anchal'}</span>
                      </td>

                      <td className="py-3 px-3 font-mono">
                        {item.vendor_id_code ? (
                          <span className="text-emerald-700 font-semibold">{item.vendor_id_code}</span>
                        ) : item.application_number ? (
                          <span className="text-gray-700">{item.application_number}</span>
                        ) : (
                          <span className="text-gray-400 italic">—</span>
                        )}
                      </td>

                      <td className="py-3 px-3">
                        {item.submission_proof_url ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-[11px] font-medium">
                            <FiCheckCircle size={13} />
                            <span>Uploaded</span>
                          </span>
                        ) : (
                          <span className="text-gray-400 text-[11px]">Pending</span>
                        )}
                      </td>

                      <td className="py-3 px-3">
                        {item.next_followup_date ? (
                          <span className={`inline-flex items-center gap-1 font-medium ${
                            item.is_overdue ? 'text-rose-600 font-bold' : 'text-gray-600'
                          }`}>
                            {item.is_overdue === 1 && <FiAlertTriangle size={12} />}
                            <span>{item.next_followup_date}</span>
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openDetail(item.id);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Add Company Portal Modal ──────────────────────────── */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Company Vendor Portal"
        wide
      >
        <form onSubmit={handleAddSubmit} className="space-y-4 text-xs sm:text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-gray-700 mb-1">Company Name *</label>
              <input
                type="text"
                required
                placeholder="e.g. Reliance Industries, Tata Steel, L&T"
                value={addForm.company_name}
                onChange={(e) => setAddForm({ ...addForm, company_name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Portal URL *</label>
              <input
                type="text"
                required
                placeholder="e.g. https://scm.ril.com or vendor portal link"
                value={addForm.portal_url}
                onChange={(e) => setAddForm({ ...addForm, portal_url: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Company Category</label>
              <select
                value={addForm.company_category}
                onChange={(e) => setAddForm({ ...addForm, company_category: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Source of Portal Link</label>
              <input
                type="text"
                placeholder="Web Search, Tender notice, Client referral..."
                value={addForm.source_of_portal}
                onChange={(e) => setAddForm({ ...addForm, source_of_portal: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Registration Owner</label>
              <input
                type="text"
                placeholder="Anchal"
                value={addForm.registration_owner_name}
                onChange={(e) => setAddForm({ ...addForm, registration_owner_name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">SOTYN Registered Email</label>
              <input
                type="email"
                placeholder="vendor.registration@sotyn.com"
                value={addForm.registered_email}
                onChange={(e) => setAddForm({ ...addForm, registered_email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">MEP Categories / Capabilities</label>
            <input
              type="text"
              value={addForm.mep_categories}
              onChange={(e) => setAddForm({ ...addForm, mep_categories: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block font-medium text-gray-700 mb-1">Requirements / Initial Notes</label>
            <textarea
              rows={2}
              placeholder="Portal eligibility notes, required turnover, specific document queries..."
              value={addForm.requirements_notes}
              onChange={(e) => setAddForm({ ...addForm, requirements_notes: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold"
            >
              Add Portal
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Registration Details & Execution Modal ───────────── */}
      {selectedRecord && (
        <Modal
          isOpen={showDetailModal}
          onClose={() => setShowDetailModal(false)}
          title={selectedRecord.company_name}
          headerExtra={
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
              STAGES.find(s => s.id === selectedRecord.status)?.color || 'bg-gray-100'
            }`}>
              {selectedRecord.status.replace(/_/g, ' ')}
            </span>
          }
          xwide
        >
          <div className="space-y-4">
            {/* Visual 7-Step Progress Stepper */}
            <div className="bg-gray-50 p-3 rounded-xl border border-gray-200/70 overflow-x-auto scrollbar-none">
              <div className="flex items-center min-w-[700px] justify-between">
                {STAGES.map((s, idx) => {
                  const currentIdx = STAGE_ORDER.indexOf(selectedRecord.status);
                  const isDone = currentIdx >= idx;
                  const isCurrent = selectedRecord.status === s.id;

                  return (
                    <div
                      key={s.id}
                      onClick={() => advanceStage(selectedRecord.id, selectedRecord.status, s.id)}
                      className="flex-1 flex flex-col items-center cursor-pointer group"
                    >
                      <div className="flex items-center w-full">
                        {idx > 0 && (
                          <div className={`h-1 flex-1 ${currentIdx >= idx ? 'bg-indigo-600' : 'bg-gray-200'}`} />
                        )}
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shadow-2xs ${
                          isCurrent
                            ? 'bg-indigo-600 text-white ring-4 ring-indigo-100'
                            : isDone
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white text-gray-400 border border-gray-300'
                        }`}>
                          {isDone && !isCurrent ? <FiCheckCircle size={14} /> : idx + 1}
                        </div>
                        {idx < STAGES.length - 1 && (
                          <div className={`h-1 flex-1 ${currentIdx > idx ? 'bg-indigo-600' : 'bg-gray-200'}`} />
                        )}
                      </div>
                      <span className={`text-[10px] mt-1.5 font-medium text-center line-clamp-1 ${
                        isCurrent ? 'text-indigo-600 font-bold' : isDone ? 'text-gray-800' : 'text-gray-400'
                      }`}>
                        {s.short}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Detail Tabs */}
            <div className="flex items-center gap-1 border-b pb-2 text-xs font-medium text-gray-600">
              <button
                onClick={() => setDetailTab('overview')}
                className={`px-3 py-1.5 rounded-lg transition-colors ${
                  detailTab === 'overview' ? 'bg-indigo-50 text-indigo-700 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                Overview & Portal
              </button>
              <button
                onClick={() => setDetailTab('checklist')}
                className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  detailTab === 'checklist' ? 'bg-indigo-50 text-indigo-700 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                <FiCheckSquare size={13} />
                <span>MEP Checklist ({(selectedRecord.required_documents || []).filter(d => d.ready).length}/{(selectedRecord.required_documents || []).length})</span>
              </button>
              <button
                onClick={() => setDetailTab('proof')}
                className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  detailTab === 'proof' ? 'bg-indigo-50 text-indigo-700 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                <FiUploadCloud size={13} />
                <span>Proof & Docs ({(selectedRecord.documents || []).length})</span>
              </button>
              <button
                onClick={() => setDetailTab('vault')}
                className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  detailTab === 'vault' ? 'bg-emerald-50 text-emerald-700 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                <FiLock size={13} />
                <span>Credential Vault</span>
              </button>
              <button
                onClick={() => setDetailTab('emails')}
                className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  detailTab === 'emails' ? 'bg-blue-50 text-blue-700 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                <FiMail size={13} />
                <span>Inbound Emails ({(selectedRecord.emails || []).length})</span>
              </button>
              <button
                onClick={() => setDetailTab('history')}
                className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                  detailTab === 'history' ? 'bg-gray-100 text-gray-800 font-bold' : 'hover:bg-gray-100'
                }`}
              >
                <FiActivity size={13} />
                <span>History</span>
              </button>
            </div>

            {/* ── Subtab 1: Overview ─────────────────────────────── */}
            {detailTab === 'overview' && (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 p-4 rounded-xl">
                  <div className="space-y-2">
                    <div>
                      <span className="font-semibold text-gray-500">Official Portal URL:</span>
                      <div className="mt-0.5">
                        <a
                          href={selectedRecord.portal_url.startsWith('http') ? selectedRecord.portal_url : `https://${selectedRecord.portal_url}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-blue-600 font-medium hover:underline break-all"
                        >
                          <span>{selectedRecord.portal_url}</span>
                          <FiExternalLink size={13} />
                        </a>
                      </div>
                    </div>

                    <div>
                      <span className="font-semibold text-gray-500">Registered SOTYN Email:</span>
                      <div className="text-gray-900 font-medium">{selectedRecord.registered_email || 'vendor.registration@sotyn.com'}</div>
                    </div>

                    <div>
                      <span className="font-semibold text-gray-500">Assigned Registration Owner:</span>
                      <div className="text-gray-900 font-medium">{selectedRecord.registration_owner_name || 'Anchal'}</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div>
                      <span className="font-semibold text-gray-500">Application / Ack Number:</span>
                      <div className="text-gray-900 font-mono font-bold">{selectedRecord.application_number || 'Not issued yet'}</div>
                    </div>

                    <div>
                      <span className="font-semibold text-gray-500">Next Follow-up Due:</span>
                      <div className={`font-semibold ${selectedRecord.is_overdue ? 'text-rose-600' : 'text-gray-900'}`}>
                        {selectedRecord.next_followup_date || 'No follow-up set'}
                        {selectedRecord.is_overdue === 1 && ' (Overdue!)'}
                      </div>
                    </div>

                    <div>
                      <span className="font-semibold text-gray-500">MEP Capabilities Selected:</span>
                      <div className="text-gray-800">{selectedRecord.mep_categories || 'MEP Works'}</div>
                    </div>
                  </div>
                </div>

                {/* Handover to Marketing Card */}
                {selectedRecord.credentials_received === 1 && (
                  <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl flex items-center justify-between gap-4">
                    <div>
                      <h4 className="font-bold text-purple-900">Empanelment Complete — Ready for Marketing</h4>
                      <p className="text-purple-700 text-[11px] mt-0.5">
                        SOTYN is approved with {selectedRecord.company_name}. You can transfer this to the BD & Tendering pipeline.
                      </p>
                    </div>
                    <button
                      onClick={handleMarketingHandover}
                      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg text-xs transition-colors flex items-center gap-1.5"
                    >
                      <FiSend size={13} />
                      <span>Transfer to BD</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Subtab 2: Requirements Checklist ───────────────── */}
            {detailTab === 'checklist' && (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between text-gray-600 bg-indigo-50/60 p-2.5 rounded-lg border border-indigo-100">
                  <span>Verify mandatory documents required by {selectedRecord.company_name}'s portal:</span>
                  <span className="font-bold text-indigo-700">
                    {(selectedRecord.required_documents || []).filter(d => d.ready).length} of {(selectedRecord.required_documents || []).length} Ready
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(selectedRecord.required_documents || DEFAULT_DOCUMENTS).map(doc => (
                    <div
                      key={doc.id}
                      onClick={() => handleChecklistToggle(doc.id)}
                      className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                        doc.ready ? 'bg-emerald-50/60 border-emerald-300 text-emerald-900' : 'bg-white border-gray-200 text-gray-700 hover:border-indigo-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={doc.ready}
                          onChange={() => {}}
                          className="rounded text-indigo-600 focus:ring-0"
                        />
                        <span className="font-medium">{doc.name}</span>
                      </div>
                      {doc.ready && <FiCheckCircle className="text-emerald-600" size={15} />}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Subtab 3: Proof & Documents ────────────────────── */}
            {detailTab === 'proof' && (
              <div className="space-y-4 text-xs">
                {/* Upload Zone */}
                <div className="p-4 border-2 border-dashed border-gray-300 rounded-xl text-center bg-gray-50/60 hover:bg-gray-50 transition-colors">
                  <FiUploadCloud className="mx-auto text-gray-400 mb-2" size={32} />
                  <p className="font-semibold text-gray-800">Upload Submission Screenshot or Acknowledgment PDF</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">Captures proof of registration, reference numbers, or approval slips.</p>
                  
                  <label className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold cursor-pointer transition-colors shadow-2xs">
                    <span>{uploadingProof ? 'Uploading...' : 'Select File'}</span>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      onChange={handleProofFileUpload}
                      disabled={uploadingProof}
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Uploaded Documents List */}
                <div className="space-y-2">
                  <h4 className="font-bold text-gray-900">Uploaded Proof Documents</h4>
                  {(selectedRecord.documents || []).length === 0 ? (
                    <div className="text-center py-6 text-gray-400 italic">No proof documents uploaded yet.</div>
                  ) : (
                    (selectedRecord.documents || []).map(doc => (
                      <div key={doc.id} className="p-3 bg-white border border-gray-200 rounded-xl flex items-center justify-between gap-3 shadow-2xs">
                        <div className="flex items-center gap-2.5">
                          <span className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                            <FiFileText size={16} />
                          </span>
                          <div>
                            <div className="font-semibold text-gray-900">{doc.title}</div>
                            <div className="text-[11px] text-gray-400">{doc.filename} • {fmtDateTime(doc.created_at)}</div>
                          </div>
                        </div>

                        <a
                          href={doc.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors flex items-center gap-1"
                        >
                          <span>View Proof</span>
                          <FiExternalLink size={12} />
                        </a>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ── Subtab 4: Encrypted Credential Vault ────────────── */}
            {detailTab === 'vault' && (
              <div className="space-y-4 text-xs">
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2 text-emerald-900">
                  <FiShield size={18} className="text-emerald-700 flex-shrink-0" />
                  <span>
                    Portal credentials are encrypted with <strong>AES-256-GCM</strong>. Only authorized roles (Admin and assigned owner) can view or reveal plain passwords.
                  </span>
                </div>

                <form onSubmit={handleSaveVault} className="space-y-3 bg-gray-50 p-4 rounded-xl border border-gray-200">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-gray-700 mb-1">Vendor ID / Code Issued *</label>
                      <input
                        type="text"
                        placeholder="e.g. V-987123"
                        value={vaultForm.vendor_id_code}
                        onChange={(e) => setVaultForm({ ...vaultForm, vendor_id_code: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg bg-white"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-gray-700 mb-1">Portal Login Username *</label>
                      <input
                        type="text"
                        placeholder="e.g. sotyn_mep or registered email"
                        value={vaultForm.portal_username}
                        onChange={(e) => setVaultForm({ ...vaultForm, portal_username: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg bg-white"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-gray-700 mb-1">Portal Password</label>
                      <input
                        type="password"
                        placeholder={selectedRecord.has_password ? '•••••••• (leave blank to keep current)' : 'Enter portal password'}
                        value={vaultForm.password}
                        onChange={(e) => setVaultForm({ ...vaultForm, password: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg bg-white"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-gray-700 mb-1">Portal Login Direct URL</label>
                      <input
                        type="text"
                        value={vaultForm.portal_login_url}
                        onChange={(e) => setVaultForm({ ...vaultForm, portal_login_url: e.target.value })}
                        className="w-full px-3 py-2 border rounded-lg bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-gray-700 mb-1">Credential & Portal Notes</label>
                    <textarea
                      rows={2}
                      placeholder="e.g. Requires OTP on registered mobile, password expires every 90 days..."
                      value={vaultForm.credential_notes}
                      onChange={(e) => setVaultForm({ ...vaultForm, credential_notes: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg bg-white"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      {selectedRecord.has_password && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleRevealPassword}
                            disabled={revealingPassword}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg font-medium transition-colors"
                          >
                            {revealedPassword ? <FiEyeOff size={13} /> : <FiEye size={13} />}
                            <span>{revealedPassword ? 'Hide Password' : 'Show Password'}</span>
                          </button>

                          {revealedPassword && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-emerald-300 rounded-lg font-mono font-bold text-emerald-800">
                              <span>{revealedPassword}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(revealedPassword);
                                  toast.success('Password copied to clipboard!');
                                }}
                                className="p-1 hover:text-emerald-600"
                              >
                                <FiCopy size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      type="submit"
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg transition-colors shadow-2xs"
                    >
                      Save Credentials in Vault
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Subtab 5: Inbound Emails ───────────────────────── */}
            {detailTab === 'emails' && (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Emails automatically matched by sender domain or application number:</span>
                  <button
                    onClick={handleScanMailbox}
                    disabled={scanningMailbox}
                    className="text-indigo-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <FiRefreshCw className={scanningMailbox ? 'animate-spin' : ''} size={12} />
                    <span>Check Inbox Now</span>
                  </button>
                </div>

                {(selectedRecord.emails || []).length === 0 ? (
                  <div className="p-8 text-center text-gray-400 bg-gray-50 rounded-xl italic">
                    No matching emails detected yet from {selectedRecord.company_name}.
                  </div>
                ) : (
                  (selectedRecord.emails || []).map(mail => (
                    <div key={mail.id} className="p-3 bg-white border border-gray-200 rounded-xl space-y-1 shadow-2xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-bold text-gray-900">{mail.subject}</div>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          mail.email_type === 'credentials' ? 'bg-emerald-100 text-emerald-800' :
                          mail.email_type === 'otp' ? 'bg-amber-100 text-amber-800' :
                          mail.email_type === 'additional_info' ? 'bg-rose-100 text-rose-800' :
                          'bg-blue-100 text-blue-800'
                        }`}>
                          {mail.email_type}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-500">
                        From: <span className="text-gray-700 font-medium">{mail.sender}</span> • {fmtDateTime(mail.received_at)}
                      </div>
                      <p className="text-gray-700 bg-gray-50 p-2 rounded text-[11px] mt-1">
                        {mail.body_snippet}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ── Subtab 6: Activity History ─────────────────────── */}
            {detailTab === 'history' && (
              <div className="space-y-3 text-xs">
                {/* Add Follow-up Quick Action */}
                <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200">
                  <input
                    type="text"
                    id="quickFollowupNote"
                    placeholder="Log a call or follow-up note with portal helpdesk..."
                    className="flex-1 px-3 py-1.5 border rounded-lg bg-white"
                  />
                  <button
                    onClick={() => {
                      const input = document.getElementById('quickFollowupNote');
                      if (input && input.value.trim()) {
                        handleRecordFollowup(input.value.trim());
                        input.value = '';
                      }
                    }}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg"
                  >
                    Log Follow-up
                  </button>
                </div>

                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {(selectedRecord.history || []).map(hist => (
                    <div key={hist.id} className="p-3 bg-white border border-gray-100 rounded-xl flex items-start gap-3 shadow-2xs">
                      <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 mt-0.5">
                        <FiActivity size={14} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-gray-900">{hist.action}</span>
                          <span className="text-[10px] text-gray-400">{fmtDateTime(hist.created_at)}</span>
                        </div>
                        <p className="text-gray-600 mt-0.5">{hist.notes}</p>
                        <span className="text-[10px] text-gray-400">By: {hist.performed_by_name || 'System'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Settings & SLA Modal ──────────────────────────────── */}
      <Modal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        title="Vendor Registration SLA & Mailbox Settings"
        wide
      >
        <form onSubmit={handleSaveSettings} className="space-y-4 text-xs sm:text-sm">
          <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-100 text-indigo-900 text-xs">
            Configure automated follow-up reminder thresholds and SOTYN's email inbox for portal confirmations & credentials scanning.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-gray-700 mb-1">Day 2 Initial Reminder (Days)</label>
              <input
                type="number"
                min={1}
                max={15}
                value={settingsForm.reminder_first_days}
                onChange={(e) => setSettingsForm({ ...settingsForm, reminder_first_days: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              />
              <span className="text-[11px] text-gray-400">Pings owner if no confirmation arrives in X days.</span>
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Follow-up Escalation Due (Days)</label>
              <input
                type="number"
                min={2}
                max={30}
                value={settingsForm.reminder_followup_days}
                onChange={(e) => setSettingsForm({ ...settingsForm, reminder_followup_days: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              />
              <span className="text-[11px] text-gray-400">Marks record as 'Follow-up Due' in dashboard.</span>
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Default Registration SOTYN Email</label>
              <input
                type="email"
                value={settingsForm.default_registered_email}
                onChange={(e) => setSettingsForm({ ...settingsForm, default_registered_email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>

            <div>
              <label className="block font-medium text-gray-700 mb-1">Lookback History (Days)</label>
              <input
                type="number"
                min={1}
                max={90}
                value={settingsForm.email_lookback_days}
                onChange={(e) => setSettingsForm({ ...settingsForm, email_lookback_days: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
          </div>

          <div className="pt-2 border-t">
            <h4 className="font-bold text-gray-900 mb-2">IMAP Mailbox Connection (Auto-Scanner)</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-gray-600 mb-1">IMAP Host</label>
                <input
                  type="text"
                  placeholder="imap.gmail.com or mail.sotyn.com"
                  value={settingsForm.email_imap_host}
                  onChange={(e) => setSettingsForm({ ...settingsForm, email_imap_host: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-gray-600 mb-1">IMAP Port</label>
                <input
                  type="text"
                  placeholder="993"
                  value={settingsForm.email_imap_port}
                  onChange={(e) => setSettingsForm({ ...settingsForm, email_imap_port: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-gray-600 mb-1">Mailbox Username / Email</label>
                <input
                  type="text"
                  placeholder="vendor.registration@sotyn.com"
                  value={settingsForm.email_imap_user}
                  onChange={(e) => setSettingsForm({ ...settingsForm, email_imap_user: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-gray-600 mb-1">Mailbox Password / App Password</label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={settingsForm.email_imap_pass}
                  onChange={(e) => setSettingsForm({ ...settingsForm, email_imap_pass: e.target.value })}
                  className="w-full px-3 py-1.5 border rounded-lg"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t">
            <button
              type="button"
              onClick={() => setShowSettingsModal(false)}
              className="px-4 py-2 border rounded-lg text-gray-700 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg"
            >
              Save Configuration
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

