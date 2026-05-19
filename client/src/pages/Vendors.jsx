import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiSearch, FiEye, FiTrash2, FiTruck, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { STATES, DISTRICTS_BY_STATE } from '../data/indiaLocations';

const CATEGORIES = ['FF', 'ELE', 'LV', 'Solar', 'HVAC', 'INTERIOR', 'OTHER'];
const TYPES = ['Distributor', 'Trader', 'Manufacture', 'Direct Company', 'Stockist'];
const CAT_COLORS = { FF: 'bg-red-100 text-red-700', ELE: 'bg-amber-100 text-amber-700', LV: 'bg-red-100 text-red-700', Solar: 'bg-emerald-100 text-emerald-700', HVAC: 'bg-cyan-100 text-cyan-700', INTERIOR: 'bg-purple-100 text-purple-700' };

export default function Vendors() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [vendors, setVendors] = useState([]);
  const [rates, setRates] = useState([]);
  const [tab, setTab] = useState('vendors');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [viewData, setViewData] = useState(null);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');

  const load = () => {
    api.get('/procurement/vendors').then(r => setVendors(r.data));
    api.get('/procurement/vendor-rates').then(r => setRates(r.data));
  };
  useEffect(() => { load(); }, []);

  const saveVendor = async (e) => {
    e.preventDefault();
    try {
      if (editing) { await api.put(`/procurement/vendors/${editing.id}`, form); }
      else { await api.post('/procurement/vendors', form); }
      toast.success(editing ? 'Updated' : 'Created');
      setModal(false); setEditing(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const saveRate = async (e) => {
    e.preventDefault();
    await api.post('/procurement/vendor-rates', form);
    toast.success('Rate comparison saved');
    setModal(false); load();
  };

  const approveRate = async (id, status) => {
    await api.put(`/procurement/vendor-rates/${id}/approve`, { approval_status: status });
    toast.success(`Rate ${status}`); load();
  };

  const filtered = vendors.filter(v => {
    if (filterCat && v.category !== filterCat) return false;
    if (search && !(v.name || '').toLowerCase().includes(search.toLowerCase()) && !(v.deals_in || '').toLowerCase().includes(search.toLowerCase()) && !(v.vendor_code || '').toLowerCase().includes(search.toLowerCase()) && !(v.district || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Category counts
  const catCounts = {};
  vendors.forEach(v => { if (v.category) catCounts[v.category] = (catCounts[v.category] || 0) + 1; });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('vendors')} className={`btn ${tab === 'vendors' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Vendors ({vendors.length})</button>
        <button onClick={() => setTab('rates')} className={`btn ${tab === 'rates' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Rate Comparison</button>
      </div>

      {tab === 'vendors' && (
        <>
          {/* Category filter chips */}
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setFilterCat('')} className={`px-3 py-1 rounded-full text-xs font-semibold border ${!filterCat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>All ({vendors.length})</button>
            {Object.entries(catCounts).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
              <button key={cat} onClick={() => setFilterCat(filterCat === cat ? '' : cat)} className={`px-3 py-1 rounded-full text-xs font-semibold border ${filterCat === cat ? 'bg-red-600 text-white' : 'bg-white text-gray-600 border-gray-200'}`}>{cat} ({count})</button>
            ))}
          </div>

          <div className="flex gap-3">
            <div className="relative flex-1"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} /><input className="input pl-10" placeholder="Search vendor name, deals in, code, district..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <button onClick={() => exportCsv('vendors',
              ['Code','Name','Firm','Category','Deals In','Type','Phone','Email','District','State','Authorized Dealer','Turnover'],
              filtered.map(v => [v.vendor_code, v.name, v.firm_name, v.category, v.deals_in, v.type, v.phone, v.email, v.district, v.state, v.authorized_dealer, v.turnover]))}
              className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export Excel</button>
            {canCreate('vendors') && <button onClick={() => { setEditing(null); setForm({}); setModal('vendor'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15} /> Add Vendor</button>}
          </div>

          <p className="text-sm text-gray-500">Showing {filtered.length} vendors</p>

          <div className="card p-0"><table className="min-w-[1000px] text-xs freeze-head">
            <thead><tr className="bg-gray-50">
              <th className="px-2 py-2">Code</th><th className="px-2 py-2 text-left">Vendor Name</th><th className="px-2 py-2">Category</th>
              <th className="px-2 py-2 text-left">Deals In</th><th className="px-2 py-2">Type</th><th className="px-2 py-2 text-left">District</th>
              <th className="px-2 py-2">Phone</th><th className="px-2 py-2">Payment</th><th className="px-2 py-2">Credit</th><th className="px-2 py-2">Actions</th>
            </tr></thead>
            <tbody>{filtered.map(v => (
              <tr key={v.id} className="border-b hover:bg-red-50/30">
                <td className="px-2 py-2 font-mono text-[10px] text-red-600">{v.vendor_code || '-'}</td>
                <td className="px-2 py-2"><div className="font-semibold">{v.name}</div>{v.authorized_dealer && <div className="text-[10px] text-gray-400">{v.authorized_dealer}</div>}</td>
                <td className="px-2 py-2"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CAT_COLORS[v.category] || 'bg-gray-100'}`}>{v.category || '-'}</span></td>
                <td className="px-2 py-2 text-[11px]">{v.deals_in || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.type || '-'}</td>
                <td className="px-2 py-2 text-[11px]">{v.district || '-'}{v.state ? `, ${v.state}` : ''}</td>
                <td className="px-2 py-2 text-[11px]">{v.phone || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.payment_terms || '-'}</td>
                <td className="px-2 py-2 text-[10px]">{v.credit_days || '-'}</td>
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    <button onClick={() => { setViewData(v); setModal('view'); }} className="p-1 text-gray-400 hover:text-red-600"><FiEye size={14} /></button>
                    {canEdit('vendors') && <button onClick={() => { setEditing(v); setForm(v); setModal('vendor'); }} className="p-1 text-gray-400 hover:text-amber-600"><FiEdit2 size={14} /></button>}
                    {canDelete('vendors') && <button onClick={async () => {
                      if (!confirm(`Delete vendor "${v.name}"?`)) return;
                      try { await api.delete(`/procurement/vendors/${v.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}{filtered.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No vendors found</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {tab === 'rates' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-sm">3 Vendor Rate Comparison</h3>
            <button onClick={() => { setForm({ item_description: '', vendor1_id: '', vendor1_rate: 0, vendor2_id: '', vendor2_rate: 0, vendor3_id: '', vendor3_rate: 0, final_rate: 0, selected_vendor_id: '' }); setModal('rate'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15} /> Add Comparison</button>
          </div>
          <div className="card p-0"><table className="text-xs freeze-head">
            <thead><tr><th>Item</th><th>Vendor 1</th><th>Rate 1</th><th>Vendor 2</th><th>Rate 2</th><th>Vendor 3</th><th>Rate 3</th><th>Final</th><th>Selected</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{rates.map(r => (
              <tr key={r.id}>
                <td className="font-medium">{r.item_description}</td>
                <td>{r.vendor1_name}</td><td className="font-semibold">Rs {r.vendor1_rate}</td>
                <td>{r.vendor2_name}</td><td className="font-semibold">Rs {r.vendor2_rate}</td>
                <td>{r.vendor3_name}</td><td className="font-semibold">Rs {r.vendor3_rate}</td>
                <td className="font-bold text-emerald-600">Rs {r.final_rate}</td>
                <td className="font-medium text-red-600">{r.selected_vendor_name}</td>
                <td><span className={`badge ${r.approval_status === 'approved' ? 'badge-green' : r.approval_status === 'rejected' ? 'badge-red' : 'badge-yellow'}`}>{r.approval_status}</span></td>
                <td><div className="flex gap-1 items-center">
                  {r.approval_status === 'pending' && (
                    <>
                      <button onClick={() => approveRate(r.id, 'approved')} className="text-[10px] text-emerald-600 font-bold">Approve</button>
                      <button onClick={() => approveRate(r.id, 'rejected')} className="text-[10px] text-red-600 font-bold">Reject</button>
                    </>
                  )}
                  {canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete rate comparison for "${r.item_description}"?`)) return;
                    try { await api.delete(`/procurement/vendor-rates/${r.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                </div></td>
              </tr>
            ))}{rates.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No comparisons yet</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* View Vendor Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(false); setViewData(null); }} title={viewData?.name} wide>
        {viewData && (
          <div className="space-y-3 text-sm">
            <div className="flex gap-2 items-center">
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${CAT_COLORS[viewData.category] || 'bg-gray-100'}`}>{viewData.category}</span>
              <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{viewData.type}</span>
              <span className="font-mono text-xs text-red-600">{viewData.vendor_code}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div><span className="text-gray-400 text-xs">Deals In:</span><br/><span className="font-medium">{viewData.deals_in || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Authorized:</span><br/><span className="font-medium">{viewData.authorized_dealer || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Contact Person:</span><br/><span className="font-medium">{viewData.contact_person || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Sub Category:</span><br/><span className="font-medium">{viewData.sub_category || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Phone:</span><br/><span className="font-medium">{viewData.phone || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Email:</span><br/><span className="font-medium">{viewData.email || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">GST:</span><br/><span className="font-medium">{viewData.gst_number || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">District:</span><br/><span className="font-medium">{viewData.district}, {viewData.state}</span></div>
              <div><span className="text-gray-400 text-xs">Address:</span><br/><span className="font-medium">{viewData.address || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Payment:</span><br/><span className="font-medium">{viewData.payment_terms} - {viewData.credit_days} days</span></div>
              <div><span className="text-gray-400 text-xs">Turnover:</span><br/><span className="font-medium">{viewData.turnover || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Team Size:</span><br/><span className="font-medium">{viewData.team_size || '-'}</span></div>
              <div><span className="text-gray-400 text-xs">Source:</span><br/><span className="font-medium">{viewData.source || '-'}</span></div>
            </div>
          </div>
        )}
      </Modal>

      {/* Add/Edit Vendor Modal */}
      <Modal isOpen={modal === 'vendor'} onClose={() => { setModal(false); setEditing(null); }} title={editing ? 'Edit Vendor' : 'Add Vendor'} wide>
        <form onSubmit={saveVendor} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Vendor Code</label><input className="input" value={form.vendor_code || ''} onChange={e => setForm({...form, vendor_code: e.target.value})} placeholder="Auto if empty" /></div>
            <div><label className="label">Vendor Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Firm Name</label><input className="input" value={form.firm_name || ''} onChange={e => setForm({...form, firm_name: e.target.value})} /></div>
            <div><label className="label">Category</label><select className="select" value={form.category || ''} onChange={e => setForm({...form, category: e.target.value})}><option value="">Select</option>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Type</label><select className="select" value={form.type || ''} onChange={e => setForm({...form, type: e.target.value})}><option value="">Select</option>{TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
            <div><label className="label">Deals In</label><input className="input" value={form.deals_in || ''} onChange={e => setForm({...form, deals_in: e.target.value})} /></div>
            <div><label className="label">Authorized Dealer</label><input className="input" value={form.authorized_dealer || ''} onChange={e => setForm({...form, authorized_dealer: e.target.value})} /></div>
            {/* Contact Person — mam (2026-05-16): "contact person name
                add here and fill in po".  Already in the vendors
                schema (contact_person column) and the Vendor PO print
                page reads it, but the form was missing the input. */}
            <div><label className="label">Contact Person</label><input className="input" value={form.contact_person || ''} onChange={e => setForm({...form, contact_person: e.target.value})} placeholder="Name of person to call" /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div>
              <label className="label">State</label>
              <SearchableSelect
                options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state || ''} valueKey="value" displayKey="label"
                placeholder="Pick state"
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })}
              />
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect
                options={(form.state ? (DISTRICTS_BY_STATE[form.state] || []) : []).map(d => ({ value: d, label: d }))}
                value={form.district || ''} valueKey="value" displayKey="label"
                placeholder={form.state ? 'Pick district' : 'Pick a state first'}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })}
              />
            </div>
            <div><label className="label">GST Number</label><input className="input" value={form.gst_number || ''} onChange={e => setForm({...form, gst_number: e.target.value})} /></div>
            <div><label className="label">Payment Terms</label><select className="select" value={form.payment_terms || ''} onChange={e => setForm({...form, payment_terms: e.target.value})}><option value="">Select</option><option>Advance</option><option>Credit</option><option>PDC</option><option>COD</option></select></div>
            <div><label className="label">Credit Days</label><input className="input" value={form.credit_days || ''} onChange={e => setForm({...form, credit_days: e.target.value})} /></div>
            <div><label className="label">Sub Category</label><input className="input" value={form.sub_category || ''} onChange={e => setForm({...form, sub_category: e.target.value})} /></div>
          </div>
          <div><label className="label">Address</label><textarea className="input" rows="2" value={form.address || ''} onChange={e => setForm({...form, address: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>

      {/* Rate Comparison Modal */}
      <Modal isOpen={modal === 'rate'} onClose={() => setModal(false)} title="3 Vendor Rate Comparison" wide>
        <form onSubmit={saveRate} className="space-y-4">
          <div><label className="label">Item Description *</label><input className="input" value={form.item_description || ''} onChange={e => setForm({...form, item_description: e.target.value})} required /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {[1,2,3].map(n => (
              <div key={n} className="space-y-2 p-3 bg-gray-50 rounded-lg">
                <h4 className="font-semibold text-sm">Vendor {n}</h4>
                <SearchableSelect
                  options={vendors}
                  value={form[`vendor${n}_id`] || null}
                  valueKey="id" displayKey="name"
                  placeholder="Search vendor…"
                  onChange={(v) => setForm({ ...form, [`vendor${n}_id`]: v?.id || '' })}
                />
                <input className="input" type="number" placeholder="Rate" value={form[`vendor${n}_rate`] || 0} onChange={e => setForm({...form, [`vendor${n}_rate`]: +e.target.value})} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Final Rate</label><input className="input" type="number" value={form.final_rate || 0} onChange={e => setForm({...form, final_rate: +e.target.value})} /></div>
            <div>
              <label className="label">Selected Vendor</label>
              <SearchableSelect
                options={vendors}
                value={form.selected_vendor_id || null}
                valueKey="id" displayKey="name"
                placeholder="Search vendor…"
                onChange={(v) => setForm({ ...form, selected_vendor_id: v?.id || '' })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>
    </div>
  );
}
