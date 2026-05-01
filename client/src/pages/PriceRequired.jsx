import { useState, useEffect, Fragment } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiCheckCircle, FiTag } from 'react-icons/fi';

// Price Required — workflow:
//   1. Site engineer raises a request for a new item not yet in Item Master.
//   2. Identical requests merge by (name + size + spec + make + uom + type).
//   3. Purchase team enters up to 3 vendor rates per merged item.
//   4. Purchase team picks the final vendor + rate.
//   5. System auto-creates an Item Master entry with that rate and links it.
export default function PriceRequired() {
  const { user, isAdmin, canApprove } = useAuth();
  const isQuoter = isAdmin() || canApprove('procurement') || canApprove('item_master');

  const [tab, setTab] = useState(isQuoter ? 'quotes' : 'raise');
  const [requests, setRequests] = useState([]);
  const [grouped, setGrouped] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [sites, setSites] = useState([]);

  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({ site_name: '', item_name: '', size: '', specification: '', make: '', uom: 'PCS', item_type: 'PO', notes: '' });

  const [finalModal, setFinalModal] = useState(null); // grouped row being finalized
  const [finalForm, setFinalForm] = useState({});

  const load = () => {
    api.get('/price-requests').then(r => setRequests(r.data || [])).catch(() => setRequests([]));
    if (isQuoter) {
      api.get('/price-requests/grouped').then(r => setGrouped(r.data || [])).catch(() => setGrouped([]));
    }
  };
  useEffect(() => {
    load();
    api.get('/procurement/vendors').then(r => setVendors((r.data || []).map(v => ({ ...v, label: v.name })))).catch(() => {});
    api.get('/collections/sites').then(r => setSites((r.data || []).map(s => ({ ...s, label: s.name })))).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.item_name || !form.item_name.trim()) return toast.error('Item name is required');
    try {
      await api.post('/price-requests', form);
      toast.success('Price request raised — purchase team will quote it');
      setCreateModal(false);
      setForm({ site_name: '', item_name: '', size: '', specification: '', make: '', uom: 'PCS', item_type: 'PO', notes: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const updateRate = async (anchorId, patch) => {
    try {
      await api.put(`/price-requests/${anchorId}/rate`, patch);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };

  const openFinalize = (g) => {
    // Default to lowest non-zero quote = best offer
    const quotes = [
      { name: g.vendor1_name, rate: +g.vendor1_rate || 0, terms: g.vendor1_terms },
      { name: g.vendor2_name, rate: +g.vendor2_rate || 0, terms: g.vendor2_terms },
      { name: g.vendor3_name, rate: +g.vendor3_rate || 0, terms: g.vendor3_terms },
    ].filter(q => q.name && q.rate > 0).sort((a, b) => a.rate - b.rate);
    const best = quotes[0] || {};
    setFinalForm({
      final_vendor_name: best.name || '',
      final_rate: best.rate || 0,
      final_terms: best.terms || '',
      propagate_to_group: true,
    });
    setFinalModal(g);
  };

  const submitFinalize = async (e) => {
    e.preventDefault();
    if (!finalForm.final_vendor_name) return toast.error('Pick a vendor');
    if (!(+finalForm.final_rate > 0)) return toast.error('Final rate must be greater than 0');
    try {
      const r = await api.post(`/price-requests/${finalModal.anchor_id}/finalize`, finalForm);
      toast.success(`Item added to Master (${r.data.item_code}) — ${r.data.propagated_count} request(s) updated`);
      setFinalModal(null); setFinalForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this price request?')) return;
    try { await api.delete(`/price-requests/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const statusBadge = (s) => {
    const map = {
      open:      'bg-amber-100 text-amber-800 border-amber-200',
      quoted:    'bg-blue-100 text-blue-800 border-blue-200',
      finalized: 'bg-purple-100 text-purple-800 border-purple-200',
      added:     'bg-emerald-100 text-emerald-800 border-emerald-200',
    };
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${map[s] || ''}`}>{s}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Price Required</h3>
          <p className="text-sm text-gray-500">
            Raise items missing from the catalog. Purchase team gets 3 vendor quotes, picks the final rate, and the item is added to Item Master automatically.
          </p>
        </div>
        <button onClick={() => setCreateModal(true)} className="btn btn-primary flex items-center gap-2 w-full sm:w-auto justify-center"><FiPlus /> Raise Price Request</button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {isQuoter && (
          <button onClick={() => setTab('quotes')} className={`btn text-sm ${tab === 'quotes' ? 'btn-primary' : 'btn-secondary'}`}>
            Vendor Rates ({grouped.length})
          </button>
        )}
        <button onClick={() => setTab('raise')} className={`btn text-sm ${tab === 'raise' ? 'btn-primary' : 'btn-secondary'}`}>
          All Requests ({requests.length})
        </button>
      </div>

      {/* TAB 1 — Vendor Rates (Stage 2 + 3 for purchase team) */}
      {tab === 'quotes' && isQuoter && (
        <div className="card p-0 overflow-x-auto">
          <table className="text-xs w-full" style={{ minWidth: '1400px' }}>
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-2 py-2" rowSpan="2">Item</th>
                <th className="text-left px-2 py-2" rowSpan="2">Companies Requested</th>
                <th className="text-center px-2 py-2" colSpan="3">Vendor 1</th>
                <th className="text-center px-2 py-2" colSpan="3">Vendor 2</th>
                <th className="text-center px-2 py-2" colSpan="3">Vendor 3</th>
                <th className="px-2 py-2" rowSpan="2">Action</th>
              </tr>
              <tr className="bg-gray-50 text-[10px]">
                <th className="px-1 py-1">Name</th><th className="px-1 py-1">Rate</th><th className="px-1 py-1">Terms</th>
                <th className="px-1 py-1">Name</th><th className="px-1 py-1">Rate</th><th className="px-1 py-1">Terms</th>
                <th className="px-1 py-1">Name</th><th className="px-1 py-1">Rate</th><th className="px-1 py-1">Terms</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(g => (
                <tr key={g.anchor_id} className="border-t hover:bg-red-50/30">
                  <td className="px-2 py-2 align-top" style={{ width: '260px', minWidth: '260px' }}>
                    <div className="font-semibold text-[12px]">{g.item_name}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {[g.size, g.specification, g.make].filter(Boolean).join(' · ')}
                    </div>
                    <div className="text-[10px] mt-0.5">
                      <span className="text-gray-400">{g.uom}</span>
                      <span className={`ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                        g.item_type === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : g.item_type === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-red-50 text-red-700 border-red-200'
                      }`}>{g.item_type}</span>
                    </div>
                    {g.request_ids.length > 1 && (
                      <div className="text-[9px] text-gray-400 italic mt-0.5">merged from {g.request_ids.length} companies</div>
                    )}
                  </td>
                  <td className="px-2 py-2 align-top text-[11px]" style={{ width: '160px', minWidth: '160px' }}>
                    {g.sites.length ? g.sites.map(s => <div key={s} className="truncate" title={s}>📍 {s}</div>) : <span className="text-gray-300">—</span>}
                  </td>
                  {[1, 2, 3].map(n => (
                    <Fragment key={n}>
                      <td className="px-1 py-1" style={{ minWidth: '160px' }}>
                        <SearchableSelect
                          options={vendors}
                          value={g[`vendor${n}_name`] || null}
                          valueKey="name" displayKey="name"
                          placeholder="Pick vendor"
                          buttonClassName="text-[11px] px-2 py-1 w-full border border-gray-200 rounded-md bg-white hover:border-gray-300 text-left flex items-center justify-between gap-1 cursor-pointer"
                          onChange={(v) => updateRate(g.anchor_id, { [`vendor${n}_name`]: v?.name || '' })}
                        />
                      </td>
                      <td className="px-1 py-1" style={{ minWidth: '90px' }}>
                        <input className="input text-[11px] px-2 py-1 text-right" type="number" min="0" placeholder="0"
                          defaultValue={g[`vendor${n}_rate`] || ''}
                          onBlur={e => {
                            const v = e.target.value;
                            if (+v !== +(g[`vendor${n}_rate`] || 0)) updateRate(g.anchor_id, { [`vendor${n}_rate`]: v });
                          }} />
                      </td>
                      <td className="px-1 py-1" style={{ minWidth: '100px' }}>
                        <select className="select text-[11px] px-2 py-1" value={g[`vendor${n}_terms`] || ''}
                          onChange={e => updateRate(g.anchor_id, { [`vendor${n}_terms`]: e.target.value })}>
                          <option value="">—</option>
                          <option value="Advance">Advance</option>
                          <option value="Credit">Credit</option>
                        </select>
                      </td>
                    </Fragment>
                  ))}
                  <td className="px-2 py-2">
                    <button onClick={() => openFinalize(g)} className="btn btn-primary text-[11px] py-1 px-2 flex items-center gap-1">
                      <FiCheckCircle size={12} /> Finalize
                    </button>
                  </td>
                </tr>
              ))}
              {grouped.length === 0 && (
                <tr><td colSpan="12" className="text-center py-8 text-gray-400">No open price requests. ✨</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 2 — All requests (raise / status / personal) */}
      {(tab === 'raise' || !isQuoter) && (
        <div className="card p-0 overflow-x-auto">
          <table className="text-sm w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Company</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Item</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Size / Spec / Make</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Type</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Raised By</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Final Rate</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Status</th>
                <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50/60">
                  <td className="px-3 py-2 text-[12px]">{r.site_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 font-medium">{r.item_name}<div className="text-[10px] text-gray-400">{r.uom}</div></td>
                  <td className="px-3 py-2 text-[11px] text-gray-600">{[r.size, r.specification, r.make].filter(Boolean).join(' · ') || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2"><span className="text-[10px] font-bold uppercase">{r.item_type}</span></td>
                  <td className="px-3 py-2 text-[11px]">{r.raised_by_name || '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{r.final_rate ? <><span className="font-semibold">₹ {r.final_rate}</span><div className="text-[10px] text-gray-500">{r.final_vendor_name}</div></> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2">{statusBadge(r.status)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status !== 'added' && (r.raised_by === user?.id || isAdmin()) && (
                      <button onClick={() => remove(r.id)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>
                    )}
                    {r.status === 'added' && r.item_master_id && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700"><FiTag size={10} /> in Master</span>}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr><td colSpan="8" className="text-center py-8 text-gray-400">No requests yet — click "Raise Price Request" to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* RAISE MODAL */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Raise Price Request" wide>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            For items NOT yet in the Item Master. Purchase team will collect 3 vendor quotes, pick a final rate, and the item will be added to Master automatically.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Company Name <span className="text-gray-400 font-normal text-[10px]">(optional · type freely)</span></label>
              <input
                className="input"
                placeholder="e.g. M/s Sardarshahar Agri Energy Pvt. Ltd"
                value={form.site_name || ''}
                onChange={e => setForm({ ...form, site_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Item Name <span className="text-red-500">*</span></label>
              <input className="input" required placeholder="e.g. Stainless Steel Coupling" value={form.item_name} onChange={e => setForm({ ...form, item_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Size</label>
              <input className="input" placeholder="e.g. 25mm" value={form.size} onChange={e => setForm({ ...form, size: e.target.value })} />
            </div>
            <div>
              <label className="label">Specification</label>
              <input className="input" placeholder="e.g. SS 304" value={form.specification} onChange={e => setForm({ ...form, specification: e.target.value })} />
            </div>
            <div>
              <label className="label">Make</label>
              <input className="input" placeholder="e.g. Astral / Polycab" value={form.make} onChange={e => setForm({ ...form, make: e.target.value })} />
            </div>
            <div>
              <label className="label">UOM</label>
              <input className="input" placeholder="PCS / MTR / KG / LTR" value={form.uom} onChange={e => setForm({ ...form, uom: e.target.value })} />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="select" value={form.item_type} onChange={e => setForm({ ...form, item_type: e.target.value })}>
                <option value="PO">PO (Purchase Order — Chargeable)</option>
                <option value="FOC">FOC (Free of Cost)</option>
                <option value="RGP">RGP (Returnable Gate Pass)</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <textarea className="input" rows="2" placeholder="Why is this needed? Any urgency?" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Submit Request</button>
          </div>
        </form>
      </Modal>

      {/* FINALIZE MODAL */}
      {finalModal && (
        <Modal isOpen={!!finalModal} onClose={() => { setFinalModal(null); setFinalForm({}); }} title={`Finalize — ${finalModal.item_name}`}>
          <form onSubmit={submitFinalize} className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <p className="font-semibold text-gray-700">Vendor quotes for this item:</p>
              {[1, 2, 3].map(n => finalModal[`vendor${n}_name`] && +finalModal[`vendor${n}_rate`] > 0 && (
                <div key={n} className="flex justify-between">
                  <span>{finalModal[`vendor${n}_name`]}</span>
                  <span className="font-mono">Rs {finalModal[`vendor${n}_rate`]} {finalModal[`vendor${n}_terms`] ? `· ${finalModal[`vendor${n}_terms`]}` : ''}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Final Vendor *</label>
                <select
                  className="select"
                  required
                  value={finalForm.final_vendor_name || ''}
                  onChange={e => {
                    const name = e.target.value;
                    let n = 0;
                    for (const i of [1, 2, 3]) {
                      if (finalModal[`vendor${i}_name`] === name) { n = i; break; }
                    }
                    setFinalForm(f => ({
                      ...f,
                      final_vendor_name: name,
                      final_rate: n ? +finalModal[`vendor${n}_rate`] || 0 : f.final_rate,
                      final_terms: n ? finalModal[`vendor${n}_terms`] || '' : f.final_terms,
                    }));
                  }}
                >
                  <option value="">— Pick vendor —</option>
                  {[1, 2, 3].map(n => {
                    const name = finalModal[`vendor${n}_name`];
                    const rate = +finalModal[`vendor${n}_rate`] || 0;
                    if (!name || rate <= 0) return null;
                    const terms = finalModal[`vendor${n}_terms`] || '';
                    return <option key={n} value={name}>{name} — Rs {rate}{terms ? ' · ' + terms : ''}</option>;
                  })}
                </select>
              </div>
              <div>
                <label className="label">Final Rate (₹) *</label>
                <input className="input" type="number" min="0" required value={finalForm.final_rate || ''} onChange={e => setFinalForm(f => ({ ...f, final_rate: +e.target.value }))} />
              </div>
              <div>
                <label className="label">Payment Terms</label>
                <select className="select" value={finalForm.final_terms || ''} onChange={e => setFinalForm(f => ({ ...f, final_terms: e.target.value }))}>
                  <option value="">— Select —</option>
                  <option value="Advance">Advance</option>
                  <option value="Credit">Credit</option>
                </select>
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 text-[12px] text-gray-700">
                  <input type="checkbox" checked={finalForm.propagate_to_group !== false} onChange={e => setFinalForm(f => ({ ...f, propagate_to_group: e.target.checked }))} />
                  Apply to all {finalModal.request_ids?.length || 1} merged request(s)
                </label>
              </div>
            </div>
            <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-[11px] text-emerald-800">
              💡 On finalize, this item will be auto-added to the Item Master with the final rate.
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => { setFinalModal(null); setFinalForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Finalize & Add to Master</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
