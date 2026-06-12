import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiSearch, FiFilter, FiDownload, FiEdit2, FiTrash2, FiEye,
  FiX, FiBook, FiTrendingUp, FiClock, FiUpload
} from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import SearchableSelect from '../components/SearchableSelect';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

const STATUSES = ['booked', 'advance_received', 'planning', 'execution', 'completed'];
const CATEGORIES = ['Low Voltage', 'Fire Fighting', 'Fire NOC', 'Fire Alarm', 'CCTV', 'Access Control', 'PA System', 'Networking', 'Solar', 'Other'];
const ORDER_TYPES = ['Supply', 'SITC', 'AMC', 'Service'];
const LEAD_TYPES = ['Private', 'Government'];
const SOURCES = ['Inbound Enquiry', 'Indiamart Enquiry', 'WhatsApp', 'LinkedIn', 'Reference', 'Tender', 'Other'];

const emptyForm = {
  lead_type: 'Private', client_name: '', company_name: '', project_name: '',
  client_contact: '', client_email: '', email_address: '',
  source_of_enquiry: '', district: '', state: '', state_code: '', gstin: '', billing_address: '', shipping_address: '',
  guarantee_required: 'No', guarantee_percentage: '', sale_amount_without_gst: 0, po_amount: 0,
  order_type: 'Supply', penalty_clause: 'No', penalty_clause_date: '',
  committed_start_date: '', committed_delivery_date: '', committed_completion_date: '', freight_extra: 'No',
  category: '', customer_type: '', client_type: '', customer_code: '',
  employee_assigned: '', employee_id: '', lead_by: '',
  management_person_name: '', management_person_contact: '',
  operations_person_name: '', operations_person_contact: '',
  pmc_person_name: '', pmc_person_contact: '',
  architect_person_name: '', architect_person_contact: '',
  accounts_person_name: '', accounts_person_contact: '',
  tpa_items_count: 0, tpa_items_qty: '', tpa_material_amount: 0, tpa_labour_amount: 0,
  accessory_amount: 0, required_labour_per_day: '', actual_margin_pct: 0,
  payment_advance: '', payment_against_delivery: '', payment_against_installation: '',
  payment_against_commissioning: '', payment_retention: '', payment_credit: '', credit_days: 0,
  advance_received: 0,
  po_number: '', po_date: '',
  final_drawing_link: '',
  remarks: '', status: 'booked'
};

export default function BusinessBook() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [viewEntry, setViewEntry] = useState(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', category: '', order_type: '', lead_type: '' });
  const [showFilters, setShowFilters] = useState(false);

  const loadEntries = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    api.get(`/business-book?${params}`).then(r => setEntries(r.data)).catch(() => {});
  }, [search, filters]);

  const loadStats = () => {
    api.get('/business-book/stats/summary').then(r => setStats(r.data)).catch(() => {});
  };

  useEffect(() => { loadEntries(); loadStats(); }, [loadEntries]);

  // Strip CSV-import quote artifacts ('"""M/s X"""') and surrounding
  // whitespace from text fields before saving — also collapses internal
  // double-spaces. Runs on every text field so old quoted data gets
  // cleaned the next time someone edits + saves.
  const cleanText = (s) => (typeof s === 'string')
    ? s.replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, ' ').trim()
    : s;
  const cleanFormText = (f) => {
    const out = { ...f };
    const textFields = ['client_name', 'company_name', 'project_name', 'lead_type',
      'district', 'state', 'state_code', 'gstin', 'po_number', 'category', 'order_type', 'employee_assigned',
      'client_contact', 'client_email', 'email_address', 'source_of_enquiry',
      'customer_type', 'client_type', 'customer_code'];
    for (const k of textFields) if (typeof out[k] === 'string') out[k] = cleanText(out[k]);
    return out;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.client_name || !form.client_name.trim()) {
      toast.error('Client Name is required');
      return;
    }
    const cleaned = cleanFormText(form);
    try {
      if (modal === 'edit' && form.id) {
        await api.put(`/business-book/${form.id}`, cleaned);
        toast.success('Entry updated');
      } else {
        const res = await api.post('/business-book', cleaned);
        toast.success(`Created ${res.data.lead_no} with auto-links`);
      }
      setModal(null); setForm({ ...emptyForm }); loadEntries(); loadStats();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save'); }
  };

  const handleDelete = async (id, leadNo) => {
    if (!confirm(`Delete entry ${leadNo}?`)) return;
    try { await api.delete(`/business-book/${id}`); toast.success('Deleted'); loadEntries(); loadStats(); }
    catch { toast.error('Failed to delete'); }
  };

  const handleView = (entry) => { setViewEntry(entry); setModal('view'); };
  const handleEdit = (entry) => { setForm({ ...emptyForm, ...entry }); setModal('edit'); };

  const exportCSV = () => {
    if (entries.length === 0) return toast.error('No data');
    const headers = ['Lead No','Lead Type','Client','Company','Project','Category','Order Type','PO Number',
      'Sale Amount','PO Amount','Advance','Balance','Start','Delivery','Completion','District','State',
      'Customer Type','Employee','Status','Remarks'];
    const rows = entries.map(e => [e.lead_no, e.lead_type, e.client_name, e.company_name, e.project_name,
      e.category, e.order_type, e.po_number, e.sale_amount_without_gst, e.po_amount, e.advance_received,
      e.balance_amount, e.committed_start_date, e.committed_delivery_date, e.committed_completion_date,
      e.district, e.state, e.customer_type, e.employee_assigned, e.status, e.remarks]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `business-book-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); toast.success('Exported');
  };

  const clearFilters = () => { setFilters({ status: '', category: '', order_type: '', lead_type: '' }); setSearch(''); };
  const activeFilters = Object.values(filters).filter(Boolean).length + (search ? 1 : 0);
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;
  // Mam (2026-05-21): PO Amount (with GST) is always Sale × 1.18.
  // We force-compute on Sale Amount edits so the field can't drift.
  // Server also re-computes on save as a final guard.
  const F = (key, val) => setForm(f => {
    const next = { ...f, [key]: val };
    if (key === 'sale_amount_without_gst') {
      const s = Number(val) || 0;
      next.po_amount = Math.round(s * 1.18 * 100) / 100;
    }
    return next;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><FiBook className="text-red-600" /> Business Book</h1>
          <p className="text-sm text-gray-500 mt-1">Master New Business Booked Sheet</p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={16} /> Export CSV</button>
          {canCreate('business_book') && (
            <button onClick={() => { setForm({ ...emptyForm }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={16} /> New Entry</button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={FiBook} color="blue" label="Total Entries" value={stats.total} />
          <StatCard icon={LuIndianRupee} color="emerald" label="Total PO Value" value={fmt(stats.total_po)} />
          <StatCard icon={FiTrendingUp} color="amber" label="Advance Received" value={fmt(stats.total_advance)} valueColor="text-emerald-600" />
          <StatCard icon={FiClock} color="red" label="Balance Pending" value={fmt(stats.total_balance)} valueColor="text-red-600" />
        </div>
      )}

      {/* Status Chips */}
      {stats && stats.byStatus.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {stats.byStatus.map(s => (
            <button key={s.status} onClick={() => setFilters(f => ({ ...f, status: f.status === s.status ? '' : s.status }))}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${filters.status === s.status ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:border-red-300'}`}>
              {s.status.replace(/_/g, ' ')} ({s.count})
            </button>
          ))}
        </div>
      )}

      {/* Search & Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input className="input pl-10" placeholder="Search by client, company, project, lead no, PO number, customer code..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button onClick={() => setShowFilters(!showFilters)} className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'} flex items-center gap-2`}>
            <FiFilter size={16} /> Filters {activeFilters > 0 && <span className="bg-white/20 text-xs px-1.5 py-0.5 rounded-full">{activeFilters}</span>}
          </button>
          {activeFilters > 0 && <button onClick={clearFilters} className="btn btn-secondary text-red-500"><FiX size={14} /> Clear</button>}
        </div>
        {showFilters && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t">
            <div><label className="label">Status</label><select className="select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}><option value="">All</option>{STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></div>
            <div><label className="label">Category</label><select className="select" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}><option value="">All</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Order Type</label><select className="select" value={filters.order_type} onChange={e => setFilters(f => ({ ...f, order_type: e.target.value }))}><option value="">All</option>{ORDER_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="label">Lead Type</label><select className="select" value={filters.lead_type} onChange={e => setFilters(f => ({ ...f, lead_type: e.target.value }))}><option value="">All</option>{LEAD_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          </div>
        )}
      </div>

      {/* Count */}
      <div className="flex justify-between items-center text-sm text-gray-500">
        <span>Showing {entries.length} entries</span>
        {entries.length > 0 && (
          <span className="font-medium">
            {/* Sum the SAME field the SALE AMT column displays per row
                (sale_amount_without_gst), so the footer matches Cash Flow's
                project SALE column for the same filter. Mam: "only pick
                business book sales value". */}
            Sale Total: {fmt(entries.reduce((s, e) => s + (e.sale_amount_without_gst || 0), 0))}
            {' | Balance: '}{fmt(entries.reduce((s, e) => s + (e.balance_amount || 0), 0))}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="card p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full freeze-head">
            <thead><tr className="bg-gray-50">
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Lead No</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Type</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Client Name</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Project / Location</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Category</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Order</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">PO Number</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Sale Amt</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Advance</th>
              <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Balance</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Employee</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Status</th>
              <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map(b => (
                <tr key={b.id} className="hover:bg-red-50/30 transition-colors">
                  <td className="px-3 py-3"><span className="font-bold text-red-600 cursor-pointer hover:underline" onClick={() => handleView(b)}>{b.lead_no}</span></td>
                  <td className="px-3 py-3"><span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${b.lead_type === 'Government' ? 'bg-purple-100 text-purple-700' : 'bg-red-100 text-red-700'}`}>{b.lead_type}</span></td>
                  <td className="px-3 py-3"><div className="font-medium text-sm">{cleanText(b.client_name)}</div><div className="text-[10px] text-gray-400 uppercase tracking-wide">Client</div></td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-sm text-gray-800">{cleanText(b.project_name) || cleanText(b.company_name) || '-'}</div>
                    {b.district && <div className="text-xs text-gray-500">{[cleanText(b.district), cleanText(b.state)].filter(Boolean).join(', ')}</div>}
                  </td>
                  <td className="px-3 py-3 text-sm">{b.category || '-'}</td>
                  <td className="px-3 py-3"><span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">{b.order_type}</span></td>
                  <td className="px-3 py-3 text-sm font-medium">{b.po_number || '-'}</td>
                  <td className="px-3 py-3 text-right font-semibold text-sm">{fmt(b.sale_amount_without_gst)}</td>
                  <td className="px-3 py-3 text-right text-sm text-emerald-600 font-medium">{fmt(b.advance_received)}</td>
                  <td className="px-3 py-3 text-right text-sm text-red-600 font-bold">{fmt(b.balance_amount)}</td>
                  <td className="px-3 py-3 text-sm">{b.employee_assigned || '-'}</td>
                  <td className="px-3 py-3"><StatusBadge status={b.status} /></td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => handleView(b)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="View"><FiEye size={15} /></button>
                      {b.working_sheet_link && (
                        <a href={b.working_sheet_link} target="_blank" rel="noreferrer" className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="Working Sheet">📎</a>
                      )}
                      {canEdit('business_book') && <button onClick={() => handleEdit(b)} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded" title="Edit"><FiEdit2 size={15} /></button>}
                      {canDelete('business_book') && <button onClick={() => handleDelete(b.id, b.lead_no)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={15} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan="13" className="text-center py-12 text-gray-400"><FiBook size={40} className="mx-auto mb-3 opacity-30" /><p className="font-medium">No entries found</p></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* View Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(null); setViewEntry(null); }} title={`${viewEntry?.lead_no || ''} - ${viewEntry?.client_name || ''}`} wide>
        {viewEntry && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between bg-gradient-to-r from-blue-50 to-blue-50 p-4 rounded-lg">
              <div>
                <h3 className="text-lg font-bold text-blue-900">{viewEntry.lead_no}</h3>
                <p className="text-sm text-red-600">{viewEntry.project_name || viewEntry.client_name}</p>
              </div>
              <div className="text-right">
                <StatusBadge status={viewEntry.status} />
                <span className={`ml-2 inline-flex px-2 py-0.5 rounded text-xs font-medium ${viewEntry.lead_type === 'Government' ? 'bg-purple-100 text-purple-700' : 'bg-red-100 text-red-700'}`}>{viewEntry.lead_type}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Sale Amount</p><p className="font-bold">{fmt(viewEntry.sale_amount_without_gst)}</p></div>
              <div className="bg-red-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">PO Amount</p><p className="font-bold text-red-700">{fmt(viewEntry.po_amount)}</p></div>
              <div className="bg-emerald-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Advance</p><p className="font-bold text-emerald-600">{fmt(viewEntry.advance_received)}</p></div>
              <div className="bg-red-50 p-3 rounded-lg text-center"><p className="text-xs text-gray-500">Balance</p><p className="font-bold text-red-600">{fmt(viewEntry.balance_amount)}</p></div>
            </div>
            <DSection title="Client & Company" items={[['Client', viewEntry.client_name], ['Company/Dept', viewEntry.company_name], ['Contact', viewEntry.client_contact], ['Client Email', viewEntry.client_email], ['Email', viewEntry.email_address], ['Source', viewEntry.source_of_enquiry], ['Customer Type', viewEntry.customer_type], ['Client Type', viewEntry.client_type], ['Customer Code', viewEntry.customer_code]]} />
            <DSection title="Location" items={[['District', viewEntry.district], ['State', viewEntry.state], ['State Code', viewEntry.state_code], ['GSTIN', viewEntry.gstin], ['Billing Address', viewEntry.billing_address], ['Shipping Address', viewEntry.shipping_address]]} />
            <DSection title="Project & Order" items={[['Project', viewEntry.project_name], ['Category', viewEntry.category], ['Order Type', viewEntry.order_type], ['PO Number', viewEntry.po_number], ['PO Date', viewEntry.po_date], ['Guarantee', viewEntry.guarantee_required], ['Guarantee %', viewEntry.guarantee_percentage], ['Penalty Clause', viewEntry.penalty_clause], ['Penalty Date', viewEntry.penalty_clause_date], ['Freight Extra', viewEntry.freight_extra]]} />
            <DSection title="Committed Dates" items={[['Start', viewEntry.committed_start_date], ['Delivery', viewEntry.committed_delivery_date], ['Completion', viewEntry.committed_completion_date]]} />
            <DSection title="People" items={[['Employee', viewEntry.employee_assigned], ['Lead By', viewEntry.lead_by], ['Management Person', viewEntry.management_person_name], ['Mgmt Contact', viewEntry.management_person_contact], ['Operations Person', viewEntry.operations_person_name], ['Ops Contact', viewEntry.operations_person_contact], ['PMC Person', viewEntry.pmc_person_name], ['PMC Contact', viewEntry.pmc_person_contact], ['Architect', viewEntry.architect_person_name], ['Architect Contact', viewEntry.architect_person_contact], ['Accounts Person', viewEntry.accounts_person_name], ['Accounts Contact', viewEntry.accounts_person_contact]]} />
            <DSection title="TPA Details" items={[['TPA Items Count', viewEntry.tpa_items_count], ['TPA Qty', viewEntry.tpa_items_qty], ['TPA Material', fmt(viewEntry.tpa_material_amount)], ['TPA Labour', fmt(viewEntry.tpa_labour_amount)], ['Accessory Amt', fmt(viewEntry.accessory_amount)], ['Labour/Day', viewEntry.required_labour_per_day], ['Actual Margin %', viewEntry.actual_margin_pct]]} />
            <DSection title="Payment Terms" items={[['Advance', viewEntry.payment_advance], ['Against Delivery', viewEntry.payment_against_delivery], ['Against Installation', viewEntry.payment_against_installation], ['Against Commissioning', viewEntry.payment_against_commissioning], ['Retention', viewEntry.payment_retention], ['Credit', viewEntry.payment_credit], ['Credit Days', viewEntry.credit_days]]} />
            {viewEntry.remarks && <div className="bg-yellow-50 p-3 rounded-lg"><p className="text-xs font-semibold text-yellow-700 mb-1">Remarks</p><p className="text-sm">{viewEntry.remarks}</p></div>}
            <div className="text-xs text-gray-400 text-right">Created: {viewEntry.created_at}</div>
          </div>
        )}
      </Modal>

      {/* Add/Edit Modal */}
      <Modal isOpen={modal === 'add' || modal === 'edit'} onClose={() => { setModal(null); setForm({ ...emptyForm }); }}
        title={modal === 'edit' ? `Edit - ${form.lead_no || ''}` : 'New Business Book Entry'} wide>
        <form onSubmit={handleSave} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {modal === 'add' && <p className="text-xs text-emerald-600 bg-emerald-50 p-2 rounded font-medium">Lead No. auto-generated. Auto-creates: Order Planning + DPR Site + Receivable + Cash Flow.</p>}

          {/* 1. Client */}
          <FSection title="Client & Company Details" color="gray">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Sel label="Lead Type" value={form.lead_type} onChange={v => F('lead_type', v)} options={LEAD_TYPES} />
              <Inp label="Client Name *" value={form.client_name} onChange={v => F('client_name', v)} required />
              <Inp label="Company/Department" value={form.company_name} onChange={v => F('company_name', v)} />
              <Inp label="Client Contact No." value={form.client_contact} onChange={v => F('client_contact', v)} />
              <Inp label="Client Email ID" value={form.client_email} onChange={v => F('client_email', v)} />
              <Inp label="Email Address" value={form.email_address} onChange={v => F('email_address', v)} />
              <Sel label="Source of Enquiry" value={form.source_of_enquiry} onChange={v => F('source_of_enquiry', v)} options={SOURCES} blank="Select" />
              <Inp label="Customer Type" value={form.customer_type} onChange={v => F('customer_type', v)} placeholder="Hospital, Factory..." />
              <Inp label="Client Type" value={form.client_type} onChange={v => F('client_type', v)} />
              <Inp label="Customer Code" value={form.customer_code} onChange={v => F('customer_code', v)} />
            </div>
          </FSection>

          {/* 2. Location */}
          <FSection title="Location & Address" color="gray">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="label">State</label>
                <SearchableSelect
                  options={STATES.map(s => ({ value: s, label: s }))}
                  value={form.state} valueKey="value" displayKey="label"
                  placeholder="Pick state"
                  onChange={(opt) => { F('state', opt?.value || ''); F('district', ''); }}
                />
              </div>
              <div>
                <label className="label">District</label>
                <SearchableSelect
                  options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                  value={form.district} valueKey="value" displayKey="label"
                  placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                  onChange={(opt) => F('district', opt?.value || '')}
                />
              </div>
              <Inp label="State Code" value={form.state_code} onChange={v => F('state_code', v)} placeholder="e.g. 03" />
              {/* GSTIN feeds into the auto-generated Sales Bill / Tax
                  Invoice. Punjab GSTINs start with 03; verify the format
                  is 15 chars (2 digit state + 10 char PAN + entity code +
                  Z + checksum). */}
              <Inp label="Client GSTIN" value={form.gstin} onChange={v => F('gstin', v)} placeholder="e.g. 03AABCS1234A1Z5" />
              <Inp label="Billing Address" value={form.billing_address} onChange={v => F('billing_address', v)} />
              <div className="col-span-2"><Inp label="Shipping / Site Address" value={form.shipping_address} onChange={v => F('shipping_address', v)} /></div>
            </div>
          </FSection>

          {/* 3. Project & Order + PO */}
          <FSection title="Project, Order & PO Details" color="blue">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Project Name" value={form.project_name} onChange={v => F('project_name', v)} />
              <Sel label="Order Type" value={form.order_type} onChange={v => F('order_type', v)} options={ORDER_TYPES} />
              <Sel label="Category" value={form.category} onChange={v => F('category', v)} options={CATEGORIES} blank="Select" />
              <Sel label="Guarantee Required" value={form.guarantee_required} onChange={v => F('guarantee_required', v)} options={['No', 'Yes']} />
              {form.guarantee_required === 'Yes' && <Inp label="Guarantee %" value={form.guarantee_percentage} onChange={v => F('guarantee_percentage', v)} />}
              <Sel label="Penalty Clause" value={form.penalty_clause} onChange={v => F('penalty_clause', v)} options={['No', 'Yes']} />
              {form.penalty_clause === 'Yes' && <Inp label="Penalty Date" value={form.penalty_clause_date} onChange={v => F('penalty_clause_date', v)} type="date" />}
              <Sel label="Freight Extra" value={form.freight_extra} onChange={v => F('freight_extra', v)} options={['No', 'Yes']} />
              <Inp label="PO Number" value={form.po_number} onChange={v => F('po_number', v)} />
              <Inp label="PO Date" value={form.po_date} onChange={v => F('po_date', v)} type="date" />
            </div>
          </FSection>

          {/* 4. Financial */}
          <FSection title="Financial Details" color="emerald">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Sale Amount (Without GST)" value={form.sale_amount_without_gst} onChange={v => F('sale_amount_without_gst', +v)} type="number" />
              {/* PO Amount auto-computes as Sale × 1.18 — display only.
                  Mam (2026-05-21): "all business book = sales without
                  gst + (sales without gst *18%)". */}
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                  PO Amount (With GST)
                  <span className="ml-1 normal-case font-normal text-emerald-700">· auto = Sale × 1.18</span>
                </label>
                <input
                  type="number"
                  value={form.po_amount || 0}
                  readOnly
                  className="w-full px-3 py-2 border border-emerald-200 bg-emerald-50 rounded-lg text-sm font-semibold text-emerald-900 cursor-not-allowed"
                  title="Auto-computed from Sale Amount × 1.18"
                />
              </div>
              <Inp label="Advance Received" value={form.advance_received} onChange={v => F('advance_received', +v)} type="number" />
              <Inp label="Accessory Amount" value={form.accessory_amount} onChange={v => F('accessory_amount', +v)} type="number" />
              <Inp label="Actual Margin %" value={form.actual_margin_pct} onChange={v => F('actual_margin_pct', +v)} type="number" />
            </div>
          </FSection>

          {/* 5. Payment Terms */}
          <FSection title="Payment Terms" color="indigo">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Advance" value={form.payment_advance} onChange={v => F('payment_advance', v)} placeholder="%" />
              <Inp label="Against Delivery" value={form.payment_against_delivery} onChange={v => F('payment_against_delivery', v)} placeholder="%" />
              <Inp label="Against Installation" value={form.payment_against_installation} onChange={v => F('payment_against_installation', v)} placeholder="%" />
              <Inp label="Against Commissioning" value={form.payment_against_commissioning} onChange={v => F('payment_against_commissioning', v)} placeholder="%" />
              <Inp label="Retention" value={form.payment_retention} onChange={v => F('payment_retention', v)} placeholder="%" />
              <Inp label="Credit" value={form.payment_credit} onChange={v => F('payment_credit', v)} placeholder="%" />
              <Inp label="Credit Days" value={form.credit_days} onChange={v => F('credit_days', +v)} type="number" />
            </div>
          </FSection>

          {/* 6. Dates */}
          <FSection title="Committed Dates" color="amber">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Committed Start" value={form.committed_start_date} onChange={v => F('committed_start_date', v)} type="date" />
              <Inp label="Committed Delivery" value={form.committed_delivery_date} onChange={v => F('committed_delivery_date', v)} type="date" />
              <Inp label="Committed Completion" value={form.committed_completion_date} onChange={v => F('committed_completion_date', v)} type="date" />
            </div>
          </FSection>

          {/* 7. People */}
          <FSection title="People & Contacts" color="purple">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="Employee Name" value={form.employee_assigned} onChange={v => F('employee_assigned', v)} />
              <Inp label="Lead By" value={form.lead_by} onChange={v => F('lead_by', v)} />
              <div></div>
              <Inp label="Management Person" value={form.management_person_name} onChange={v => F('management_person_name', v)} />
              <Inp label="Management Contact" value={form.management_person_contact} onChange={v => F('management_person_contact', v)} />
              <div></div>
              <Inp label="Operations Person" value={form.operations_person_name} onChange={v => F('operations_person_name', v)} />
              <Inp label="Operations Contact" value={form.operations_person_contact} onChange={v => F('operations_person_contact', v)} />
              <div></div>
              <Inp label="PMC Person" value={form.pmc_person_name} onChange={v => F('pmc_person_name', v)} />
              <Inp label="PMC Contact" value={form.pmc_person_contact} onChange={v => F('pmc_person_contact', v)} />
              <div></div>
              <Inp label="Architect Person" value={form.architect_person_name} onChange={v => F('architect_person_name', v)} />
              <Inp label="Architect Contact" value={form.architect_person_contact} onChange={v => F('architect_person_contact', v)} />
              <div></div>
              <Inp label="Accounts Person" value={form.accounts_person_name} onChange={v => F('accounts_person_name', v)} />
              <Inp label="Accounts Contact" value={form.accounts_person_contact} onChange={v => F('accounts_person_contact', v)} />
            </div>
          </FSection>

          {/* 8. TPA */}
          <FSection title="TPA Details" color="rose">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <Inp label="TPA Items Count" value={form.tpa_items_count} onChange={v => F('tpa_items_count', +v)} type="number" />
              <Inp label="Total Qty (TPA Items)" value={form.tpa_items_qty} onChange={v => F('tpa_items_qty', v)} />
              <Inp label="TPA Material Amount" value={form.tpa_material_amount} onChange={v => F('tpa_material_amount', +v)} type="number" />
              <Inp label="TPA Labour Amount" value={form.tpa_labour_amount} onChange={v => F('tpa_labour_amount', +v)} type="number" />
              <Inp label="Required Labour Per Day" value={form.required_labour_per_day} onChange={v => F('required_labour_per_day', v)} />
            </div>
          </FSection>

          {/* 9. Final Drawing Upload */}
          <FSection title="Final Drawing" color="gray">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload Final Drawing</label>
                {form.final_drawing_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.final_drawing_link} target="_blank" rel="noreferrer" className="text-sm text-red-600 underline truncate flex-1">
                      {form.final_drawing_link.split('/').pop()}
                    </a>
                    <button type="button" onClick={() => F('final_drawing_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.jpg,.jpeg,.png"
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        F('final_drawing_link', res.data.url);
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
                )}
              </div>
            </div>
          </FSection>

          {/* 10. Working Sheet Upload — mam: 'upload here file option call
              working sheet'. Per-entry costing/calculation document (Excel /
              PDF) attached to each booked order. */}
          <FSection title="Working Sheet" color="blue">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="label flex items-center gap-2"><FiUpload size={14} /> Upload Working Sheet</label>
                {form.working_sheet_link ? (
                  <div className="flex items-center gap-2">
                    <a href={form.working_sheet_link} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline truncate flex-1">
                      📎 {form.working_sheet_link.split('/').pop()}
                    </a>
                    <button type="button" onClick={() => F('working_sheet_link', '')} className="text-red-500 text-xs hover:underline">Remove</button>
                  </div>
                ) : (
                  <input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png"
                    onChange={async (e) => {
                      const file = e.target.files[0]; if (!file) return;
                      try {
                        const fd = new FormData(); fd.append('file', file);
                        const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        F('working_sheet_link', res.data.url);
                        toast.success(`Uploaded: ${res.data.filename}`);
                      } catch { toast.error('Upload failed'); }
                      e.target.value = '';
                    }}
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
                )}
                <p className="text-[10px] text-gray-500 mt-1">Costing / calculation sheet for this order (Excel, PDF, CSV, image).</p>
              </div>
            </div>
          </FSection>

          {/* Status (edit only) */}
          {modal === 'edit' && <Sel label="Status" value={form.status} onChange={v => F('status', v)} options={STATUSES} />}

          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks || ''} onChange={e => F('remarks', e.target.value)} /></div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={() => { setModal(null); setForm({ ...emptyForm }); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{modal === 'edit' ? 'Update Entry' : 'Create Business Entry'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// Reusable components
function StatCard({ icon: Icon, color, label, value, valueColor }) {
  return (
    <div className={`card p-4 border-l-4 border-${color}-500`}>
      <div className="flex items-center gap-3">
        <div className={`p-2 bg-${color}-50 rounded-lg`}><Icon className={`text-${color}-600`} size={20} /></div>
        <div><p className="text-xs text-gray-500 font-medium">{label}</p><p className={`text-xl font-bold ${valueColor || 'text-gray-900'}`}>{value}</p></div>
      </div>
    </div>
  );
}

function FSection({ title, color, children }) {
  const bg = { gray: 'bg-gray-50', blue: 'bg-red-50', emerald: 'bg-emerald-50', amber: 'bg-amber-50', purple: 'bg-purple-50', indigo: 'bg-red-50', rose: 'bg-rose-50' };
  const text = { gray: 'text-gray-700', blue: 'text-red-700', emerald: 'text-emerald-700', amber: 'text-amber-700', purple: 'text-purple-700', indigo: 'text-red-700', rose: 'text-rose-700' };
  return (<div className={`border rounded-lg p-3 ${bg[color] || 'bg-gray-50'}`}><h4 className={`font-semibold text-sm ${text[color] || 'text-gray-700'} mb-3`}>{title}</h4>{children}</div>);
}

function DSection({ title, items }) {
  const filtered = items.filter(([, v]) => v && v !== '-' && v !== 0 && v !== 'Rs 0');
  if (filtered.length === 0) return null;
  return (<div className="border rounded-lg p-3"><h4 className="font-semibold text-sm text-gray-700 mb-2">{title}</h4><div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">{filtered.map(([l, v]) => <div key={l}><p className="text-xs text-gray-400">{l}</p><p className="text-sm font-medium">{v}</p></div>)}</div></div>);
}

function Inp({ label, value, onChange, type = 'text', required, placeholder }) {
  return (<div><label className="label">{label}</label><input className="input" type={type} value={value || ''} onChange={e => onChange(e.target.value)} required={required} placeholder={placeholder} /></div>);
}

function Sel({ label, value, onChange, options, blank }) {
  return (<div><label className="label">{label}</label><select className="select" value={value || ''} onChange={e => onChange(e.target.value)}>{blank && <option value="">{blank}</option>}{options.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select></div>);
}
