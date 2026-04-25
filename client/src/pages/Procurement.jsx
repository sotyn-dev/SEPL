import { useState, useEffect, Fragment } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiCheck, FiX, FiTrash2, FiExternalLink, FiChevronDown, FiChevronRight } from 'react-icons/fi';

const EMPTY_ITEM = { po_item_id: '', item_master_id: '', description: '', make: '', quantity: 1, unit: 'nos', item_type: '', boq_qty: 0, remaining_qty: null, manual: false };

export default function Procurement() {
  const { canDelete, canCreate, canApprove, user, isAdmin } = useAuth();
  // Site-engineer-style users see only "Raise Indent" — they don't enter
  // vendor rates, upload Vendor POs, Purchase Bills, or Dispatch. Those
  // tabs are gated by canApprove('procurement'), which admin grants to
  // the purchase team / admin role only. Matches mam's request (2026-04-23).
  const canPurchaseOps = isAdmin() || canApprove('procurement');
  const canRaiseIndent = isAdmin() || canCreate('procurement');
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
  const [expandedIndents, setExpandedIndents] = useState(() => new Set());
  const toggleIndentRow = (id) => setExpandedIndents(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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

  // Open the Upload Vendor PO modal. If an indent is pre-selected (from the
  // Pending section), its items auto-load with finalized rates pre-filled so
  // the uploader can tick which indent lines the Tally PO covers.
  // Terms + Credit Days live on the uploaded Tally PO itself — not in the ERP.
  const openCreateVendorPo = (indentId = '') => {
    setForm({
      indent_id: indentId || '',
      vendor_id: '',
      po_number: '',
      po_date: new Date().toISOString().slice(0, 10), // default to today
      expected_receipt_date: '',
      total_amount: '',
      remarks: '',
      po_file: null,
    });
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
      // Pre-fill vendor from the finalized items if they all agree. Terms +
      // credit days live on the Tally PO now, so no need to pre-fill them.
      const vendorNames = [...new Set(items.filter(i => i.final_vendor_name).map(i => i.final_vendor_name))];
      const finalisedSum = items
        .filter(i => i.rate_status === 'finalized' && i.in_po_count === 0)
        .reduce((s, i) => s + ((+i.quantity || 0) * (+i.final_rate || 0)), 0);
      setForm(f => {
        const next = { ...f };
        if (vendorNames.length === 1) {
          const match = vendors.find(v => v.name?.toLowerCase() === vendorNames[0].toLowerCase());
          if (match) next.vendor_id = match.id;
        }
        // Pre-fill the total if all checked lines have finalized rates
        if (!next.total_amount && finalisedSum > 0) next.total_amount = Math.round(finalisedSum * 100) / 100;
        return next;
      });
    } catch { toast.error('Failed to load indent items'); }
  };
  const togglePoItem = (iiId, patch) => {
    setPoItemSelection(prev => ({ ...prev, [iiId]: { ...prev[iiId], ...patch } }));
  };
  const poTotal = Object.values(poItemSelection).reduce((s, r) => s + (r.checked ? (+r.quantity || 0) * (+r.rate || 0) : 0), 0);

  // Upload a Tally Vendor PO. The backend endpoint is multipart/form-data —
  // metadata fields + an optional file + a JSON-encoded items array for the
  // indent line linking (so "Pending for PO" still works).
  const saveVendorPo = async (e) => {
    e.preventDefault();
    if (!form.vendor_id) return toast.error('Pick a vendor');
    if (!form.po_number || !String(form.po_number).trim()) return toast.error('Enter the PO Number from Tally');
    if (!form.po_file) return toast.error('PO file is required — upload the Tally PO');

    const items = Object.entries(poItemSelection)
      .filter(([, v]) => v.checked && +v.quantity > 0 && +v.rate > 0)
      .map(([iiId, v]) => ({ indent_item_id: +iiId, quantity: +v.quantity, rate: +v.rate }));

    const fd = new FormData();
    fd.append('po_number', String(form.po_number).trim());
    if (form.po_date) fd.append('po_date', form.po_date);
    if (form.expected_receipt_date) fd.append('expected_receipt_date', form.expected_receipt_date);
    fd.append('vendor_id', form.vendor_id);
    if (form.indent_id) fd.append('indent_id', form.indent_id);
    if (form.total_amount) fd.append('total_amount', form.total_amount);
    if (form.remarks) fd.append('remarks', form.remarks);
    if (items.length) fd.append('items', JSON.stringify(items));
    if (form.po_file) fd.append('file', form.po_file);

    try {
      const r = await api.post('/procurement/vendor-po', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`Vendor PO ${r.data.po_number} uploaded (Rs ${r.data.total_amount.toLocaleString()}${r.data.lines ? `, ${r.data.lines} linked items` : ''})`);
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
  };

  const savePurchaseBill = async (e) => {
    e.preventDefault();
    if (!form.bill_file) return toast.error('Bill file is required — upload the vendor bill');
    // Multipart — carries the bill_file alongside the metadata, same
    // pattern as the Vendor PO upload.
    const fd = new FormData();
    if (form.vendor_po_id) fd.append('vendor_po_id', form.vendor_po_id);
    if (form.vendor_id) fd.append('vendor_id', form.vendor_id);
    if (form.bill_number) fd.append('bill_number', form.bill_number);
    if (form.bill_date) fd.append('bill_date', form.bill_date);
    fd.append('amount', form.amount || 0);
    fd.append('gst_amount', form.gst_amount || 0);
    fd.append('total_amount', form.total_amount || 0);
    if (form.bill_file) fd.append('file', form.bill_file);
    try {
      await api.post('/procurement/purchase-bills', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Purchase bill added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const saveDeliveryNote = async (e) => {
    e.preventDefault();
    if (!form.document_type) return toast.error('Pick Sales Bill or Challan');
    if (!form.document_number || !form.document_number.trim()) return toast.error('Document number is required');
    if (!form.dispatch_file) return toast.error('Dispatch file is required — upload the Sales Bill / Challan');
    // Multipart so we can attach the Sales Bill / Challan scan.
    const fd = new FormData();
    if (form.vendor_po_id) fd.append('vendor_po_id', form.vendor_po_id);
    if (form.delivery_date) fd.append('delivery_date', form.delivery_date);
    if (form.document_type) fd.append('document_type', form.document_type);
    if (form.document_number) fd.append('document_number', form.document_number);
    if (form.notes) fd.append('notes', form.notes);
    if (form.dispatch_file) fd.append('file', form.dispatch_file);
    try {
      await api.post('/procurement/delivery-notes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Dispatch recorded');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Mark a dispatch row as "Received by <name> on <date>" + attach the
  // stamped/signed receipt photo. Multipart so the file rides along.
  const markReceived = async (e) => {
    e.preventDefault();
    if (!form.received_by_name || !form.received_by_name.trim()) return toast.error('Receiver name is required');
    if (!form.receipt_file) return toast.error('Receipt proof photo is required — attach the stamped + signed document');
    const fd = new FormData();
    fd.append('received_by_name', form.received_by_name);
    if (form.received_at) fd.append('received_at', form.received_at);
    if (form.receipt_file) fd.append('file', form.receipt_file);
    try {
      await api.patch(`/procurement/delivery-notes/${form.receive_id}/receive`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Marked as received');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Order matches the flow: raise an indent first, purchase team collects
  // 3 vendor quotes + finalizes per item, then turns it into a vendor PO,
  // books the purchase bill, and finally the goods are dispatched to site.
  // Tabs are filtered below by the user's permissions — site engineers
  // with only `procurement.create` see just "Raise Indent"; purchase team
  // with `procurement.approve` see everything.
  const allTabs = [
    { id: 'indents', label: 'Raise Indent', show: canRaiseIndent },
    { id: 'rates', label: 'Vendor Rates', show: canPurchaseOps },
    { id: 'vendorpo', label: 'Vendor PO', show: canPurchaseOps },
    { id: 'bills', label: 'Purchase Bills', show: canPurchaseOps },
    { id: 'delivery', label: 'Dispatch & Receiving', show: canPurchaseOps },
  ];
  const tabs = allTabs.filter(t => t.show);

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
            <thead><tr><th className="w-8"></th><th>Indent No</th><th>Date</th><th>Site</th><th>Raised By</th><th>Items</th><th>BOQ</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {indents.map(i => {
                const items = i.items || [];
                const expanded = expandedIndents.has(i.id);
                return (
                <Fragment key={i.id}>
                <tr>
                  <td className="text-center">
                    {items.length > 0 && (
                      <button onClick={() => toggleIndentRow(i.id)} className="p-1 text-gray-400 hover:text-red-600" title={expanded ? 'Hide items' : 'Show items'}>
                        {expanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                      </button>
                    )}
                  </td>
                  <td className="font-medium">{i.indent_number}</td>
                  <td className="text-xs text-gray-600">{i.created_at ? new Date(i.created_at).toLocaleString() : (i.indent_date || '—')}</td>
                  <td>{i.site_name || i.client_name || <span className="text-gray-400">—</span>}</td>
                  <td>{i.raised_by_name || i.created_by_name}</td>
                  <td>
                    {items.length === 0
                      ? <span className="text-gray-400 text-xs">—</span>
                      : (
                        <button onClick={() => toggleIndentRow(i.id)} className="text-xs text-red-600 hover:underline">
                          {items.length} item{items.length === 1 ? '' : 's'}
                        </button>
                      )}
                  </td>
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
                {expanded && items.length > 0 && (
                  <tr className="bg-gray-50">
                    <td></td>
                    <td colSpan="8" className="p-3">
                      <div className="text-xs font-semibold text-gray-600 mb-2">BoQ items raised in {i.indent_number}</div>
                      <table className="text-xs w-full">
                        <thead>
                          <tr className="text-gray-500 border-b">
                            <th className="text-left py-1 pr-3 w-10">#</th>
                            <th className="text-left py-1 pr-3">Description</th>
                            <th className="text-left py-1 pr-3">Make</th>
                            <th className="text-right py-1 pr-3 w-20">Qty</th>
                            <th className="text-left py-1 pr-3 w-16">Unit</th>
                            <th className="text-left py-1 pr-3 w-16">Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it, idx) => (
                            <tr key={it.id} className="border-b border-gray-100 last:border-0">
                              <td className="py-1 pr-3 text-gray-500">{idx + 1}</td>
                              <td className="py-1 pr-3">{it.description || it.master_name || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3">{it.make || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3 text-right">{it.quantity}</td>
                              <td className="py-1 pr-3">{it.unit || '—'}</td>
                              <td className="py-1 pr-3">{it.item_type || <span className="text-gray-400">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
              })}
              {indents.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No indents yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'rates' && (
        <>
          {/* Vendor Name uses SearchableSelect component now, sourced from
              Vendor Master. The old <datalist> fallback is removed. */}
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
            <table className="text-xs" style={{ minWidth: '1600px' }}>
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
                          <td className="px-1 py-1" style={{ minWidth: '200px', width: '200px' }}>
                            {/* Vendor picker — searchable dropdown sourced from
                                Vendor Master. Saves vendor.name on the rate
                                row so downstream code (finalize / Vendor PO)
                                keeps working with the existing name column. */}
                            <SearchableSelect
                              options={vendors}
                              value={r[`vendor${n}_name`] || null}
                              valueKey="name" displayKey="name"
                              placeholder="Pick vendor"
                              buttonClassName="text-[11px] px-2 py-1 w-full border border-gray-200 rounded-md bg-white hover:border-gray-300 focus:outline-none focus:ring-1 focus:ring-red-400 text-left flex items-center justify-between gap-1 cursor-pointer"
                              onChange={(v) => updateItemRate(r.indent_item_id, { [`vendor${n}_name`]: v?.name || '' })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '120px' }}>
                            <input
                              className="input text-[11px] px-2 py-1 text-right"
                              style={{ width: '110px', minWidth: '110px' }}
                              type="number"
                              placeholder="0"
                              value={r[`vendor${n}_rate`] || ''}
                              onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_rate`]: +e.target.value })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '140px' }}>
                            <select
                              className="select text-[11px] px-2 py-1"
                              style={{ width: '130px', minWidth: '130px' }}
                              value={r[`vendor${n}_terms`] || ''}
                              onChange={e => updateItemRate(r.indent_item_id, { [`vendor${n}_terms`]: e.target.value })}
                            >
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
                      {/* Mobile layout: full-width Name on top (searchable
                          Vendor Master dropdown), Rate + Terms share the row
                          below. */}
                      <div className="mb-2">
                        <SearchableSelect
                          options={vendors}
                          value={r[`vendor${n}_name`] || null}
                          valueKey="name" displayKey="name"
                          placeholder="Pick vendor from master"
                          buttonClassName="input text-xs w-full text-left flex items-center justify-between gap-1 cursor-pointer"
                          onChange={(v) => updateItemRate(r.indent_item_id, { [`vendor${n}_name`]: v?.name || '' })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
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
            <button onClick={() => openCreateVendorPo('')} className="btn btn-primary flex items-center gap-2"><FiPlus /> Upload Vendor PO</button>
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
                            <button onClick={() => openCreateVendorPo(p.indent_id)} className="btn btn-primary text-[10px] px-2 py-1">Upload PO</button>
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
            <thead><tr><th>PO Number</th><th>PO Date</th><th>Vendor</th><th>Amount</th><th>File</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {vendorPos.map(v => (
                <tr key={v.id}>
                  <td className="font-medium">{v.po_number}</td>
                  <td>{v.po_date || <span className="text-gray-300">—</span>}</td>
                  <td>{v.vendor_name}</td>
                  <td>Rs {v.total_amount?.toLocaleString()}</td>
                  <td>
                    {v.file_path
                      ? <a href={v.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs">View PO</a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={v.status} /></td>
                  <td>{canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete vendor PO "${v.po_number}"?`)) return;
                    try { await api.delete(`/procurement/vendor-po/${v.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
                </tr>
              ))}
              {vendorPos.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No vendor POs yet — click "Upload Vendor PO"</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'bills' && (() => {
        // POs that don't have a bill yet — sorted by Expected Receipt Date
        // so the purchase team chases the oldest first. Uses client-side
        // filtering off the already-loaded vendorPos + purchaseBills.
        const billedPoIds = new Set(purchaseBills.map(b => b.vendor_po_id).filter(Boolean));
        const today = new Date().toISOString().slice(0, 10);
        const pendingPos = vendorPos
          .filter(po => !billedPoIds.has(po.id))
          .sort((a, b) => {
            const ax = a.expected_receipt_date || '9999-12-31';
            const bx = b.expected_receipt_date || '9999-12-31';
            return ax.localeCompare(bx);
          });
        const daysDiff = (d) => {
          if (!d) return null;
          const dt = new Date(d); const tdt = new Date(today);
          return Math.round((dt - tdt) / 86400000);
        };
        const openUploadBill = (po) => {
          setForm({
            vendor_po_id: po.id,
            vendor_po_number: po.po_number,
            vendor_id: po.vendor_id,
            bill_number: '',
            bill_date: today,
            amount: 0,
            gst_amount: 0,
            total_amount: 0,
          });
          setModal('bill');
        };
        return (
        <>
          {/* ===== Follow-up section ===== */}
          {pendingPos.length > 0 && (
            <div className="card p-3 bg-amber-50 border border-amber-200">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                <h4 className="font-semibold text-amber-800 text-sm">
                  Follow-up: POs awaiting Purchase Bill
                  <span className="text-xs font-normal text-amber-600 ml-2">({pendingPos.length} PO{pendingPos.length === 1 ? '' : 's'})</span>
                </h4>
                <span className="text-[11px] text-amber-700">Sorted by Expected Receipt Date — chase the oldest first</span>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr className="bg-amber-100/50">
                    <th className="px-2 py-1 text-left">PO Number</th>
                    <th className="px-2 py-1 text-left">Vendor</th>
                    <th className="px-2 py-1">PO Date</th>
                    <th className="px-2 py-1">Expected Receipt</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    <th className="px-2 py-1">File</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {pendingPos.map(po => {
                      const d = daysDiff(po.expected_receipt_date);
                      let chip;
                      if (!po.expected_receipt_date) chip = <span className="text-gray-400">— no date —</span>;
                      else if (d < 0) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">OVERDUE by {-d}d</span>;
                      else if (d === 0) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">DUE TODAY</span>;
                      else if (d <= 3) chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">in {d}d</span>;
                      else chip = <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">in {d}d</span>;
                      return (
                        <tr key={po.id} className="border-b border-amber-100">
                          <td className="px-2 py-1.5 font-semibold text-red-700 whitespace-nowrap">{po.po_number}</td>
                          <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center">{chip}</td>
                          <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">Rs {po.total_amount?.toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-center">
                            {po.file_path
                              ? <a href={po.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-[11px]">View PO</a>
                              : <span className="text-gray-300 text-[11px]">—</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            <button onClick={() => openUploadBill(po)} className="btn btn-primary text-[10px] px-2 py-1 whitespace-nowrap">Upload Bill</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===== Existing bills table ===== */}
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Purchase Bills</h3>
            <button onClick={() => { setForm({ vendor_id: '', bill_number: '', bill_date: '', amount: 0, gst_amount: 0, total_amount: 0 }); setModal('bill'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Bill</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>Bill No</th><th>Vendor</th><th>Date</th><th>Amount</th><th>GST</th><th>Total</th><th>File</th><th>Payment</th><th>Actions</th></tr></thead>
            <tbody>
              {purchaseBills.map(b => (
                <tr key={b.id}>
                  <td className="font-medium">{b.bill_number}</td><td>{b.vendor_name}</td><td>{b.bill_date}</td>
                  <td>Rs {b.amount?.toLocaleString()}</td><td>Rs {b.gst_amount?.toLocaleString()}</td>
                  <td className="font-semibold">Rs {b.total_amount?.toLocaleString()}</td>
                  <td>
                    {b.file_path
                      ? <a href={b.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs">View Bill</a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={b.payment_status} /></td>
                  <td>{canDelete('procurement') && <button onClick={async () => {
                    if (!confirm(`Delete purchase bill "${b.bill_number}"?`)) return;
                    try { await api.delete(`/procurement/purchase-bills/${b.id}`); toast.success('Deleted'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                  }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}</td>
                </tr>
              ))}
              {purchaseBills.length === 0 && <tr><td colSpan="9" className="text-center py-8 text-gray-400">No bills yet</td></tr>}
            </tbody>
          </table></div>
        </>
        );
      })()}

      {tab === 'delivery' && (() => {
        // Follow-up: POs that have a Purchase Bill uploaded but no Dispatch
        // entry yet. These are ready to be dispatched to site.
        const dispatchedPoIds = new Set(deliveryNotes.map(d => d.vendor_po_id).filter(Boolean));
        const billedPoIds = new Set(purchaseBills.map(b => b.vendor_po_id).filter(Boolean));
        const readyToDispatch = vendorPos.filter(po =>
          billedPoIds.has(po.id) && !dispatchedPoIds.has(po.id)
        );
        // Detect item-type hint for each PO (if any indent_item linked is type=PO,
        // suggest Sales Bill; else suggest Challan). We don't have per-item info
        // on the client, so the dropdown defaults to Sales Bill and user can switch.
        const openAddDispatch = (po = null) => {
          setForm({
            vendor_po_id: po?.id || '',
            vendor_po_number: po?.po_number || '',
            document_type: 'sales_bill',
            document_number: '',
            delivery_date: new Date().toISOString().slice(0, 10),
            notes: '',
            dispatch_file: null,
          });
          setModal('delivery');
        };
        const openMarkReceived = (d) => {
          setForm({
            receive_id: d.id,
            receive_doc: `${d.document_type === 'challan' ? 'Challan' : 'Sales Bill'} ${d.document_number || '#' + d.id}`,
            received_by_name: '',
            received_at: new Date().toISOString().slice(0, 10),
          });
          setModal('receive');
        };
        return (
        <>
          {/* ===== Follow-up: ready to dispatch ===== */}
          {readyToDispatch.length > 0 && (
            <div className="card p-3 bg-indigo-50 border border-indigo-200">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                <h4 className="font-semibold text-indigo-800 text-sm">
                  Ready to Dispatch
                  <span className="text-xs font-normal text-indigo-600 ml-2">({readyToDispatch.length} PO{readyToDispatch.length === 1 ? '' : 's'})</span>
                </h4>
                <span className="text-[11px] text-indigo-700">POs with Purchase Bill uploaded but no Dispatch yet — Sales Bill for PO items, Challan for FOC/RGP</span>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead><tr className="bg-indigo-100/50">
                    <th className="px-2 py-1 text-left">PO Number</th>
                    <th className="px-2 py-1 text-left">Vendor</th>
                    <th className="px-2 py-1">PO Date</th>
                    <th className="px-2 py-1">Expected Receipt</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    <th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {readyToDispatch.map(po => (
                      <tr key={po.id} className="border-b border-indigo-100">
                        <td className="px-2 py-1.5 font-semibold text-red-700 whitespace-nowrap">{po.po_number}</td>
                        <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">Rs {po.total_amount?.toLocaleString()}</td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => openAddDispatch(po)} className="btn btn-primary text-[10px] px-2 py-1 whitespace-nowrap">Dispatch</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ===== Main dispatch list ===== */}
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Dispatch & Receiving</h3>
            <button onClick={() => openAddDispatch()} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Dispatch</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>ID</th><th>Type</th><th>Doc No</th><th>PO</th><th>Date</th><th>File</th><th>Received By</th><th>Received On</th><th>Proof</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {deliveryNotes.map(d => (
                <tr key={d.id}>
                  <td>#{d.id}</td>
                  <td>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${d.document_type === 'sales_bill' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : d.document_type === 'challan' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                      {d.document_type === 'sales_bill' ? 'SALES BILL' : d.document_type === 'challan' ? 'CHALLAN' : '—'}
                    </span>
                  </td>
                  <td className="font-medium">{d.document_number || <span className="text-gray-300">—</span>}</td>
                  <td className="text-xs">{d.vendor_po_number || <span className="text-gray-300">—</span>}<div className="text-[10px] text-gray-500">{d.vendor_name || ''}</div></td>
                  <td>{d.delivery_date}</td>
                  <td>
                    {d.file_path
                      ? <a href={d.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs">View</a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>{d.received_by_name || <span className="text-gray-300 text-xs">—</span>}</td>
                  <td className="text-xs">{d.received_at ? new Date(d.received_at).toLocaleDateString() : <span className="text-gray-300">—</span>}</td>
                  <td>
                    {d.receipt_file_path
                      ? <a href={d.receipt_file_path} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 underline text-xs font-semibold">Signed ✓</a>
                      : d.received_by_name
                        ? <span className="text-amber-600 text-[11px]">No photo</span>
                        : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="whitespace-nowrap">
                    {!d.received_by_name && (
                      <button onClick={() => openMarkReceived(d)} className="btn btn-success text-[10px] px-2 py-1 mr-1">Mark Received</button>
                    )}
                    {canDelete('procurement') && <button onClick={async () => {
                      if (!confirm(`Delete dispatch #${d.id}?`)) return;
                      try { await api.delete(`/procurement/delivery-notes/${d.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </td>
                </tr>
              ))}
              {deliveryNotes.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No dispatches yet</td></tr>}
            </tbody>
          </table></div>
        </>
        );
      })()}

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
            Items <span className="text-gray-400 font-normal">(BOQ item from Client PO → then sub-item from Item Master)</span>
          </h4>
          {!form.site_name ? (
            <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center text-sm text-gray-500 bg-gray-50">
              Pick a site above — its BOQ items (from the uploaded Client PO) will load here.
            </div>
          ) : (
            <>
              {/* Desktop column headers — hidden on mobile, where each row is a stacked card */}
              <div className="hidden md:grid gap-2 text-[10px] font-bold text-gray-500 uppercase px-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                <div className="col-span-5">BOQ Item (from Client PO)</div>
                <div className="col-span-4">Sub-Item (Item Master)</div>
                <div className="col-span-2">Make</div>
                <div className="col-span-3">Qty</div>
                <div>Unit</div>
                <div></div>
              </div>
              <div className="space-y-3 md:space-y-2">
                {indentItems.map((item, i) => {
                  const t = String(item.item_type || '').toUpperCase();
                  const typeClass = t === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : t === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : t === 'PO' ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-gray-50 text-gray-500 border-gray-200';

                  // BOQ picker — comes from the Client PO for the selected
                  // site. Mam's requested flow: first pick a BOQ line, then a
                  // sub-item from Item Master.
                  const boqPicker = (
                    <SearchableSelect
                      options={boqItems.map(b => ({
                        id: b.id,
                        label: `${b.description || '(no desc)'}${b.boq_qty ? ' · Qty ' + b.boq_qty : ''}${b.item_type ? ' · ' + b.item_type : ''}`,
                        ...b,
                      }))}
                      value={item.po_item_id || null} valueKey="id" displayKey="label"
                      placeholder={boqItems.length ? 'Search BOQ item from Client PO…' : 'No BOQ items for this site'}
                      onChange={(b) => pickBoqItem(i, b)}
                    />
                  );
                  const masterPicker = (
                    <SearchableSelect
                      options={masterItems.map(m => ({ id: m.id, label: `[${m.item_code}] ${m.display_name || m.item_name}${m.type ? ' · ' + m.type : ''}`, ...m }))}
                      value={item.item_master_id || null} valueKey="id" displayKey="label"
                      placeholder="Search sub-item from Item Master…"
                      onChange={(m) => pickMasterItem(i, m)}
                    />
                  );
                  const makeInput = <input className="input text-sm" placeholder="Make" value={item.make || ''} onChange={e => { const n = [...indentItems]; n[i].make = e.target.value; setIndentItems(n); }} />;
                  // QTY — bumped to a bigger, bolder number so the critical
                  // value is instantly readable / editable. right-aligned
                  // since it's numeric.
                  const qtyInput = <input className="input text-base font-bold text-right" type="number" min="0" placeholder="Qty" value={item.quantity} onChange={e => { const n = [...indentItems]; n[i].quantity = +e.target.value; setIndentItems(n); }} />;
                  const unitInput = <input className="input text-sm" placeholder="Unit" value={item.unit} onChange={e => { const n = [...indentItems]; n[i].unit = e.target.value; setIndentItems(n); }} />;
                  // TYPE is auto-derived from the Item Master sub-item's `type`
                  // field (PO / FOC / RGP). Read-only so mam's people can't
                  // accidentally override the Item Master's classification.
                  const typeBox = (
                    <div className={`text-center text-[11px] font-bold uppercase px-2 py-1.5 rounded-lg border ${typeClass}`} title="Auto-picked from Item Master sub-item">
                      {item.item_type || <span className="text-gray-400 normal-case font-normal">— pick sub-item —</span>}
                    </div>
                  );
                  const removeBtn = (
                    <button type="button" onClick={() => setIndentItems(indentItems.filter((_, x) => x !== i))} className="p-1 text-gray-300 hover:text-red-600" title="Remove row">
                      {indentItems.length > 1 && <FiTrash2 size={14} />}
                    </button>
                  );

                  return (
                    <div key={i}>
                      {/* MOBILE: stacked card — BOQ Item first, then sub-item,
                          then Make, Qty/Unit/Type. */}
                      <div className="md:hidden border rounded-lg p-2.5 bg-white space-y-2 relative">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-bold text-gray-400 uppercase">Row {i + 1}</span>
                          {indentItems.length > 1 && removeBtn}
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">BOQ Item <span className="text-gray-400 font-normal normal-case">(from Client PO)</span></label>
                          {boqPicker}
                          {item.boq_qty ? <p className="text-[10px] text-gray-400 mt-0.5">BOQ Qty: {item.boq_qty}{item.remaining_qty !== null && item.remaining_qty !== undefined ? ` · Remaining: ${item.remaining_qty}` : ''}</p> : null}
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Sub-Item <span className="text-gray-400 font-normal normal-case">(Item Master)</span></label>
                          {masterPicker}
                        </div>
                        {/* Mobile QTY/Unit/Type — Qty gets 2 columns so the
                            number is easy to tap + read; Unit + Type share
                            the remaining column split 50/50. */}
                        <div className="grid grid-cols-4 gap-2">
                          <div className="col-span-2">
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

                      {/* DESKTOP: wide grid row — BOQ picker + sub-item picker
                          + make + QTY (big) + unit. 15-column grid gives QTY
                          3 columns so the number is easy to read/edit. */}
                      <div className="hidden md:block">
                        <div className="grid gap-2 items-start" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                          <div className="col-span-5">
                            {boqPicker}
                            {item.boq_qty ? <p className="text-[10px] text-gray-400 mt-0.5">BOQ {item.boq_qty}{item.remaining_qty !== null && item.remaining_qty !== undefined ? ` · Rem ${item.remaining_qty}` : ''}</p> : null}
                          </div>
                          <div className="col-span-4">{masterPicker}</div>
                          <div className="col-span-2">{makeInput}</div>
                          <div className="col-span-3">{qtyInput}</div>
                          <div>{unitInput}</div>
                          {removeBtn}
                        </div>
                        {/* Type row below — auto-picked from sub-item */}
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-[10px] font-bold text-gray-500 uppercase">Type:</span>
                          <div className="w-24">{typeBox}</div>
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

      {/* Vendor PO Upload Modal — mam creates the PO in Tally and uploads
          the file here. Terms / credit days / advance live on the uploaded
          Tally PO itself, so the ERP only captures metadata + the file. */}
      <Modal isOpen={modal === 'vendorpo'} onClose={() => setModal(false)} title="Upload Vendor PO (from Tally)" wide>
        <form onSubmit={saveVendorPo} className="space-y-4">
          <p className="text-[11px] text-gray-500 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Upload the PO PDF/file you created in Tally. Optionally link it to an indent so the "Pending for PO" list clears.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">PO Number (from Tally) *</label>
              <input className="input" placeholder="e.g. VPO/2026/0017" value={form.po_number || ''} onChange={e => setForm({...form, po_number: e.target.value})} required />
            </div>
            <div>
              <label className="label">PO Date *</label>
              <input className="input" type="date" value={form.po_date || ''} onChange={e => setForm({...form, po_date: e.target.value})} required />
            </div>
            <div>
              <label className="label">Vendor *</label>
              <select className="select" value={form.vendor_id || ''} onChange={e => setForm({...form, vendor_id: +e.target.value})} required>
                <option value="">Select vendor</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Auto-picked from finalized rates if all items agree.</p>
            </div>
            <div>
              <label className="label">PO Total Amount *</label>
              <input className="input" type="number" step="0.01" min="0" placeholder="0" value={form.total_amount || ''} onChange={e => setForm({...form, total_amount: e.target.value})} required />
              <p className="text-[10px] text-gray-400 mt-0.5">As per the Tally PO.</p>
            </div>
            <div>
              <label className="label">Expected Receipt Date <span className="text-gray-400 font-normal">(when goods are due from vendor)</span></label>
              <input className="input" type="date" value={form.expected_receipt_date || ''} onChange={e => setForm({...form, expected_receipt_date: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Used to chase vendor follow-ups and trigger the Purchase Bill upload.</p>
            </div>
            <div>
              <label className="label">Link to Indent <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.indent_id || ''} onChange={e => pickIndentForPo(e.target.value)}>
                <option value="">— No indent link —</option>
                {indents.map(i => <option key={i.id} value={i.id}>{i.indent_number} — {i.site_name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">PO File * <span className="text-gray-400 font-normal">(PDF / JPG / PNG / XLSX, max 10 MB)</span></label>
              <input
                className="input"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
                required
                onChange={e => setForm({...form, po_file: e.target.files?.[0] || null})}
              />
              {form.po_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.po_file.name}</p>}
            </div>
            <div className="sm:col-span-2">
              <label className="label">Remarks <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input" placeholder="Any note about this PO" value={form.remarks || ''} onChange={e => setForm({...form, remarks: e.target.value})} />
            </div>
          </div>

          {/* Optional item linking — when an indent is picked, the uploader
              can tick which indent lines the Tally PO covers so the "Pending
              for PO" list clears. Terms / credit days aren't collected here
              because they live on the uploaded Tally PO itself. */}
          {form.indent_id && (
            <div className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-3 py-2 border-b text-xs font-semibold text-gray-600 uppercase flex items-center justify-between">
                <span>Items from this Indent <span className="text-[10px] text-gray-400 normal-case">(optional)</span></span>
                <span className="text-[10px] text-gray-500 normal-case">Tick items covered by this Tally PO</span>
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
                        <th className="px-2 py-1.5">Unit</th>
                        <th className="px-2 py-1.5">Rate</th>
                        <th className="px-2 py-1.5">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {indentItemsForPo.map(it => {
                        const s = poItemSelection[it.indent_item_id] || {};
                        const inPo = it.in_po_count > 0;
                        const amount = (s.checked ? (+s.quantity || 0) * (+s.rate || 0) : 0);
                        const unit = it.unit || it.uom || '';
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
                            <td className="px-2 py-1.5 text-center text-gray-600">{unit || <span className="text-gray-300">—</span>}</td>
                            <td className="px-1 py-1"><input className="input text-[11px] px-1 py-0.5 w-20 text-right" type="number" disabled={inPo} value={s.rate ?? 0} onChange={e => togglePoItem(it.indent_item_id, { rate: +e.target.value })} /></td>
                            <td className="px-2 py-1.5 text-right font-semibold">{amount ? `Rs ${amount.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr><td colSpan="5" className="px-2 py-2 text-right font-bold">PO Total:</td>
                          <td className="px-2 py-2 text-right font-bold text-red-700">Rs {poTotal.toLocaleString()}</td></tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Upload Vendor PO</button>
          </div>
        </form>
      </Modal>

      {/* Purchase Bill Modal */}
      <Modal isOpen={modal === 'bill'} onClose={() => setModal(false)} title={form.vendor_po_number ? `Upload Bill for ${form.vendor_po_number}` : 'Add Purchase Bill'}>
        <form onSubmit={savePurchaseBill} className="space-y-4">
          {form.vendor_po_number && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-xs text-emerald-700">
              Linked to Vendor PO <b>{form.vendor_po_number}</b>. The bill will automatically clear this PO from the follow-up list.
            </div>
          )}
          <div>
            <label className="label">Vendor *</label>
            <SearchableSelect
              options={vendors}
              value={form.vendor_id || null}
              valueKey="id" displayKey="name"
              placeholder="Search vendor…"
              onChange={(v) => setForm({ ...form, vendor_id: v?.id || '' })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Bill Number</label><input className="input" value={form.bill_number} onChange={e => setForm({...form, bill_number: e.target.value})} /></div>
            <div><label className="label">Bill Date</label><input className="input" type="date" value={form.bill_date} onChange={e => setForm({...form, bill_date: e.target.value})} /></div>
            <div><label className="label">Amount</label><input className="input" type="number" value={form.amount} onChange={e => setForm({...form, amount: +e.target.value, total_amount: +e.target.value + (form.gst_amount || 0)})} /></div>
            <div><label className="label">GST Amount</label><input className="input" type="number" value={form.gst_amount} onChange={e => setForm({...form, gst_amount: +e.target.value, total_amount: (form.amount || 0) + +e.target.value})} /></div>
          </div>
          <div><label className="label">Total</label><input className="input" type="number" value={form.total_amount} readOnly /></div>
          <div>
            <label className="label">Bill File * <span className="text-gray-400 font-normal">(PDF / JPG / PNG / XLSX, max 10 MB)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
              required
              onChange={e => setForm({ ...form, bill_file: e.target.files?.[0] || null })}
            />
            {form.bill_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.bill_file.name}</p>}
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      {/* Delivery / Dispatch Modal — Sales Bill or Delivery Challan with file upload */}
      <Modal isOpen={modal === 'delivery'} onClose={() => setModal(false)} title={form.vendor_po_number ? `Dispatch for ${form.vendor_po_number}` : 'Record Dispatch to Site'}>
        <form onSubmit={saveDeliveryNote} className="space-y-4">
          {form.vendor_po_number && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-xs text-emerald-700">
              Linked to Vendor PO <b>{form.vendor_po_number}</b>. Once this dispatch is recorded, the PO moves off the "Ready to Dispatch" list.
            </div>
          )}
          <div>
            <label className="label">Dispatch Type *</label>
            <div className="flex gap-2">
              <label className={`flex-1 border rounded-lg px-3 py-2 cursor-pointer flex items-center gap-2 ${form.document_type === 'sales_bill' ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
                <input type="radio" name="doc_type" value="sales_bill" checked={form.document_type === 'sales_bill'} onChange={() => setForm({...form, document_type: 'sales_bill'})} />
                <div>
                  <div className="text-sm font-semibold">Sales Bill</div>
                  <div className="text-[10px] text-gray-500">For PO items we sell to the client</div>
                </div>
              </label>
              <label className={`flex-1 border rounded-lg px-3 py-2 cursor-pointer flex items-center gap-2 ${form.document_type === 'challan' ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
                <input type="radio" name="doc_type" value="challan" checked={form.document_type === 'challan'} onChange={() => setForm({...form, document_type: 'challan'})} />
                <div>
                  <div className="text-sm font-semibold">Delivery Challan</div>
                  <div className="text-[10px] text-gray-500">For FOC / RGP items (not billable)</div>
                </div>
              </label>
            </div>
          </div>
          {!form.vendor_po_number && (
            <div>
              <label className="label">Vendor PO</label>
              <SearchableSelect
                options={vendorPos.map(v => ({ ...v, label: v.po_number + ' — ' + (v.vendor_name || '') }))}
                value={form.vendor_po_id || null}
                valueKey="id" displayKey="label"
                placeholder="— Not linked — search PO…"
                onChange={(v) => setForm({ ...form, vendor_po_id: v?.id || '' })}
              />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{form.document_type === 'challan' ? 'Challan' : 'Sales Bill'} Number *</label>
              <input className="input" value={form.document_number || ''} onChange={e => setForm({...form, document_number: e.target.value})} required placeholder="e.g. SB/2026/042" />
            </div>
            <div>
              <label className="label">Dispatch Date</label>
              <input className="input" type="date" value={form.delivery_date || ''} onChange={e => setForm({...form, delivery_date: e.target.value})} />
            </div>
          </div>
          <div>
            <label className="label">{form.document_type === 'challan' ? 'Challan' : 'Sales Bill'} File * <span className="text-gray-400 font-normal">(PDF / JPG / PNG / XLSX, max 10 MB)</span></label>
            <input className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" required onChange={e => setForm({ ...form, dispatch_file: e.target.files?.[0] || null })} />
            {form.dispatch_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.dispatch_file.name}</p>}
          </div>
          <div><label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save Dispatch</button></div>
        </form>
      </Modal>

      {/* Mark Received Modal — captures who received the dispatch AND the
          client's stamped + signed receipt photo as proof of delivery. This
          receipt is critical for mam because without it clients sometimes
          deny receiving the material and SEPL has to absorb the loss. */}
      <Modal isOpen={modal === 'receive'} onClose={() => setModal(false)} title="Mark Received">
        <form onSubmit={markReceived} className="space-y-3">
          <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2 text-xs text-indigo-700">
            Recording receipt for <b>{form.receive_doc}</b>.
          </div>
          <div>
            <label className="label">Received By (name) *</label>
            <input className="input" placeholder="e.g. Site engineer / customer rep name" value={form.received_by_name || ''} onChange={e => setForm({...form, received_by_name: e.target.value})} required />
          </div>
          <div>
            <label className="label">Received On</label>
            <input className="input" type="date" value={form.received_at || ''} onChange={e => setForm({...form, received_at: e.target.value})} />
            <p className="text-[10px] text-gray-400 mt-0.5">Defaults to today if left blank.</p>
          </div>
          <div>
            <label className="label">Receipt Proof * <span className="text-red-500 font-normal">(stamped + signed photo — prevents client denial disputes)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              capture="environment"
              required
              onChange={e => setForm({ ...form, receipt_file: e.target.files?.[0] || null })}
            />
            {form.receipt_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.receipt_file.name}</p>}
            <p className="text-[10px] text-gray-400 mt-0.5">On mobile, tapping this opens the camera directly — take the photo of the stamped sales bill / challan.</p>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Mark as Received</button>
          </div>
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
