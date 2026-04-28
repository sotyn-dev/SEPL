import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiPhoneCall, FiAlertTriangle, FiRefreshCw, FiTrash2 } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

export default function Collections() {
  const { canDelete } = useAuth();
  const [receivables, setReceivables] = useState([]);
  const [summary, setSummary] = useState(null);
  const [targetSummary, setTargetSummary] = useState(null);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [followUpModal, setFollowUpModal] = useState(false);
  const [collectModal, setCollectModal] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [followUps, setFollowUps] = useState([]);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState('');

  const load = () => {
    api.get('/collections', { params: filter ? { status: filter } : {} }).then(r => setReceivables(r.data));
    api.get('/collections/summary').then(r => setSummary(r.data));
    api.get('/collections/target-summary').then(r => setTargetSummary(r.data)).catch(() => setTargetSummary(null));
    api.get('/auth/users').then(r => setUsers(r.data));
  };
  useEffect(() => { load(); }, [filter]);

  const createReceivable = async (e) => {
    e.preventDefault();
    await api.post('/collections', form);
    toast.success('Receivable added');
    setModal(false); load();
  };

  const addFollowUp = async (e) => {
    e.preventDefault();
    await api.post(`/collections/${selectedId}/follow-up`, form);
    toast.success('Follow-up recorded');
    setFollowUpModal(false); load();
  };

  const recordCollection = async (e) => {
    e.preventDefault();
    await api.post(`/collections/${selectedId}/collect`, form);
    toast.success('Collection recorded & linked to Cash Flow!');
    setCollectModal(false); load();
  };

  const refreshAgeing = async () => {
    await api.post('/collections/refresh-ageing');
    toast.success('Ageing refreshed');
    load();
  };

  const openEdit = (r) => {
    setEditForm({
      client_name: r.client_name || '',
      project_name: r.project_name || '',
      invoice_number: r.invoice_number || '',
      invoice_date: r.invoice_date || '',
      invoice_amount: r.invoice_amount || 0,
      due_date: r.due_date || '',
      owner_id: r.owner_id || '',
    });
    setEditModal(r);
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editForm.client_name || !editForm.client_name.trim()) return toast.error('Client name required');
    if (!(+editForm.invoice_amount > 0)) return toast.error('Invoice amount must be greater than 0');
    setEditSaving(true);
    try {
      await api.put(`/collections/${editModal.id}`, editForm);
      toast.success('Receivable updated');
      setEditModal(null); setEditForm({}); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update');
    }
    setEditSaving(false);
  };

  const openFollowUps = async (id) => {
    setSelectedId(id);
    const { data } = await api.get(`/collections/${id}/follow-ups`);
    setFollowUps(data);
    setForm({ follow_up_date: new Date().toISOString().split('T')[0], contact_method: 'call', response: '', promised_date: '', promised_amount: 0 });
    setFollowUpModal(true);
  };

  const statusBg = { green: 'bg-emerald-100 text-emerald-800 border-emerald-300', yellow: 'bg-amber-100 text-amber-800 border-amber-300', red: 'bg-red-100 text-red-800 border-red-300' };

  if (!summary) return <div className="text-center py-10">Loading...</div>;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card text-center border-l-4 border-red-500">
          <div className="text-3xl font-bold text-red-600">Rs {(summary.totalOutstanding / 100000).toFixed(2)}L</div>
          <div className="text-sm text-gray-500">Total Outstanding</div>
        </div>
        {summary.byBucket.map(b => (
          <div key={b.ageing_bucket} className="card text-center">
            <div className="text-2xl font-bold text-gray-800">Rs {(b.total / 100000).toFixed(2)}L</div>
            <div className="text-sm text-gray-500">{b.ageing_bucket} Days ({b.count})</div>
          </div>
        ))}
        <div className="card text-center border-l-4 border-amber-500">
          <div className="text-2xl font-bold text-amber-600">Rs {(summary.overdue.total / 100000).toFixed(2)}L</div>
          <div className="text-sm text-gray-500">Overdue ({summary.overdue.count})</div>
        </div>
      </div>

      {/* Filters & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {['', 'red', 'yellow', 'green'].map(s => (
            <button key={s} onClick={() => setFilter(s)} className={`btn text-xs ${filter === s ? 'btn-primary' : 'btn-secondary'}`}>
              {s === '' ? 'All' : s === 'red' ? '🔴 Red' : s === 'yellow' ? '🟡 Yellow' : '🟢 Green'}
            </button>
          ))}
          <button onClick={refreshAgeing} className="btn btn-secondary text-xs flex items-center gap-1"><FiRefreshCw size={12} /> Refresh Ageing</button>
        </div>
        <button onClick={() => { setForm({ client_name: '', project_name: '', invoice_number: '', invoice_date: '', invoice_amount: 0, due_date: '', owner_id: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Receivable</button>
      </div>

      {/* Payment Target vs Received (with Ageing) — top-line numbers
          plus a per-bucket breakdown so mam can see where collection is
          lagging. */}
      {targetSummary && (
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gradient-to-r from-red-50 to-white">
            <h4 className="font-semibold text-gray-700">Payment Target vs Received <span className="text-xs text-gray-400 font-normal">(with ageing)</span></h4>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 p-4">
            <div className="card p-3 border-l-4 border-blue-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Target (Total Invoiced)</div>
              <div className="text-2xl font-bold text-gray-800 mt-0.5">Rs {(targetSummary.overall.target / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">{targetSummary.overall.count} invoices</div>
            </div>
            <div className="card p-3 border-l-4 border-emerald-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Received</div>
              <div className="text-2xl font-bold text-emerald-700 mt-0.5">Rs {(targetSummary.overall.received / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">cleared so far</div>
            </div>
            <div className="card p-3 border-l-4 border-red-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Outstanding</div>
              <div className="text-2xl font-bold text-red-700 mt-0.5">Rs {(targetSummary.overall.outstanding / 100000).toFixed(2)}L</div>
              <div className="text-[10px] text-gray-400">still to collect</div>
            </div>
            <div className="card p-3 border-l-4 border-amber-500">
              <div className="text-[10px] uppercase text-gray-500 font-semibold">Collection %</div>
              <div className="text-2xl font-bold text-amber-700 mt-0.5">{targetSummary.overall.collection_pct}%</div>
              <div className="text-[10px] text-gray-400">received vs target</div>
            </div>
          </div>
          {targetSummary.by_bucket.length > 0 && (
            <div className="overflow-x-auto border-t">
              <table className="text-sm w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Ageing Bucket</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Invoices</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Target</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Received</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Outstanding</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Collection %</th>
                  </tr>
                </thead>
                <tbody>
                  {targetSummary.by_bucket.map(b => (
                    <tr key={b.ageing_bucket} className={`border-t ${b.ageing_bucket === '90+' ? 'bg-red-50/40' : b.ageing_bucket === '60-90' ? 'bg-amber-50/30' : ''}`}>
                      <td className="px-3 py-2 font-medium text-gray-800">
                        <span className={`px-2 py-0.5 rounded text-[11px] ${b.ageing_bucket === '0-30' ? 'bg-emerald-100 text-emerald-800' : b.ageing_bucket === '30-60' ? 'bg-blue-100 text-blue-800' : b.ageing_bucket === '60-90' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
                          {b.ageing_bucket} days
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{b.count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">Rs {(b.target / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">Rs {(b.received / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right text-red-700 font-semibold tabular-nums">Rs {(b.outstanding / 100000).toFixed(2)}L</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{b.collection_pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Top Clients */}
      {summary.topClients.length > 0 && (
        <div className="card">
          <h4 className="font-semibold mb-3">Top Outstanding Clients</h4>
          <div className="flex flex-wrap gap-3">
            {summary.topClients.map((c, i) => (
              <div key={i} className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
                <span className="font-medium">{c.client_name}</span>: <span className="text-red-600 font-bold">Rs {(c.total / 100000).toFixed(2)}L</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Receivables Table */}
      <div className="card p-0 overflow-x-auto">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr><th>Client</th><th>Invoice</th><th>Amount</th><th>Received</th><th>Outstanding</th><th>Due Date</th><th>Ageing</th><th>Status</th><th>Follow-up</th><th>Owner</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {receivables.map(r => (
                <tr key={r.id}>
                  <td className="font-medium">{r.client_name}<br/><span className="text-xs text-gray-400">{r.project_name}</span></td>
                  <td>{r.invoice_number}</td>
                  <td>Rs {r.invoice_amount?.toLocaleString()}</td>
                  <td className="text-emerald-600">Rs {r.received_amount?.toLocaleString()}</td>
                  <td className="font-bold text-red-600">Rs {r.outstanding_amount?.toLocaleString()}</td>
                  <td>{r.due_date}</td>
                  <td><span className={`badge ${r.ageing_days > 60 ? 'badge-red' : r.ageing_days > 30 ? 'badge-yellow' : 'badge-green'}`}>{r.ageing_days}d ({r.ageing_bucket})</span></td>
                  <td><span className={`px-2 py-1 rounded-full text-xs font-bold border ${statusBg[r.status]}`}>{r.status === 'red' ? '🔴 RED' : r.status === 'yellow' ? '🟡 YELLOW' : '🟢 GREEN'}</span></td>
                  <td><span className="badge badge-blue text-xs">{r.follow_up_status}</span></td>
                  <td className="text-xs">{r.owner_name}</td>
                  <td>
                    <div className="flex gap-1">
                      <button onClick={() => openEdit(r)} className="p-1 hover:bg-blue-50 rounded text-blue-600" title="Edit"><FiEdit2 size={14} /></button>
                      <button onClick={() => openFollowUps(r.id)} className="p-1 hover:bg-red-50 rounded text-red-600" title="Follow-up"><FiPhoneCall size={14} /></button>
                      <button onClick={() => { setSelectedId(r.id); setForm({ amount: 0, collection_date: new Date().toISOString().split('T')[0], payment_mode: '', transaction_ref: '', notes: '' }); setCollectModal(true); }} className="p-1 hover:bg-emerald-50 rounded text-emerald-600" title="Record Collection"><LuIndianRupee size={14} /></button>
                      {canDelete('collections') && <button onClick={async () => {
                        if (!confirm(`Delete receivable "${r.invoice_number || r.client_name}"?`)) return;
                        try { await api.delete(`/collections/${r.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {receivables.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No receivables found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Receivable Modal */}
      <Modal isOpen={!!editModal} onClose={() => { setEditModal(null); setEditForm({}); }} title={editModal ? `Edit Receivable — ${editModal.invoice_number || editModal.client_name}` : 'Edit Receivable'}>
        {editModal && (
          <form onSubmit={saveEdit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="label">Client Name *</label><input className="input" required value={editForm.client_name || ''} onChange={e => setEditForm(f => ({ ...f, client_name: e.target.value }))} /></div>
              <div className="col-span-2"><label className="label">Project Name</label><input className="input" value={editForm.project_name || ''} onChange={e => setEditForm(f => ({ ...f, project_name: e.target.value }))} /></div>
              <div><label className="label">Invoice Number</label><input className="input" value={editForm.invoice_number || ''} onChange={e => setEditForm(f => ({ ...f, invoice_number: e.target.value }))} /></div>
              <div><label className="label">Invoice Date</label><input className="input" type="date" value={editForm.invoice_date || ''} onChange={e => setEditForm(f => ({ ...f, invoice_date: e.target.value }))} /></div>
              <div><label className="label">Invoice Amount * <span className="text-[10px] text-gray-400 font-normal">(Target)</span></label><input className="input" type="number" step="any" min="0" value={editForm.invoice_amount || 0} onChange={e => setEditForm(f => ({ ...f, invoice_amount: +e.target.value }))} required /></div>
              <div><label className="label">Due Date</label><input className="input" type="date" value={editForm.due_date || ''} onChange={e => setEditForm(f => ({ ...f, due_date: e.target.value }))} /></div>
              <div className="col-span-2">
                <label className="label">Owner</label>
                <select className="select" value={editForm.owner_id || ''} onChange={e => setEditForm(f => ({ ...f, owner_id: e.target.value }))}>
                  <option value="">—</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-800">
              Already received: <span className="font-semibold">Rs {(editModal.received_amount || 0).toLocaleString()}</span>. Editing the invoice amount or due date will recompute outstanding + ageing automatically.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setEditModal(null); setEditForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={editSaving} className="btn btn-primary">{editSaving ? 'Saving…' : 'Save Changes'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Add Receivable Modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="Add Receivable">
        <form onSubmit={createReceivable} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Client Name *</label><input className="input" value={form.client_name || ''} onChange={e => setForm({...form, client_name: e.target.value})} required /></div>
            <div><label className="label">Project Name</label><input className="input" value={form.project_name || ''} onChange={e => setForm({...form, project_name: e.target.value})} /></div>
            <div><label className="label">Invoice Number</label><input className="input" value={form.invoice_number || ''} onChange={e => setForm({...form, invoice_number: e.target.value})} /></div>
            <div><label className="label">Invoice Date</label><input className="input" type="date" value={form.invoice_date || ''} onChange={e => setForm({...form, invoice_date: e.target.value})} /></div>
            <div><label className="label">Invoice Amount *</label><input className="input" type="number" value={form.invoice_amount || 0} onChange={e => setForm({...form, invoice_amount: +e.target.value})} required /></div>
            <div><label className="label">Due Date</label><input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({...form, due_date: e.target.value})} /></div>
            <div>
              <label className="label">Owner</label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                value={form.owner_id || null}
                valueKey="id" displayKey="label"
                placeholder="Search user…"
                onChange={(u) => setForm({ ...form, owner_id: u?.id || '' })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
        </form>
      </Modal>

      {/* Follow-up Modal */}
      <Modal isOpen={followUpModal} onClose={() => setFollowUpModal(false)} title="Follow-up & Escalation" wide>
        <div className="space-y-4">
          {followUps.length > 0 && (
            <div className="max-h-48 overflow-y-auto border rounded-lg p-3 bg-gray-50">
              <h5 className="font-semibold text-xs text-gray-500 mb-2">Previous Follow-ups</h5>
              {followUps.map(f => (
                <div key={f.id} className="border-b last:border-0 py-2 text-sm">
                  <span className="font-medium">{f.follow_up_date}</span> via <span className="capitalize">{f.contact_method}</span> by {f.followed_by_name}
                  <br/><span className="text-gray-600">{f.response}</span>
                  {f.promised_date && <span className="text-red-600 ml-2">Promised: {f.promised_date} (Rs {f.promised_amount?.toLocaleString()})</span>}
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addFollowUp} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label">Follow-up Date</label><input className="input" type="date" value={form.follow_up_date || ''} onChange={e => setForm({...form, follow_up_date: e.target.value})} /></div>
              <div><label className="label">Contact Method</label><select className="select" value={form.contact_method || ''} onChange={e => setForm({...form, contact_method: e.target.value})}><option value="call">Phone Call</option><option value="email">Email</option><option value="visit">Site Visit</option><option value="whatsapp">WhatsApp</option><option value="legal_notice">Legal Notice</option></select></div>
            </div>
            <div><label className="label">Response / Notes</label><textarea className="input" rows="2" value={form.response || ''} onChange={e => setForm({...form, response: e.target.value})} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label">Promised Date</label><input className="input" type="date" value={form.promised_date || ''} onChange={e => setForm({...form, promised_date: e.target.value})} /></div>
              <div><label className="label">Promised Amount</label><input className="input" type="number" value={form.promised_amount || 0} onChange={e => setForm({...form, promised_amount: +e.target.value})} /></div>
            </div>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setFollowUpModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Record Follow-up</button></div>
          </form>
        </div>
      </Modal>

      {/* Collection Modal */}
      <Modal isOpen={collectModal} onClose={() => setCollectModal(false)} title="Record Collection Payment">
        <form onSubmit={recordCollection} className="space-y-4">
          <p className="text-xs text-red-600 bg-red-50 p-2 rounded">This collection will auto-link to Cash Flow System as an inflow entry.</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Amount *</label><input className="input" type="number" value={form.amount || 0} onChange={e => setForm({...form, amount: +e.target.value})} required /></div>
            <div><label className="label">Date</label><input className="input" type="date" value={form.collection_date || ''} onChange={e => setForm({...form, collection_date: e.target.value})} /></div>
            <div><label className="label">Payment Mode</label><select className="select" value={form.payment_mode || ''} onChange={e => setForm({...form, payment_mode: e.target.value})}><option value="">Select</option><option value="Cash">Cash</option><option value="Bank Transfer">Bank Transfer</option><option value="UPI">UPI</option><option value="Cheque">Cheque</option><option value="NEFT">NEFT</option><option value="RTGS">RTGS</option></select></div>
            <div><label className="label">Transaction Ref</label><input className="input" value={form.transaction_ref || ''} onChange={e => setForm({...form, transaction_ref: e.target.value})} /></div>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setCollectModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-success">Record Collection</button></div>
        </form>
      </Modal>
    </div>
  );
}
