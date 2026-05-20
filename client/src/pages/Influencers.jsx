// Influencer / Referral Partner module — mam (2026-05-20):
// "make new influencer Sheet add fields according to sheet. and same
// as upload can bulk and can download also".
//
// Fields mirror the 6-section Excel form mam shared:
//   1. Basic Identity · 2. Professional Category · 3. Company
//   4. Contact · 5. Digital Presence · 6. Relationship + BI
//
// UX:
//   - Searchable list with category / city / stage filters
//   - +Add modal with 6 collapsible sections (mirrors Excel sections)
//   - Template / Import / Export buttons match Fire NOC import flow

import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiDownload, FiUpload } from 'react-icons/fi';

const CATEGORIES = ['Architect', 'Interior Designer', 'MEP Consultant', 'Builder / Developer', 'Channel Partner', 'Influencer', 'Vendor', 'Others'];
const STAGES = ['Prospect', 'First Meeting Done', 'Active', 'Dormant', 'VIP', 'Lost'];
const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'Er', 'Adv', 'CA', 'Prof'];
const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];
const ROLES = ['Decision Maker', 'Influencer', 'Recommender', 'End User'];
const COMPANY_SIZES = ['Solo / Freelancer', '2-10', '10-50', '50-200', '200+'];
const CONTACT_METHODS = ['Phone', 'WhatsApp', 'Email', 'In-Person', 'LinkedIn'];
const PAYMENT_BEHAVIOR = ['Prompt', 'Delayed (30-60d)', 'Delayed (60+d)', 'Disputes Common', 'No History'];

const empty = {
  salutation: '', full_name: '', date_of_birth: '', anniversary_date: '', gender: '', hometown: '',
  primary_category: '', primary_category_other: '', years_in_industry: '', decision_making_role: '',
  company_name: '', designation: '', company_size: '', year_established: '',
  office_address: '', city: '', pincode: '', gst_number: '', website: '',
  primary_mobile: '', secondary_mobile: '', whatsapp_number: '', office_landline: '',
  personal_email: '', office_email: '', preferred_contact_method: '', best_time_to_call: '',
  linkedin_url: '', facebook_url: '', instagram_handle: '', twitter_handle: '',
  youtube_channel: '', google_business_profile: '', other_listings: '',
  source_of_contact: '', referred_by: '', first_meeting_date: '', relationship_stage: '',
  typical_project_type: '', typical_project_value_range: '',
  past_projects_count: 0, past_projects_total_value: 0, ongoing_projects_with_us: 0,
  client_payment_behavior: '', commission_terms: '', competitors: '',
  date_of_entry: new Date().toISOString().slice(0, 10), entered_by: '', assigned_relationship_manager: '',
};

export default function Influencers() {
  const { user, canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStage, setFilterStage] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ ...empty });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const load = () => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filterCategory) params.set('primary_category', filterCategory);
    if (filterStage) params.set('relationship_stage', filterStage);
    api.get(`/influencers?${params}`).then(r => setRows(r.data)).catch(() => {});
  };
  useEffect(load, [search, filterCategory, filterStage]);

  const openAdd = () => {
    setEditing(null);
    setForm({ ...empty, entered_by: user?.name || '' });
    setModal(true);
  };
  const openEdit = (row) => {
    setEditing(row);
    setForm({ ...empty, ...row });
    setModal(true);
  };
  const save = async (e) => {
    e.preventDefault();
    if (!form.full_name?.trim()) return toast.error('Full Name is required');
    if (!form.primary_mobile?.trim()) return toast.error('Primary Mobile is required');
    try {
      if (editing) {
        await api.put(`/influencers/${editing.id}`, form);
        toast.success('Updated');
      } else {
        await api.post('/influencers', form);
        toast.success('Added');
      }
      setModal(false); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    }
  };
  const remove = async (row) => {
    if (!confirm(`Delete "${row.full_name}" (${row.form_id})?`)) return;
    try { await api.delete(`/influencers/${row.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const downloadTemplate = async () => {
    try {
      const r = await api.get('/influencers/import/template', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = 'influencers-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast.error('Could not download template'); }
  };
  const downloadExport = async () => {
    try {
      const r = await api.get('/influencers/export', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `influencers-${new Date().toISOString().slice(0,10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast.error('Export failed'); }
  };
  const handleImport = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setImporting(true); setImportResult(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api.post('/influencers/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(r.data);
      const { created_count, failed_count, total_rows } = r.data;
      toast[failed_count === 0 ? 'success' : 'error'](`Imported ${created_count}/${total_rows} · ${failed_count} skipped`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally { setImporting(false); }
  };

  const F = (k, v) => setForm({ ...form, [k]: v });
  const Field = ({ label, k, type = 'text', children, full }) => (
    <div className={full ? 'col-span-2' : ''}>
      <label className="label">{label}</label>
      {children ?? (
        <input className="input" type={type} value={form[k] ?? ''} onChange={e => F(k, type === 'number' ? +e.target.value : e.target.value)} />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Influencers & Referral Partners</h1>
          <p className="text-xs text-gray-500 mt-0.5">MEP Contractor — Business Development Database · 6-section profile per partner</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={downloadExport} className="btn btn-secondary text-sm flex items-center gap-1.5"><FiDownload size={13}/> Export Excel</button>
          {canCreate('influencers') && (
            <>
              <button onClick={downloadTemplate} className="btn btn-secondary text-sm flex items-center gap-1.5" title="Download .xlsx template with all 35+ fields"><FiDownload size={13}/> Template</button>
              <label className={`btn btn-secondary text-sm flex items-center gap-1.5 cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
                <FiUpload size={13}/> {importing ? 'Importing…' : 'Import Excel'}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} className="hidden" />
              </label>
              <button onClick={openAdd} className="btn btn-primary text-sm flex items-center gap-1.5"><FiPlus size={13}/> Add Influencer</button>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9 text-sm" placeholder="Search name / company / mobile / form ID / email…"
                 value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="select text-sm w-44" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="select text-sm w-44" value={filterStage} onChange={e => setFilterStage(e.target.value)}>
          <option value="">All stages</option>
          {STAGES.map(s => <option key={s}>{s}</option>)}
        </select>
        <span className="text-xs text-gray-500">{rows.length} record{rows.length === 1 ? '' : 's'}</span>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-xs w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-2 py-2 text-left">Form ID</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2 text-left">Category</th>
              <th className="px-2 py-2 text-left">Company</th>
              <th className="px-2 py-2 text-left">Mobile</th>
              <th className="px-2 py-2 text-left">City</th>
              <th className="px-2 py-2 text-left">Stage</th>
              <th className="px-2 py-2 text-right">Past Projects</th>
              <th className="px-2 py-2 text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan="9" className="text-center text-gray-400 py-8">No influencers yet — click "Add Influencer" or import via Excel.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="border-t hover:bg-blue-50/30">
                <td className="px-2 py-1.5 font-mono text-blue-700 font-semibold">{r.form_id}</td>
                <td className="px-2 py-1.5">
                  <div className="font-medium">{r.salutation ? `${r.salutation}. ` : ''}{r.full_name}</div>
                  {r.designation && <div className="text-[10px] text-gray-500">{r.designation}</div>}
                </td>
                <td className="px-2 py-1.5">{r.primary_category || <span className="text-gray-300">—</span>}</td>
                <td className="px-2 py-1.5">{r.company_name || <span className="text-gray-300">—</span>}</td>
                <td className="px-2 py-1.5 font-mono">{r.primary_mobile}</td>
                <td className="px-2 py-1.5">{r.city || <span className="text-gray-300">—</span>}</td>
                <td className="px-2 py-1.5">
                  {r.relationship_stage ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-semibold uppercase">{r.relationship_stage}</span>
                  ) : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right">{r.past_projects_count || 0}</td>
                <td className="px-2 py-1.5 text-center">
                  <div className="flex gap-1 justify-center">
                    {canEdit('influencers') && (
                      <button onClick={() => openEdit(r)} className="p-1 text-gray-400 hover:text-blue-700" title="Edit"><FiEdit2 size={13}/></button>
                    )}
                    {canDelete('influencers') && (
                      <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={13}/></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? `Edit ${editing.form_id} — ${editing.full_name}` : 'Add Influencer'} wide>
        <form onSubmit={save} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* SECTION 1 · Basic Identity */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">1 · Basic Identity</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Salutation</label>
                <select className="select" value={form.salutation || ''} onChange={e => F('salutation', e.target.value)}>
                  <option value="">—</option>
                  {SALUTATIONS.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label">Full Name <span className="text-red-500">*</span></label>
                <input className="input" required value={form.full_name || ''} onChange={e => F('full_name', e.target.value)} />
              </div>
              <Field label="Date of Birth" k="date_of_birth" type="date" />
              <Field label="Anniversary Date" k="anniversary_date" type="date" />
              <div>
                <label className="label">Gender</label>
                <select className="select" value={form.gender || ''} onChange={e => F('gender', e.target.value)}>
                  <option value="">—</option>
                  {GENDERS.map(g => <option key={g}>{g}</option>)}
                </select>
              </div>
              <Field label="Hometown / Native Place" k="hometown" full />
            </div>
          </div>

          {/* SECTION 2 · Professional Category */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">2 · Professional Category</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Primary Category <span className="text-red-500">*</span></label>
                <select className="select" value={form.primary_category || ''} onChange={e => F('primary_category', e.target.value)}>
                  <option value="">—</option>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              {form.primary_category === 'Others' && (
                <Field label="If 'Others' — Specify" k="primary_category_other" />
              )}
              <Field label="Years in Industry" k="years_in_industry" type="number" />
              <div>
                <label className="label">Decision-Making Role</label>
                <select className="select" value={form.decision_making_role || ''} onChange={e => F('decision_making_role', e.target.value)}>
                  <option value="">—</option>
                  {ROLES.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* SECTION 3 · Company / Firm */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">3 · Company / Firm Details</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Company / Firm Name" k="company_name" />
              <Field label="Designation" k="designation" />
              <div>
                <label className="label">Company Size</label>
                <select className="select" value={form.company_size || ''} onChange={e => F('company_size', e.target.value)}>
                  <option value="">—</option>
                  {COMPANY_SIZES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <Field label="Year Established" k="year_established" type="number" />
              <Field label="Office Address" k="office_address" full />
              <Field label="City" k="city" />
              <Field label="Pincode" k="pincode" />
              <Field label="GST Number" k="gst_number" />
              <Field label="Website" k="website" />
            </div>
          </div>

          {/* SECTION 4 · Contact */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">4 · Contact Information</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Primary Mobile <span className="text-red-500">*</span></label>
                <input className="input" required value={form.primary_mobile || ''} onChange={e => F('primary_mobile', e.target.value)} />
              </div>
              <Field label="Secondary Mobile" k="secondary_mobile" />
              <Field label="WhatsApp Number" k="whatsapp_number" />
              <Field label="Office Landline" k="office_landline" />
              <Field label="Personal Email" k="personal_email" type="email" />
              <Field label="Office Email" k="office_email" type="email" />
              <div>
                <label className="label">Preferred Contact Method</label>
                <select className="select" value={form.preferred_contact_method || ''} onChange={e => F('preferred_contact_method', e.target.value)}>
                  <option value="">—</option>
                  {CONTACT_METHODS.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <Field label="Best Time to Call" k="best_time_to_call" />
            </div>
          </div>

          {/* SECTION 5 · Digital */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">5 · Digital / Social Presence</h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="LinkedIn Profile URL" k="linkedin_url" />
              <Field label="Facebook Profile / Page" k="facebook_url" />
              <Field label="Instagram Handle" k="instagram_handle" />
              <Field label="Twitter / X Handle" k="twitter_handle" />
              <Field label="YouTube Channel" k="youtube_channel" />
              <Field label="Google Business Profile" k="google_business_profile" />
              <Field label="IndiaMART / Justdial / Other Listings" k="other_listings" full />
            </div>
          </div>

          {/* SECTION 6 · Relationship + BI */}
          <div className="card p-3">
            <h5 className="text-xs font-bold text-blue-800 uppercase mb-2">6 · Relationship & Business Intelligence</h5>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Source of Contact" k="source_of_contact" />
              <Field label="Referred By" k="referred_by" />
              <Field label="First Meeting Date" k="first_meeting_date" type="date" />
              <div>
                <label className="label">Relationship Stage</label>
                <select className="select" value={form.relationship_stage || ''} onChange={e => F('relationship_stage', e.target.value)}>
                  <option value="">—</option>
                  {STAGES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <Field label="Typical Project Type" k="typical_project_type" />
              <Field label="Typical Project Value Range" k="typical_project_value_range" />
              <Field label="Past Projects Count" k="past_projects_count" type="number" />
              <Field label="Past Projects Total Value (₹)" k="past_projects_total_value" type="number" />
              <Field label="Ongoing Projects with Us" k="ongoing_projects_with_us" type="number" />
              <div>
                <label className="label">Client Payment Behavior</label>
                <select className="select" value={form.client_payment_behavior || ''} onChange={e => F('client_payment_behavior', e.target.value)}>
                  <option value="">—</option>
                  {PAYMENT_BEHAVIOR.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="sm:col-span-3">
                <label className="label">Commission / Referral Terms <span className="text-[10px] text-gray-400 normal-case">(confidential)</span></label>
                <textarea className="input" rows="2" value={form.commission_terms || ''} onChange={e => F('commission_terms', e.target.value)} />
              </div>
              <div className="sm:col-span-3">
                <label className="label">Competitors They Also Work With</label>
                <textarea className="input" rows="2" value={form.competitors || ''} onChange={e => F('competitors', e.target.value)} placeholder="Comma-separated list" />
              </div>
            </div>
          </div>

          {/* Meta */}
          <div className="card p-3 bg-gray-50">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Date of Entry" k="date_of_entry" type="date" />
              <Field label="Entered By" k="entered_by" />
              <Field label="Assigned Relationship Manager" k="assigned_relationship_manager" />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add Influencer'}</button>
          </div>
        </form>
      </Modal>

      {/* Import result modal */}
      {importResult && (
        <Modal isOpen={true} onClose={() => setImportResult(null)} title="Import result" wide>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 border rounded p-3 text-center">
                <div className="text-2xl font-bold text-gray-700">{importResult.total_rows}</div>
                <div className="text-[10px] uppercase text-gray-500 mt-1">Total rows</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center">
                <div className="text-2xl font-bold text-emerald-700">{importResult.created_count}</div>
                <div className="text-[10px] uppercase text-emerald-600 mt-1">Created</div>
              </div>
              <div className="bg-red-50 border border-red-200 rounded p-3 text-center">
                <div className="text-2xl font-bold text-red-700">{importResult.failed_count}</div>
                <div className="text-[10px] uppercase text-red-600 mt-1">Failed</div>
              </div>
            </div>
            {importResult.failed_count > 0 && (
              <div>
                <div className="text-xs font-semibold text-red-700 mb-1">Failed rows (first 50)</div>
                <div className="overflow-x-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-red-50 text-red-700">
                      <tr><th className="px-2 py-1.5 text-left">Excel Row</th><th className="px-2 py-1.5 text-left">Reason</th></tr>
                    </thead>
                    <tbody>
                      {importResult.failed.slice(0, 50).map((f, i) => (
                        <tr key={i} className="border-t"><td className="px-2 py-1.5 font-mono">{f.row}</td><td className="px-2 py-1.5">{f.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="text-[10px] text-gray-500">Fix failed rows in the same Excel and re-upload — successful rows already created won't be touched.</p>
            <div className="flex justify-end">
              <button onClick={() => setImportResult(null)} className="btn btn-primary text-sm">Done</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
