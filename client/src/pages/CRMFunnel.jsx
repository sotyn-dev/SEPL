import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiExternalLink, FiTarget } from 'react-icons/fi';

const fmt = (n) => 'Rs ' + Math.abs(Math.round(+n || 0)).toLocaleString('en-IN');
import { useAuth } from '../context/AuthContext';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

// CRM Sales Funnel FMS — flat 3-step tracker. Step 1: Quotation submit.
// Step 2: Negotiation. Step 3: Win/Loss. Mam's columns from her sheet:
// Lead Number, Client, Company, Mobile, Email, Source, Address, State,
// Remarks, Category, Type, Cust BOQ, Quotation Link, Amount, Submit Y/N,
// Negotiation Status, Amount, Win/Loss, Reason if Loss.

const CATEGORIES = ['Hospital', 'Hotel', 'Office', 'Industrial', 'Residential', 'Retail', 'Educational', 'Government', 'Other'];
const SOURCES = ['Reference', 'Website', 'Existing Client', 'Cold Call', 'Tender Portal', 'Walk-in', 'Other'];
const TYPES = ['Private', 'Government'];
const NEG_STATUSES = [
  { v: 'in_progress', l: 'In Progress' },
  { v: 'hold', l: 'On Hold' },
  { v: 'done', l: 'Done' },
  { v: 'dropped', l: 'Dropped' },
];

const blank = () => ({
  client_name: '', company_name: '', mobile: '', email: '', source: '',
  address: '', state: '', district: '', remarks: '', category: '', type: '',
  cust_boq_link: '', quotation_link: '', quotation_amount: 0, quotation_submitted: false,
  negotiation_status: '', negotiation_amount: 0, negotiation_remarks: '',
  final_status: '', loss_reason: '',
});

export default function CRMFunnel() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: '', step: 'all', state: '', type: '' });
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const params = {};
    if (filter.q) params.q = filter.q;
    if (filter.step !== 'all') params.step = filter.step;
    if (filter.state) params.state = filter.state;
    if (filter.type) params.type = filter.type;
    api.get('/crm-funnel', { params }).then(r => setRows(r.data))
      .catch(e => toast.error(e.response?.data?.error || 'Load failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter.q, filter.step, filter.state, filter.type]);

  const openAdd = () => { setEditing(null); setForm(blank()); setModal(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ ...row, quotation_submitted: !!row.quotation_submitted });
    setModal(true);
  };
  const districtOptions = form.state ? (DISTRICTS_BY_STATE[form.state] || []) : [];

  const save = async (e) => {
    e.preventDefault();
    if (!form.client_name?.trim()) { toast.error('Client name is required'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/crm-funnel/${editing.id}`, form);
        toast.success('Updated');
      } else {
        await api.post('/crm-funnel', form);
        toast.success('Added');
      }
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!confirm(`Delete "${row.client_name}" (${row.lead_no})?`)) return;
    try {
      await api.delete(`/crm-funnel/${row.id}`);
      toast.success('Deleted'); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const stepBadge = (r) => {
    if (r.final_status === 'win') return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-emerald-100 text-emerald-800">WIN</span>;
    if (r.final_status === 'loss') return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-red-100 text-red-700">LOSS</span>;
    if (r.quotation_submitted) return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-amber-100 text-amber-800">STEP 2 · NEGOTIATION</span>;
    return <span className="px-2 py-0.5 text-[10px] rounded font-medium bg-blue-100 text-blue-700">STEP 1 · QUOTATION</span>;
  };

  // Metrics — counts mirror the existing 11-stage Sales Funnel dashboard so
  // mam recognises the layout. Win/Loss/Win-rate use final_status; This
  // Month uses created_at falling in the current calendar month.
  const now = new Date();
  const thisMonth = rows.filter(r => {
    if (!r.created_at) return false;
    const d = new Date(r.created_at.replace(' ', 'T'));
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const won = rows.filter(r => r.final_status === 'win');
  const lost = rows.filter(r => r.final_status === 'loss');
  const winAmount = won.reduce((s, r) => s + (+r.negotiation_amount || +r.quotation_amount || 0), 0);
  const winRate = rows.length > 0 ? Math.round((won.length / rows.length) * 100) : 0;
  const stepCount = (key) => key === 'all' ? rows.length :
    key === '1' ? rows.filter(r => !r.quotation_submitted).length :
    key === '2' ? rows.filter(r => r.quotation_submitted && !r.final_status).length :
    rows.filter(r => r.final_status === 'win' || r.final_status === 'loss').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-800 flex items-center gap-2"><FiTarget /> CRM Sales Funnel</h3>
          <p className="text-xs text-gray-500">Flat 3-step tracker: Quotation → Negotiation → Win/Loss</p>
        </div>
        {canCreate('crm_funnel') && (
          <button onClick={openAdd} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Lead</button>
        )}
      </div>

      {/* Step pill tabs — same visual style as the existing Sales Funnel
          stage tabs. Each pill is a step + count chip; click to filter. */}
      <div className="flex gap-2 flex-wrap items-center">
        {[
          { key: 'all', label: 'All Leads', chipCls: 'bg-gray-500' },
          { key: '1', label: 'Step 1 — Quotation', chipCls: 'bg-blue-500' },
          { key: '2', label: 'Step 2 — Negotiation', chipCls: 'bg-amber-500' },
          { key: '3', label: 'Step 3 — Win / Loss', chipCls: 'bg-emerald-500' },
        ].map(s => {
          const isActive = filter.step === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setFilter(f => ({ ...f, step: s.key }))}
              className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
            >
              {s.label}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center text-white ${isActive ? 'bg-white/30' : s.chipCls}`}>
                {stepCount(s.key)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Metric cards — match the existing Sales Funnel dashboard 5-card
          layout (Total / This Month / Won / Lost / Win Rate). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Total Leads</p><p className="text-3xl font-extrabold text-red-600">{rows.length}</p></div>
        <div className="card p-4 border-l-4 border-purple-500"><p className="text-[10px] text-gray-500 font-bold uppercase">This Month</p><p className="text-3xl font-extrabold text-purple-600">{thisMonth}</p></div>
        <div className="card p-4 border-l-4 border-emerald-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Won Deals</p><p className="text-3xl font-extrabold text-emerald-600">{won.length}</p>{winAmount > 0 && <p className="text-xs text-emerald-500">{fmt(winAmount)}</p>}</div>
        <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Lost</p><p className="text-3xl font-extrabold text-red-600">{lost.length}</p></div>
        <div className="card p-4 border-l-4 border-amber-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Win Rate</p><p className="text-3xl font-extrabold text-amber-600">{winRate}%</p></div>
      </div>

      <div className="card p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <input className="input text-sm" placeholder="Search client / company / mobile / lead#"
          value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        <select className="select text-sm" value={filter.state} onChange={e => setFilter(f => ({ ...f, state: e.target.value }))}>
          <option value="">All states</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select text-sm" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
          <option value="">All types</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="select text-sm" value={filter.step} onChange={e => setFilter(f => ({ ...f, step: e.target.value }))}>
          <option value="all">All steps</option>
          <option value="1">Step 1 — Quotation</option>
          <option value="2">Step 2 — Negotiation</option>
          <option value="3">Step 3 — Win/Loss</option>
        </select>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Lead #</th><th>Client</th><th>Company</th><th>Mobile</th><th>Source</th>
              <th>Type</th><th>Category</th><th>State</th>
              <th>BOQ</th><th>Quote</th><th>Qty Amount</th>
              <th>Neg Status</th><th>Neg Amount</th>
              <th>Stage</th><th>Loss Reason</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="16" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan="16" className="text-center py-8 text-gray-400">
                No leads yet. Click <b>+ Add Lead</b>.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.lead_no}</td>
                <td className="font-medium">{r.client_name}</td>
                <td>{r.company_name || '-'}</td>
                <td>{r.mobile || '-'}</td>
                <td>{r.source || '-'}</td>
                <td>{r.type || '-'}</td>
                <td>{r.category || '-'}</td>
                <td>{r.state || '-'}</td>
                <td>{r.cust_boq_link ? <a className="text-red-600 hover:underline" href={r.cust_boq_link} target="_blank" rel="noreferrer"><FiExternalLink size={12} className="inline" /></a> : '-'}</td>
                <td>{r.quotation_link ? <a className="text-red-600 hover:underline" href={r.quotation_link} target="_blank" rel="noreferrer"><FiExternalLink size={12} className="inline" /></a> : '-'}</td>
                <td>{r.quotation_amount ? `Rs ${(+r.quotation_amount).toLocaleString('en-IN')}` : '-'}</td>
                <td>{NEG_STATUSES.find(s => s.v === r.negotiation_status)?.l || '-'}</td>
                <td>{r.negotiation_amount ? `Rs ${(+r.negotiation_amount).toLocaleString('en-IN')}` : '-'}</td>
                <td>{stepBadge(r)}</td>
                <td className="text-xs text-gray-600 max-w-[180px] truncate" title={r.loss_reason}>{r.loss_reason || '-'}</td>
                <td>
                  <div className="flex gap-1">
                    {canEdit('crm_funnel') && <button onClick={() => openEdit(r)} className="p-1 text-gray-500 hover:text-red-600" title="Edit"><FiEdit2 size={14} /></button>}
                    {canDelete('crm_funnel') && <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? `Edit Lead — ${editing.lead_no}` : 'Add CRM Lead'} wide>
        <form onSubmit={save} className="space-y-4">
          {/* Lead capture */}
          <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Lead Details</h4></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Client Name <span className="text-red-500">*</span></label>
              <input className="input" value={form.client_name} onChange={e => setForm({ ...form, client_name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Company Name</label>
              <input className="input" value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Mobile Number</label>
              <input className="input" type="tel" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="label">Source of Enquiry</label>
              <select className="select" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}>
                <option value="">Select</option>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Type</label>
              <select className="select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                <option value="">Select</option>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="">Select</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Address</label>
              <input className="input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label className="label">State</label>
              <SearchableSelect options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })} />
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect options={districtOptions.map(d => ({ value: d, label: d }))}
                value={form.district} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Remarks</label>
              <textarea className="input" rows="2" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
            </div>
          </div>

          {/* Steps 1/2/3 only show when editing an existing lead. On Add,
              mam doesn't yet have a quotation, negotiation, or final
              status — she'll fill those in later by editing the row.
              Mam: "dont here entry step 1 step 2 step 3". */}
          {editing && (
            <>
              {/* Step 1 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 1 — Quotation</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Customer BOQ Link</label>
                  <input className="input text-sm" placeholder="https://…" value={form.cust_boq_link} onChange={e => setForm({ ...form, cust_boq_link: e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Link</label>
                  <input className="input text-sm" placeholder="https://…" value={form.quotation_link} onChange={e => setForm({ ...form, quotation_link: e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Amount (Rs)</label>
                  <input className="input" type="number" min="0" value={form.quotation_amount} onChange={e => setForm({ ...form, quotation_amount: +e.target.value })} />
                </div>
                <div>
                  <label className="label">Quotation Submitted?</label>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input type="checkbox" checked={!!form.quotation_submitted} onChange={e => setForm({ ...form, quotation_submitted: e.target.checked })} className="w-4 h-4" />
                    <span className="text-sm">Yes — submitted to client</span>
                  </label>
                </div>
              </div>

              {/* Step 2 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 2 — Negotiation</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Negotiation Status</label>
                  <select className="select" value={form.negotiation_status} onChange={e => setForm({ ...form, negotiation_status: e.target.value })}>
                    <option value="">Not started</option>
                    {NEG_STATUSES.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Negotiation Amount (Rs)</label>
                  <input className="input" type="number" min="0" value={form.negotiation_amount} onChange={e => setForm({ ...form, negotiation_amount: +e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Negotiation Remarks</label>
                  <textarea className="input" rows="2" value={form.negotiation_remarks} onChange={e => setForm({ ...form, negotiation_remarks: e.target.value })} />
                </div>
              </div>

              {/* Step 3 */}
              <div className="border-b pb-2"><h4 className="font-semibold text-sm text-red-700">Step 3 — Win / Loss</h4></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Final Status</label>
                  <select className="select" value={form.final_status} onChange={e => setForm({ ...form, final_status: e.target.value })}>
                    <option value="">Still open</option>
                    <option value="win">Win</option>
                    <option value="loss">Loss</option>
                  </select>
                </div>
                {form.final_status === 'loss' && (
                  <div>
                    <label className="label">Reason if Loss</label>
                    <input className="input" value={form.loss_reason} onChange={e => setForm({ ...form, loss_reason: e.target.value })} placeholder="e.g. price, timeline, scope mismatch" />
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : (editing ? 'Update' : 'Add')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
