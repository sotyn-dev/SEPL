import { useState, useEffect, Fragment } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiCheck, FiX, FiTrash2, FiExternalLink } from 'react-icons/fi';

const EMPTY_ITEM = { po_item_id: '', item_master_id: '', description: '', make: '', quantity: 1, unit: 'nos', item_type: '', boq_qty: 0, remaining_qty: null, manual: false };

export default function Procurement() {
  const { canDelete, user } = useAuth();
  const [tab, setTab] = useState('indents');
  const [indents, setIndents] = useState([]);
  const [vendorPos, setVendorPos] = useState([]);
  const [purchaseBills, setPurchaseBills] = useState([]);
  const [deliveryNotes, setDeliveryNotes] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [itemRates, setItemRates] = useState([]); // indent items with their 3-vendor rates + final
  const [pendingPoItems, setPendingPoItems] = useState([]); // finalized items not yet in a Vendor PO
  const [indentItemsForPo, setIndentItemsForPo] = useState([]); // items of the currently picked indent (for the Create Vendor PO modal)
  const [poItemSelection, setPoItemSelection] = useState({}); // { indent_item_id: { checked, quantity, rate, terms, credit_days } }
  const [ratesFilter, setRatesFilter] = useState('all'); // all | pending | quoted | finalized
  const [finalModal, setFinalModal] = useState(null); // { row } being finalized
  const [finalForm, setFinalForm] = useState({});
  const [masterItems, setMasterItems] = useState([]); // Item Master dropdown source
  const [boqItems, setBoqItems] = useState([]); // BOQ items for the currently-selected site
  const [boqLoading, setBoqLoading] = useState(false);
  const [boqDiag, setBoqDiag] = useState(null); // backend diagnostic when BOQ is empty/partial
  const [uploadingBoq, setUploadingBoq] = useState(false);
  const [manualMode, setManualMode] = useState(false); // when true, items are typed free-text (no BOQ lookup)
  const [sites, setSites] = useState([]);         // unique site names (Business Book)
  const [employees, setEmployees] = useState([]); // for "Raised By" dropdown
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [indentItems, setIndentItems] = useState([{ ...EMPTY_ITEM }]);

  const load = () => {
    api.get('/procurement/indents').then(r => setIndents(r.data));
    api.get('/procurement/vendor-po').then(r => setVendorPos(r.data));
    api.get('/procurement/purchase-bills').then(r => setPurchaseBills(r.data));
    api.get('/procurement/delivery-notes').then(r => setDeliveryNotes(r.data));
    api.get('/procurement/vendors').then(r => setVendors(r.data));
    api.get('/procurement/item-rates').then(r => setItemRates(r.data || [])).catch(() => setItemRates([]));
    api.get('/procurement/pending-po-items').then(r => setPendingPoItems(r.data || [])).catch(() => setPendingPoItems([]));
    api.get('/item-master/dropdown').then(r => setMasterItems(r.data || [])).catch(() => setMasterItems([]));
    api.get('/procurement/sites').then(r => {
      // Response is one row per unique name: [{ name, lead_no }]
      setSites(r.data || []);
    }).catch(() => setSites([]));
    api.get('/hr/employees').then(r => setEmployees((r.data || []).filter(e => !e.status || e.status === 'active'))).catch(() => setEmployees([]));
  };
  useEffect(() => { load(); }, []);

  // Site dropdown shows one row per unique name. BOQ/PO items are aggregated
  // across every Business Book entry matching that name, so picking
  // 'CONSERN PHARMA' pools items from all CONSERN PHARMA projects.
  const reloadBoq = async (siteName) => {
    if (!siteName) { setBoqItems([]); setBoqDiag(null); return; }
    setBoqLoading(true);
    try {
      const r = await api.get('/procurement/boq-items', { params: { site_name: siteName } });
      const payload = r.data;
      const list = Array.isArray(payload) ? payload : (payload?.items || []);
      const diag = Array.isArray(payload) ? null : (payload?.diagnostic || null);
      setBoqItems(list);
      setBoqDiag(diag);
    } catch { setBoqItems([]); setBoqDiag(null); }
    setBoqLoading(false);
  };
  const handleSiteChange = (site) => {
    // `site` is the object from SearchableSelect ({ name, lead_no }).
    setForm(f => ({ ...f, site_name: site?.name || '', lead_no: site?.lead_no || '' }));
    setIndentItems([{ ...EMPTY_ITEM }]);
    setBoqDiag(null);
    setManualMode(false);
    reloadBoq(site?.name || '');
  };

  // Fetch items from the BOQ already attached to this site's PO. No
  // re-upload — server parses boq_file_link on disk or falls back to
  // boq_items via the linked quotation, then saves into po_items so
  // Remaining tracking works across indents.
  const fetchExistingBoq = async () => {
    if (!form.site_name) return toast.error('Pick a site first');
    setUploadingBoq(true);
    try {
      const r = await api.post('/procurement/fetch-existing-boq', { site_name: form.site_name });
      toast.success(`Fetched ${r.data.items_saved} items from ${r.data.source === 'po_file' ? `PO ${r.data.po_number} BOQ file` : 'BOQ module'}`);
      reloadBoq(form.site_name);
    } catch (err) { toast.error(err.response?.data?.error || 'Fetch failed'); }
    setUploadingBoq(false);
  };

  // Fallback — if truly nothing on file, admin can still upload.
  const uploadBoqForSite = async (file) => {
    if (!form.site_name) return toast.error('Pick a site first');
    setUploadingBoq(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('site_name', form.site_name);
      const r = await api.post('/procurement/upload-boq-for-site', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`BOQ saved — ${r.data.items_saved} items`);
      reloadBoq(form.site_name);
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    setUploadingBoq(false);
  };

  // Picking an actual SKU from Item Master for this row. One BOQ line often
  // maps to one PO item plus a few FOC accessories — each gets its own row
  // that references the same BOQ item but a different Item Master entry.
  const pickMasterItem = (i, master) => {
    const n = [...indentItems];
    n[i] = {
      ...n[i],
      item_master_id: master?.id || '',
      description: master ? [master.item_name, master.specification, master.size].filter(Boolean).join(' / ') : n[i].description,
      unit: master?.uom?.toLowerCase() || n[i].unit || 'nos',
      item_type: master?.type || n[i].item_type || '',
      make: master?.make || n[i].make || '',
    };
    setIndentItems(n);
  };

  // Picking a BOQ item for this row — fills description / unit / type / make
  // and copies BOQ qty + remaining so the UI can show "BOQ 100 · Rem 60"
  // like DPR does. FOC items have remaining = null (hidden in UI).
  const pickBoqItem = (i, item) => {
    const n = [...indentItems];
    n[i] = {
      ...n[i],
      po_item_id: item?.id || '',
      item_master_id: item?.item_master_id || '',
      description: item?.description || '',
      unit: (item?.unit || n[i].unit || 'nos').toString().toLowerCase(),
      item_type: item?.item_type || '',
      make: item?.item_make || n[i].make || '',
      boq_qty: item?.boq_qty || 0,
      remaining_qty: item?.remaining_qty,
      is_foc: !!item?.is_foc,
    };
    setIndentItems(n);
  };

  const saveIndent = async (e) => {
    e.preventDefault();
    if (!form.site_name) return toast.error('Site Name is required');
    if (!form.raised_by_name) return toast.error('Raised By is required');
    const clean = indentItems.filter(it => it.item_master_id || (it.description && it.description.trim()));
    if (clean.length === 0) return toast.error('Pick at least one item from Item Master');
    try {
      await api.post('/procurement/indents', {
        site_name: form.site_name,
        raised_by_name: form.raised_by_name,
        notes: form.notes || '',
        items: clean.map(it => ({ ...it, make: it.make || '' })),
      });
      toast.success('Indent raised — purchase team will take over');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Admin only — wipes all indents, vendor POs and related rows. Used when
  // mam wants a clean slate before a demo / new operating cycle.
  const wipeData = async () => {
    if (!confirm('Delete ALL Dispatches, Vendor POs, Purchase Bills and Delivery Notes?\n\nThis cannot be undone. Type YES in the next prompt to confirm.')) return;
    const c = prompt('Type YES (in capitals) to confirm permanent deletion:');
    if (c !== 'YES') return toast.error('Cancelled — nothing deleted');
    try {
      const r = await api.post('/procurement/admin/wipe-indents-pos');
      toast.success(`Cleared: ${r.data.counts.indents} dispatches, ${r.data.counts.vendor_pos} POs, ${r.data.counts.purchase_bills} bills, ${r.data.counts.delivery_notes} delivery notes`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Wipe failed'); }
  };

  const approveIndent = async (id, status) => {
    await api.put(`/procurement/indents/${id}`, { status });
    toast.success(`Indent ${status}`);
    load();
  };

  // Open the Create Vendor PO modal. If an indent is pre-selected (from the
  // Pending section), its items auto-load with finalized rates pre-filled.
  // Terms + Credit Days are PO-level — set once for the whole PO, applied
  // to every checked item on save.
  const openCreateVendorPo = (indentId = '') => {
    setForm({ indent_id: indentId || '', vendor_id: '', advance_required: false, terms: '', credit_days: 0 });
    setIndentItemsForPo([]);
    setPoItemSelection({});
    if (indentId) pickIndentForPo(indentId);
    setModal('vendorpo');
  };
  // When user picks an indent in the modal, load its items + seed selection
  // state with finalized rate/vendor/terms so the grid is ready to review.
  const pickIndentForPo = async (indentId) => {
    setForm(f => ({ ...f, indent_id: indentId }));
    if (!indentId) { setIndentItemsForPo([]); setPoItemSelection({}); return; }
    try {
      const r = await api.get(`/procurement/indents/${indentId}/items-for-po`);
      const items = r.data || [];
      setIndentItemsForPo(items);
      const sel = {};
      for (const it of items) {
        sel[it.indent_item_id] = {
          checked: it.rate_status === 'finalized' && it.in_po_count === 0,
          quantity: it.quantity || 0,
          rate: it.final_rate || 0,
        };
      }
      setPoItemSelection(sel);
      // Pre-fill vendor + terms + credit days from the finalized items if they agree
      const vendorNames = [...new Set(items.filter(i => i.final_vendor_name).map(i => i.final_vendor_name))];
      const termsSet = [...new Set(items.filter(i => i.final_terms).map(i => i.final_terms))];
      const daysSet = [...new Set(items.filter(i => i.final_credit_days).map(i => i.final_credit_days))];
      setForm(f => {
        const next = { ...f };
        if (vendorNames.length === 1) {
          const match = vendors.find(v => v.name?.toLowerCase() === vendorNames[0].toLowerCase());
          if (match) next.vendor_id = match.id;
        }
        if (termsSet.length === 1) next.terms = termsSet[0];
        if (daysSet.length === 1) next.credit_days = daysSet[0];
        return next;
      });
    } catch { toast.error('Failed to load indent items'); }
  };
  const togglePoItem = (iiId, patch) => {
    setPoItemSelection(prev => ({ ...prev, [iiId]: { ...prev[iiId], ...patch } }));
  };
  const poTotal = Object.values(poItemSelection).reduce((s, r) => s + (r.checked ? (+r.quantity || 0) * (+r.rate || 0) : 0), 0);

  const saveVendorPo = async (e) => {
    e.preventDefault();
    if (!form.vendor_id) return toast.error('Pick a vendor');
    // Terms + Credit Days are PO-level; stamp them onto every checked item.
    const poTerms = form.terms || null;
    const poCreditDays = form.terms === 'Credit' ? (+form.credit_days || 0) : 0;
    const items = Object.entries(poItemSelection)
      .filter(([, v]) => v.checked && +v.quantity > 0 && +v.rate > 0)
      .map(([iiId, v]) => ({ indent_item_id: +iiId, quantity: +v.quantity, rate: +v.rate, terms: poTerms, credit_days: poCreditDays }));
    if (items.length === 0) return toast.error('Check at least one item with qty and rate');
    try {
      const r = await api.post('/procurement/vendor-po', {
        indent_id: form.indent_id || null,
        vendor_id: form.vendor_id,
        advance_required: !!form.advance_required,
        items,
      });
      toast.success(`Vendor PO ${r.data.po_number} created (${r.data.lines} items, Rs ${r.data.total_amount.toLocaleString()})`);
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const savePurchaseBill = async (e) => {
    e.preventDefault();
    await api.post('/procurement/purchase-bills', form);
    toast.success('Purchase bill added');
    setModal(false); load();
  };

  const saveDeliveryNote = async (e) => {
    e.preventDefault();
    await api.post('/procurement/delivery-notes', form);
    toast.success('Dispatch recorded');
    setModal(false); load();
  };

  // Order matches the flow: raise an indent first, purchase team collects
  // 3 vendor quotes + finalizes per item, then turns it into a vendor PO,
  // books the purchase bill, and finally the goods are dispatched to site.
  const tabs = [
    { id: 'indents', label: 'Raise Indent' },
    { id: 'rates', label: 'Vendor Rates' },
    { id: 'vendorpo', label: 'Vendor PO' },
    { id: 'bills', label: 'Purchase Bills' },
    { id: 'delivery', label: 'Dispatch' },
  ];

  // --- Vendor Rates (Step 1 + 2) helpers ---
  // Patch a single field on an item's rate row and save to server. Keeps the
  // UI snappy by updating local state optimistically.
  const updateItemRate = async (indentItemId, patch) => {
    // Optimistically merge the patch, then derive rate_status locally the same
    // way the backend does (quoted once any vendor has rate > 0, else pending).
    // Without this, the badge stays "pending" and the Finalize button stays
    // disabled until a full page reload.
    setItemRates(prev => prev.map(r => {
      if (r.indent_item_id !== indentItemId) return r;
      const merged = { ...r, ...patch };
      const anyRate = [merged.vendor1_rate, merged.vendor2_rate, merged.vendor3_rate].some(v => Number(v) > 0);
      if (merged.rate_status !== 'finalized') merged.rate_status = anyRate ? 'quoted' : 'pending';
      return merged;
    }));
    try {
      const { data } = await api.post('/procurement/item-rates', { indent_item_id: indentItemId, ...patch });
      // Capture rate_id on the first save so Finalize can target the right row.
      if (data?.id) {
        setItemRates(prev => prev.map(r => r.indent_item_id === indentItemId && !r.rate_id ? { ...r, rate_id: data.id } : r));
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const openFinalize = (row) => {
    // Default to the lowest non-zero vendor rate (best offer) when opening
    const quotes = [
      { name: row.vendor1_name, rate: row.vendor1_rate, terms: row.vendor1_terms, days: row.vendor1_credit_days },
      { name: row.vendor2_name, rate: row.vendor2_rate, terms: row.vendor2_terms, days: row.vendor2_credit_days },
      { name: row.vendor3_name, rate: row.vendor3_rate, terms: row.vendor3_terms, days: row.vendor3_credit_days },
    ].filter(q => q.name && q.rate > 0).sort((a, b) => a.rate - b.rate);
    const best = quotes[0] || {};
    setFinalForm({
      rate_id: row.rate_id, row,
      final_rate: row.final_rate || best.rate || 0,
      final_vendor_name: row.final_vendor_name || best.name || '',
      final_terms: row.final_terms || best.terms || '',
      final_credit_days: row.final_credit_days || best.days || 0,
    });
    setFinalModal(row);
  };
  const submitFinalize = async (e) => {
    e.preventDefault();
    if (!finalForm.rate_id) return toast.error('Enter a vendor rate first');
    try {
      await api.post(`/procurement/item-rates/${finalForm.rate_id}/finalize`, finalForm);
      toast.success('Rate finalized');
      setFinalModal(null); setFinalForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">{tabs.map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>{t.label}</button>
      ))}</div>

      {tab === 'indents' && (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="font-semibold">Raise Indent</h3>
            <button onClick={() => { setForm({ notes: '', site_name: '', raised_by_name: user?.name || '' }); setIndentItems([{ ...EMPTY_ITEM }]); setBoqItems([]); setModal('indent'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Raise Indent</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>Indent No</th><th>Date</th><th>Site</th><th>Raised By</th><th>BOQ</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {indents.map(i => (
                <tr key={i.id}>
                  <td className="font-medium">{i.indent_number}</td>
                  <td className="text-xs text-gray-600">{i.created_at ? new Date(i.created_at).toLocaleString() : (i.indent_date || '—')}</td>
                  <td>{i.site_name || i.client_name || <span className="text-gray-400">—</span>}</td>
                  <td>{i.raised_by_name || i.created_by_name}</td>
                  <td>
                    {i.boq_file_link
                      ? <a href={i.boq_file_link} target="_blank" rel="noreferrer" className="text-red-600 hover:underline flex items-center gap-1 text-xs"><FiExternalLink size={12} /> View</a>
                      : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={i.status} /></td>
                  <td>
                    <div className="flex gap-1 items-center">
                      {i.status === 'submitted' && (
                        <>
                          <button onClick={() => approveIndent(i.id, 'approved')} className="btn btn-success text-xs py-1 px-2">Approve</button>
                          <button onClick={() => approveIndent(i.id, 'rejected')} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                        </>
                      )}
                      {i.status === 'draft' && <button onClick={() => approveIndent(i.id, 'submitted')} className="btn btn-primary text-xs py-1 px-2">Submit</button>}
                      {canDelete('procurement') && <button onClick={async () => {
                        if (!confirm(`Delete indent "${i.indent_number}"?`)) return;
                        try { await api.delete(`/procurement/indents/${i.id}`); toast.success('Deleted'); load(); }
                        catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                      }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
              {indents.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No indents yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'rates' && (
        <>
          {/* Shared vendor name suggestions — used by all Name inputs on this tab */}
          <datalist id="vendor-options">
            {vendors.map(v => <option key={v.id} value={v.name} />)}
          </datalist>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h3 className="font-semibold">Item-wise Vendor Rates</h3>
              <p className="text-xs text-gray-500">Step 1: enter up to 3 vendor quotes per indent item. Step 2: finalize the best rate.</p>
            </div>
            <div className="flex gap-1 flex-wrap">
              {['all','pending','quoted','finalized'].map(f => (
                <button key={f} onClick={() => setRatesFilter(f)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${ratesFilter === f ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
                  <span className="ml-1 opacity-80">({itemRates.filter(r => f === 'all' ? true : (r.rate_status || 'pending') === f).length})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Desktop table */}
          <div className="card p-0 overflow-x-auto hidden lg:block">
            <table className="text-xs min-w-[1500px]">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-2 py-2 text-left" rowSpan="2">Indent</th>
                  <th className="px-2 py-2 text-left" rowSpan="2">Item</th>
                  <th className="px-2 py-2" rowSpan="2">Qty</th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 1</th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 2</th>
                  <th className="px-2 py-2 text-center" colSpan="3">Vendor 3</th>
                  <th className="px-2 py-2" rowSpan="2">Status</th>
                  <th className="px-2 py-2" rowSpan="2">Final</th>
                </tr>
                <tr className="bg-gray-50 text-[10px]">
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                  <th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Terms</th>
                </tr>
              </thead>
              <tbody>
                {itemRates.filter(r => ratesFilter === 'all' ? true : (r.rate_status || 'pending') === ratesFilter).map(r => {
                  const stat = r.rate_status || 'pending';
                  const statColor = stat === 'finalized' ? 'bg-emerald-100 text-emerald-700' : stat === 'quoted' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700';
                  return (
                    <tr key={r.indent_item_id} className="border-b hover:bg-red-50/30">
                      <td className="px-2 py-2 whitespace-nowrap"><div className="font-medium text-red-700">{r.indent_number}</div><div className="text-[10px] text-gray-400">{r.site_name}</div></td>
                      <td className="px-2 py-2 min-w-[260px]">
                        {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                        <div className="whitespace-normal leading-snug font-medium">{[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ')}</div>
                        {r.make && <div className="text-[10px] text-gray-400 mt-0.5">Make: {r.make}</div>}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold whitespace-nowrap">{r.qty} {r.unit}</td>
                      {[1,2,3].map(n => (
                        <Fragment key={n}>
                          <td className="px-1 py-1">
                            <input
                              className="input text-[11px] px-2 py-1 w-40 min-w-[10rem]"
                              placeholder="Vendor name"
                              list="vendor-options"
                              value={r[`vendor${n}_name`] || ''}
                              onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_name`]: e.target.value })}
                            />
                          </td>
                          <td className="px-1 py-1"><input className="input text-[11px] px-2 py-1 w-24 min-w-[6rem] text-right" type="number" placeholder="0" value={r[`vendor${n}_rate`] || ''} onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_rate`]: +e.target.value })} /></td>
                          <td className="px-1 py-1">
                            <select className="select text-[11px] px-2 py-1 w-28 min-w-[7rem]" value={r[`vendor${n}_terms`] || ''} onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_terms`]: e.target.value })}>
                              <option value="">—</option>
                              <option value="Advance">Advance</option>
                              <option value="Credit">Credit</option>
                            </select>
                          </td>
                        </Fragment>
                      ))}
                      <td className="px-2 py-2"><span className={`badge ${statColor}`}>{stat}</span></td>
                      <td className="px-2 py-2">
                        {stat === 'finalized'
                          ? <div className="text-[11px]"><div className="font-semibold text-emerald-700">{r.final_vendor_name}</div><div>Rs {r.final_rate}</div></div>
                          : <button onClick={() => openFinalize(r)} disabled={stat === 'pending'} className="btn btn-primary text-[11px] px-2 py-1 disabled:opacity-40">Finalize</button>}
                      </td>
                    </tr>
                  );
                })}
                {itemRates.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No indent items yet — raise an indent first.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="lg:hidden space-y-2">
            {itemRates.filter(r => ratesFilter === 'all' ? true : (r.rate_status || 'pending') === ratesFilter).map(r => {
              const stat = r.rate_status || 'pending';
              return (
                <div key={r.indent_item_id} className="card p-3 space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium text-red-700 text-xs">{r.indent_number}</div>
                      {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                      <div className="text-sm font-medium line-clamp-2">{[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ')}</div>
                      <div className="text-[10px] text-gray-400">{r.site_name} · {r.qty} {r.unit}{r.make ? ` · ${r.make}` : ''}</div>
                    </div>
                    <span className={`badge ${stat === 'finalized' ? 'badge-green' : stat === 'quoted' ? 'badge-blue' : 'badge-yellow'}`}>{stat}</span>
                  </div>
                  {[1,2,3].map(n => (
                    <div key={n} className="border rounded p-2 bg-gray-50">
                      <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">Vendor {n}</div>
                      <div className="grid grid-cols-3 gap-2">
                        <input className="input text-xs" placeholder="Name" list="vendor-options" value={r[`vendor${n}_name`] || ''} onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_name`]: e.target.value })} />
                        <input className="input text-xs" type="number" placeholder="Rate" value={r[`vendor${n}_rate`] || ''} onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_rate`]: +e.target.value })} />
                        <select className="select text-xs" value={r[`vendor${n}_terms`] || ''} onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_terms`]: e.target.value })}>
                          <option value="">— Terms —</option>
                          <option value="Advance">Advance</option>
                          <option value="Credit">Credit</option>
                        </select>
                      </div>
                    </div>
                  ))}
                  {stat === 'finalized'
                    ? <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs"><b className="text-emerald-700">Final:</b> {r.final_vendor_name} @ Rs {r.final_rate}</div>
                    : <button onClick={() => openFinalize(r)} disabled={stat === 'pending'} className="btn btn-primary text-xs w-full disabled:opacity-40">Finalize Rate</button>}
                </div>
              );
            })}
            {itemRates.length === 0 && <div className="card text-center py-8 text-gray-400">No indent items yet.</div>}
          </div>
        </>
      )}

      {tab === 'vendorpo' && (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="font-semibold">Vendor Purchase Orders</h3>
            <button onClick={() => openCreateVendorPo('')} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Vendor PO</button>
          </div>

          {/* Pending for PO — finalized items that haven't been covered by any Vendor PO yet */}
          {pendingPoItems.length > 0 && (
            <div className="card p-3 bg-amber-50 border border-amber-200">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-amber-800 text-sm">Pending for Vendor PO <span className="text-xs font-normal text-amber-600">({pendingPoItems.length} item{pendingPoItems.length === 1 ? '' : 's'})</span></h4>
                <span className="text-[11px] text-amber-700">Items with a finalized rate but no Vendor PO yet</span>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr className="bg-amber-100/50">
                    <th className="px-2 py-1 text-left">Indent</th>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1">Qty</th>
                    <th className="px-2 py-1">Final Rate</th>
                    <th className="px-2 py-1">Final Vendor</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {pendingPoItems.map(p => {
                      // Prefer Item Master values for display (what mam picked in the indent)
                      const displayName = [p.master_name || p.description, p.specification, p.size].filter(Boolean).join(' / ');
                      return (
                        <tr key={p.indent_item_id} className="border-b border-amber-100">
                          <td className="px-2 py-1.5 whitespace-nowrap"><b className="text-red-700">{p.indent_number}</b><div className="text-[10px] text-gray-500">{p.site_name}</div></td>
                          <td className="px-2 py-1.5 max-w-[320px]">
                            {p.item_code && <div className="text-[10px] font-mono text-gray-500">[{p.item_code}]</div>}
                            <div className="whitespace-normal leading-snug font-medium">{displayName}</div>
                            <div className="text-[10px] text-gray-400 flex gap-2">
                              {p.make && <span>Make: {p.make}</span>}
                              {p.item_type && <span className={`font-bold ${p.item_type === 'FOC' ? 'text-emerald-600' : p.item_type === 'RGP' ? 'text-amber-600' : 'text-red-600'}`}>{p.item_type}</span>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center">{p.quantity} {p.unit || p.uom}</td>
                          <td className="px-2 py-1.5 text-right">{p.final_rate ? `Rs ${p.final_rate}` : <span className="text-gray-400">—</span>}</td>
                          <td className="px-2 py-1.5">{p.final_vendor_name || <span className="text-gray-400">—</span>}</td>
                          <td className="px-2 py-1.5">
                            <span className={`badge ${p.rate_status === 'finalized' ? 'badge-green' : 'badge-yellow'}`}>{p.rate_status || 'pending'}</span>
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => openCreateVendorPo(p.indent_id)} className="btn btn-primary text-[10px] px-2 py-1">Create PO</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>PO Number</th><th>Vendor</th><th>Amount</th><th>Advance</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {vendorPos.map(v => (
                <tr key={v.id}>
                  <td className="font-medium">{v.po_number}</td><td>{v.vendor_name}</td><td>Rs {v.total_amount?.toLocaleString()}</td>
                  <td>{v.advance_required ? (v.advance_paid ? 'Paid' : 'Required') : 'N/A'}</td>
                  <td><StatusBadge status={v.status} /></td>
                  <td>{canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete vendor PO "${v.po_number}"?`)) return;
                    try { await api.delete(`/procurement/vendor-po/${v.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
                </tr>
              ))}
              {vendorPos.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No vendor POs yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'bills' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Purchase Bills</h3>
            <button onClick={() => { setForm({ vendor_id: '', bill_number: '', bill_date: '', amount: 0, gst_amount: 0, total_amount: 0 }); setModal('bill'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Bill</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>Bill No</th><th>Vendor</th><th>Date</th><th>Amount</th><th>GST</th><th>Total</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {purchaseBills.map(b => (
                <tr key={b.id}>
                  <td className="font-medium">{b.bill_number}</td><td>{b.vendor_name}</td><td>{b.bill_date}</td>
                  <td>Rs {b.amount?.toLocaleString()}</td><td>Rs {b.gst_amount?.toLocaleString()}</td>
                  <td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td>
                  <td><StatusBadge status={b.payment_status} /></td>
                  <td>{canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete purchase bill "${b.bill_number}"?`)) return;
                    try { await api.delete(`/procurement/purchase-bills/${b.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
                </tr>
              ))}
              {purchaseBills.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No bills yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'delivery' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Dispatch to Site</h3>
            <button onClick={() => { setForm({ vendor_po_id: '', delivery_date: '', notes: '' }); setModal('delivery'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Dispatch</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>ID</th><th>Date</th><th>Received By</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {deliveryNotes.map(d => (
                <tr key={d.id}>
                  <td>#{d.id}</td><td>{d.delivery_date}</td><td>{d.received_by_name}</td>
                  <td><StatusBadge status={d.status} /></td>
                  <td>{canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete delivery note #${d.id}?`)) return;
                    try { await api.delete(`/procurement/delivery-notes/${d.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
                </tr>
              ))}
              {deliveryNotes.length === 0 && <tr><td colSpan="5" className="text-center py-8 text-gray-400">No delivery notes yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* Indent Modal */}
      <Modal isOpen={modal === 'indent'} onClose={() => setModal(false)} title="Raise Purchase Indent" wide>
        <form onSubmit={saveIndent} className="space-y-4">
          {/* Auto timestamp — mirrors the 'Dated' field on the physical form */}
          <div className="text-[11px] text-gray-500 bg-gray-50 rounded px-3 py-1.5 flex justify-between items-center">
            <span>Dated: <b className="text-gray-700">{new Date().toLocaleString()}</b></span>
            <span className="text-gray-400">(auto-recorded on create)</span>
          </div>
          {/* Header — Site from Business Book, Raised By from Employees. Stacks on mobile. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Site Name *</label>
              <SearchableSelect
                options={sites.map(s => ({ id: s.name, label: `${s.lead_no ? '[' + s.lead_no + '] ' : ''}${s.name}`, ...s }))}
                value={form.site_name || null}
                valueKey="id" displayKey="label"
                placeholder="Search site / company / project name…"
                onChange={(s) => handleSiteChange(s)}
              />
              <p className="text-[10px] text-gray-400 mt-0.5">
                {form.site_name
                  ? (boqLoading ? 'Loading BOQ…' : `${boqItems.length} BOQ item${boqItems.length === 1 ? '' : 's'} available for this site`)
                  : 'Pick a site first — its BOQ items will load below.'}
              </p>
            </div>
            <div>
              <label className="label">Raised By *</label>
              <SearchableSelect
                options={employees.map(e => ({ id: e.name, label: e.name, ...e }))}
                value={form.raised_by_name || null}
                valueKey="id" displayKey="label"
                placeholder="Search employee…"
                onChange={(e) => setForm({ ...form, raised_by_name: e?.id || '' })}
              />
            </div>
          </div>

          <h4 className="font-semibold text-sm">
            Items <span className="text-gray-400 font-normal">(pick from Item Master — "item wise sheet")</span>
          </h4>
          {!form.site_name ? (
            <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center text-sm text-gray-500 bg-gray-50">
              Pick a site above, then add items from the Item Master.
            </div>
          ) : (
            <>
              {/* Desktop column headers — hidden on mobile, where each row is a stacked card */}
              <div className="hidden md:grid gap-2 text-[10px] font-bold text-gray-500 uppercase px-1" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr)) auto' }}>
                <div className="col-span-6">Item (Item Master)</div>
                <div className="col-span-2">Make</div>
                <div>Qty</div>
                <div>Unit</div>
                <div className="col-span-2">Type</div>
                <div></div>
              </div>
              <div className="space-y-3 md:space-y-2">
                {indentItems.map((item, i) => {
                  const t = String(item.item_type || '').toUpperCase();
                  const typeClass = t === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : t === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : t === 'PO' ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-gray-50 text-gray-500 border-gray-200';

                  const masterPicker = (
                    <SearchableSelect
                      options={masterItems.map(m => ({ id: m.id, label: `[${m.item_code}] ${m.display_name || m.item_name}${m.type ? ' · ' + m.type : ''}`, ...m }))}
                      value={item.item_master_id || null} valueKey="id" displayKey="label"
                      placeholder="Search Item Master…"
                      onChange={(m) => pickMasterItem(i, m)}
                    />
                  );
                  const makeInput = <input className="input text-sm" placeholder="Make" value={item.make || ''} onChange={e => { const n = [...indentItems]; n[i].make = e.target.value; setIndentItems(n); }} />;
                  const qtyInput = <input className="input text-sm" type="number" min="0" placeholder="Qty" value={item.quantity} onChange={e => { const n = [...indentItems]; n[i].quantity = +e.target.value; setIndentItems(n); }} />;
                  const unitInput = <input className="input text-sm" placeholder="Unit" value={item.unit} onChange={e => { const n = [...indentItems]; n[i].unit = e.target.value; setIndentItems(n); }} />;
                  const typeBox = (
                    <div className={`text-center text-[11px] font-bold uppercase px-2 py-1.5 rounded-lg border ${typeClass}`}>
                      <select className="bg-transparent w-full outline-none text-[11px]" value={item.item_type || ''} onChange={e => { const n = [...indentItems]; n[i].item_type = e.target.value; setIndentItems(n); }}>
                        <option value="">—</option><option value="PO">PO</option><option value="FOC">FOC</option><option value="RGP">RGP</option>
                      </select>
                    </div>
                  );
                  const removeBtn = (
                    <button type="button" onClick={() => setIndentItems(indentItems.filter((_, x) => x !== i))} className="p-1 text-gray-300 hover:text-red-600" title="Remove row">
                      {indentItems.length > 1 && <FiTrash2 size={14} />}
                    </button>
                  );

                  return (
                    <div key={i}>
                      {/* MOBILE: stacked card */}
                      <div className="md:hidden border rounded-lg p-2.5 bg-white space-y-2 relative">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-gray-400 uppercase">Row {i + 1}</span>
                          {indentItems.length > 1 && removeBtn}
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Item (Item Master)</label>
                          {masterPicker}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Qty</label>
                            {qtyInput}
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Unit</label>
                            {unitInput}
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Type</label>
                            {typeBox}
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Make</label>
                          {makeInput}
                        </div>
                      </div>

                      {/* DESKTOP: wide grid row */}
                      <div className="hidden md:block">
                        <div className="grid gap-2 items-center" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr)) auto' }}>
                          <div className="col-span-6">{masterPicker}</div>
                          <div className="col-span-2">{makeInput}</div>
                          {qtyInput}
                          {unitInput}
                          <div className="col-span-2">{typeBox}</div>
                          {removeBtn}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => setIndentItems([...indentItems, { ...EMPTY_ITEM }])} className="btn btn-secondary text-xs">+ Add Item</button>
            </>
          )}
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Any remarks for Purchase…" /></div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary w-full sm:w-auto">Cancel</button>
            <button type="submit" className="btn btn-primary w-full sm:w-auto">Create Indent</button>
          </div>
        </form>
      </Modal>

      {/* Vendor PO Modal */}
      <Modal isOpen={modal === 'vendorpo'} onClose={() => setModal(false)} title="Create Vendor PO" wide>
        <form onSubmit={saveVendorPo} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Indent *</label>
              <select className="select" value={form.indent_id} onChange={e => pickIndentForPo(e.target.value)} required>
                <option value="">Select indent</option>
                {indents.map(i => <option key={i.id} value={i.id}>{i.indent_number} — {i.site_name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Vendor *</label>
              <select className="select" value={form.vendor_id} onChange={e => setForm({...form, vendor_id: +e.target.value})} required>
                <option value="">Select vendor</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Auto-picked from finalized rates if all items agree.</p>
            </div>
            <div>
              <label className="label">Payment Terms</label>
              <select className="select" value={form.terms || ''} onChange={e => setForm({ ...form, terms: e.target.value, credit_days: e.target.value === 'Credit' ? (form.credit_days || 0) : 0 })}>
                <option value="">— Select —</option>
                <option value="Advance">Advance</option>
                <option value="Credit">Credit</option>
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Applies to the whole PO (all items below).</p>
            </div>
            <div>
              <label className="label">Credit Days {form.terms !== 'Credit' && <span className="text-gray-400 font-normal">(only if Credit)</span>}</label>
              <input className="input" type="number" min="0" value={form.credit_days || 0} onChange={e => setForm({ ...form, credit_days: +e.target.value })} disabled={form.terms !== 'Credit'} />
            </div>
          </div>

          {/* Item grid — checkbox, rate, terms, credit days per row */}
          {form.indent_id && (
            <div className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 border-b text-xs font-semibold text-gray-600 uppercase flex items-center justify-between">
                <span>Items from this Indent</span>
                <span className="text-[10px] text-gray-500 normal-case">Tick items you want in this PO</span>
              </div>
              {indentItemsForPo.length === 0 ? (
                <div className="p-4 text-center text-sm text-gray-400">Loading items…</div>
              ) : (
                <div className="overflow-x-auto max-h-[360px]">
                  <table className="text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5"></th>
                        <th className="px-2 py-1.5 text-left">Item</th>
                        <th className="px-2 py-1.5">Qty</th>
                        <th className="px-2 py-1.5">Rate</th>
                        <th className="px-2 py-1.5">Terms</th>
                        <th className="px-2 py-1.5">Credit Days</th>
                        <th className="px-2 py-1.5">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indentItemsForPo.map(it => {
                        const s = poItemSelection[it.indent_item_id] || {};
                        const inPo = it.in_po_count > 0;
                        const amount = (s.checked ? (+s.quantity || 0) * (+s.rate || 0) : 0);
                        return (
                          <tr key={it.indent_item_id} className={`border-b ${inPo ? 'bg-gray-100 text-gray-400' : (s.checked ? 'bg-red-50/40' : '')}`}>
                            <td className="px-2 py-1.5 text-center">
                              <input type="checkbox" disabled={inPo} checked={!!s.checked} onChange={e => togglePoItem(it.indent_item_id, { checked: e.target.checked })} />
                            </td>
                            <td className="px-2 py-1.5 max-w-[320px]">
                              {it.item_code && <div className="text-[10px] font-mono text-gray-500">[{it.item_code}]</div>}
                              <div className="whitespace-normal leading-snug font-medium">{[it.master_name || it.description, it.specification, it.size].filter(Boolean).join(' / ')}</div>
                              {it.make && <div className="text-[10px] text-gray-400">Make: {it.make}</div>}
                              {inPo && <div className="text-[10px] text-gray-500 italic">Already in a Vendor PO</div>}
                            </td>
                            <td className="px-1 py-1"><input className="input text-[11px] px-1 py-0.5 w-16 text-right" type="number" disabled={inPo} value={s.quantity ?? it.quantity ?? 0} onChange={e => togglePoItem(it.indent_item_id, { quantity: +e.target.value })} /></td>
                            <td className="px-1 py-1"><input className="input text-[11px] px-1 py-0.5 w-20 text-right" type="number" disabled={inPo} value={s.rate ?? 0} onChange={e => togglePoItem(it.indent_item_id, { rate: +e.target.value })} /></td>
                            <td className="px-1 py-1">
                              <select className="select text-[11px] px-1 py-0.5 w-24" disabled={inPo} value={s.terms || ''} onChange={e => togglePoItem(it.indent_item_id, { terms: e.target.value })}>
                                <option value="">—</option>
                                <option value="Advance">Advance</option>
                                <option value="Credit">Credit</option>
                              </select>
                            </td>
                            <td className="px-1 py-1">
                              <input className="input text-[11px] px-1 py-0.5 w-16 text-right" type="number" disabled={inPo || s.terms !== 'Credit'} value={s.credit_days ?? 0} onChange={e => togglePoItem(it.indent_item_id, { credit_days: +e.target.value })} />
                            </td>
                            <td className="px-2 py-1.5 text-right font-semibold">{amount ? `Rs ${amount.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr><td colSpan="6" className="px-2 py-2 text-right font-bold">PO Total:</td>
                          <td className="px-2 py-2 text-right font-bold text-red-700">Rs {poTotal.toLocaleString()}</td></tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.advance_required} onChange={e => setForm({...form, advance_required: e.target.checked})} /> Advance Required</label>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create Vendor PO</button>
          </div>
        </form>
      </Modal>

      {/* Purchase Bill Modal */}
      <Modal isOpen={modal === 'bill'} onClose={() => setModal(false)} title="Add Purchase Bill">
        <form onSubmit={savePurchaseBill} className="space-y-4">
          <div><label className="label">Vendor *</label><select className="select" value={form.vendor_id} onChange={e => setForm({...form, vendor_id: e.target.value})} required><option value="">Select</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
            <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
            <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value, total_amount: +e.target.value + (form.gst_amount || 0)})} /></div>
            <div><label className="label">GST Amount</label><input className="input" type="number" value={form.gst_amount} onChange={e => setForm({...form, gst_amount: +e.target.value, total_amount: (form.amount || 0) + +e.target.value})} /></div>
          </div>
          <div><label className="label">Total</label><input className="input" type="number" value={form.total_amount} readOnly /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* Delivery / Dispatch Modal */}
      <Modal isOpen={modal === 'delivery'} onClose={() => setModal(false)} title="Record Dispatch to Site">
        <form onSubmit={saveDeliveryNote} className="space-y-4">
          <div><label className="label">Vendor PO</label><select className="select" value={form.vendor_po_id} onChange={e => setForm({...form, vendor_po_id: e.target.value})}><option value="">Select</option>{vendorPos.map(v => <option key={v.id} value={v.id}>{v.po_number} - {v.vendor_name}</option>)}</select></div>
          <div><label className="label">Delivery Date</label><input className="input" type="date" value={form.delivery_date} onChange={e => setForm({...form, delivery_date: e.target.value})} /></div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* Finalize Rate Modal — Step 2 of the item-wise rate flow */}
      <Modal isOpen={!!finalModal} onClose={() => { setFinalModal(null); setFinalForm({}); }} title={finalModal ? `Finalize — ${finalModal.description?.slice(0, 60) || 'Item'}` : 'Finalize'}>
        <form onSubmit={submitFinalize} className="space-y-3">
          {/* Quote comparison for quick reference */}
          {finalModal && (
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <p className="font-semibold text-gray-700">Vendor quotes for this item:</p>
              {[1,2,3].map(n => finalModal[`vendor${n}_name`] && finalModal[`vendor${n}_rate`] > 0 && (
                <div key={n} className="flex justify-between">
                  <span>{finalModal[`vendor${n}_name`]}</span>
                  <span className="font-mono">Rs {finalModal[`vendor${n}_rate`]} {finalModal[`vendor${n}_terms`] ? `· ${finalModal[`vendor${n}_terms`]}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="label">Final Vendor *</label><input className="input" required list="vendor-options" value={finalForm.final_vendor_name || ''} onChange={e => setFinalForm(f => ({ ...f, final_vendor_name: e.target.value }))} /></div>
            <div><label className="label">Final Rate (Rs) *</label><input className="input" type="number" required value={finalForm.final_rate || ''} onChange={e => setFinalForm(f => ({ ...f, final_rate: +e.target.value }))} /></div>
            <div>
              <label className="label">Payment Terms</label>
              <select className="select" value={finalForm.final_terms || ''} onChange={e => setFinalForm(f => ({ ...f, final_terms: e.target.value }))}>
                <option value="">— Select —</option>
                <option value="Advance">Advance</option>
                <option value="Credit">Credit</option>
              </select>
            </div>
            <div><label className="label">Credit Days (if Credit)</label><input className="input" type="number" value={finalForm.final_credit_days || 0} onChange={e => setFinalForm(f => ({ ...f, final_credit_days: +e.target.value }))} disabled={finalForm.final_terms !== 'Credit'} /></div>
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={() => { setFinalModal(null); setFinalForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Finalize Rate</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
