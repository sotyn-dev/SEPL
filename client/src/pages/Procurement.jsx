import { useState, useEffect, useMemo, Fragment } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiCheck, FiX, FiTrash2, FiEdit2, FiExternalLink, FiChevronDown, FiChevronRight, FiPrinter, FiMessageCircle, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const EMPTY_ITEM = { po_item_id: '', item_master_id: '', description: '', make: '', quantity: 1, unit: 'nos', item_type: '', boq_qty: 0, remaining_qty: null, manual: false, required_date: '' };

// Client-side unit display normaliser (mam, 2026-05-16: "not change
// according to itemwise" — stale "Each" / "Metre" / "Mtrs" values
// leaked through when there's no master link).  Aligns with the
// server-side cleanup map so the UI never shows non-standard UoMs
// even if the row hasn't been backfilled yet.
const UNIT_DISPLAY_MAP = {
  each: 'nos', pieces: 'nos', piece: 'nos', nos: 'nos',
  metre: 'mtr', metres: 'mtr', meter: 'mtr', meters: 'mtr', mtrs: 'mtr', mt: 'mtr', m: 'mtr',
  litre: 'ltr', litres: 'ltr', liter: 'ltr', liters: 'ltr', ltr: 'ltr', l: 'ltr',
  kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  sets: 'set',
  packets: 'packet', pkt: 'packet', pack: 'packet',
  feet: 'ft',
  watts: 'watt', w: 'watt',
};
const cleanUnit = (u) => {
  if (!u) return '';
  const v = String(u).trim().toLowerCase();
  return UNIT_DISPLAY_MAP[v] || v;
};

// Standard units used across MEP / civil indents. Mam asked for a
// dropdown because the Item Master's stored UoM is often wrong and
// the user has to override it manually almost every time.
const UNIT_OPTIONS = [
  'nos','pcs','set','pair','pkt','box','bdl','roll','coil','bag',
  'kg','gms','ton','qtl',
  'mtr','rmt','ft','inch','cm','mm',
  'sqft','sqmtr','sqm','cum','cft',
  'ltr','ml',
];

export default function Procurement() {
  const { canDelete, canCreate, canEdit, canApprove, user, isAdmin } = useAuth();
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
  const [warehouses, setWarehouses] = useState([]);  // for Mark Received auto-IN
  const [indentItems, setIndentItems] = useState([{ ...EMPTY_ITEM }]);
  // Editable per-line items for the Sales Bill / Delivery Note modal.
  // Pre-filled from Client PO (po_items) so the rate column shows the
  // SELLING price (what we invoice the client), not vendor cost. Mam can
  // tweak qty / rate / disc % / include flag per row before generating.
  const [dispatchItems, setDispatchItems] = useState([]);
  const [dispatchItemsLoading, setDispatchItemsLoading] = useState(false);
  const [dispatchItemsSource, setDispatchItemsSource] = useState('po_items'); // 'po_items' | 'vendor_po' | 'empty'
  // Rate-source diagnostic — mam (2026-05-16): "if sales bill we
  // enter BOQ SITC rate".  When the backend can't supply BOQ
  // rates (no client PO, all zero rates, etc.) we surface a red
  // warning instead of silently falling back to vendor cost.
  const [dispatchRateInfo, setDispatchRateInfo] = useState({ source: null, warning: null, rated: 0, total: 0 });
  // Bill-To preview for Sales Bill modal — mam (2026-05-16):
  // critical fix #1 from the modal review.  Fetched from
  // /vendor-pos/:id/bill-to whenever a Vendor PO is picked.
  const [dispatchBillTo, setDispatchBillTo] = useState(null);

  // Vendor PO edit modal (mam, 2026-05-20: "how can i edit po
  // after creation because some time need").  Holds the PO row
  // being edited; null = closed.  Form fields are limited to
  // header-level safe edits (date / amount / advance / remarks)
  // — line items + vendor change need their own flows.
  const [editPo, setEditPo] = useState(null);
  const [editPoForm, setEditPoForm] = useState({});
  const [editPoSaving, setEditPoSaving] = useState(false);

  const openEditVendorPo = (v) => {
    setEditPo(v);
    setEditPoForm({
      po_date: v.po_date || '',
      expected_receipt_date: v.expected_receipt_date || '',
      total_amount: v.total_amount || 0,
      advance_required: v.advance_required || 0,
      remarks: v.remarks || '',
    });
  };
  const saveEditVendorPo = async (e) => {
    e.preventDefault();
    if (!editPo?.id) return;
    setEditPoSaving(true);
    try {
      await api.put(`/procurement/vendor-po/${editPo.id}`, editPoForm);
      toast.success('PO updated');
      setEditPo(null);
      setEditPoForm({});
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setEditPoSaving(false);
    }
  };
  // When set, the Raise Indent modal is in EDIT mode for this indent id —
  // saveIndent will PUT instead of POST. Used by the Edit pencil action
  // (mam: 'site eng is on training, if they fill wrong indent can edit').
  const [editingIndentId, setEditingIndentId] = useState(null);
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
    // Warehouses fuel the optional auto-IN dropdown on the Mark Received modal.
    // Silent on 403 — non-inventory users still see the original receive form.
    api.get('/inventory/warehouses').then(r => setWarehouses(r.data || [])).catch(() => setWarehouses([]));
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
    // DO NOT overwrite `description` here. `description` carries the BOQ
    // line's text from the Client PO (set by pickBoqItem) and is what the
    // BOQ-section header displays. Earlier this function rewrote it with
    // the sub-item's name, which made the header read the sub-item — mam:
    // "look at 2 photo when i select po foc item why boq item name change".
    // The sub-item label is already shown by the SearchableSelect itself,
    // so we only update the linkage + unit/type/make.
    n[i] = {
      ...n[i],
      item_master_id: master?.id || '',
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
    // Both BOQ Item (po_item_id) AND Sub-Item (item_master_id) are
    // mandatory per mam's spec — surface the row number on failure
    // so the user knows which line to fix.
    for (let i = 0; i < indentItems.length; i++) {
      const it = indentItems[i];
      if (!it.po_item_id) return toast.error(`Row ${i + 1}: pick BOQ Item (from Client PO)`);
      if (!it.item_master_id) return toast.error(`Row ${i + 1}: pick Sub-Item (from Item Master)`);
      if (!(+it.quantity > 0)) return toast.error(`Row ${i + 1}: Quantity must be greater than 0`);
    }
    const payload = {
      site_name: form.site_name,
      raised_by_name: form.raised_by_name,
      notes: form.notes || '',
      items: indentItems.map(it => ({ ...it, make: it.make || '' })),
    };
    try {
      if (editingIndentId) {
        await api.put(`/procurement/indents/${editingIndentId}`, payload);
        toast.success('Indent updated');
      } else {
        await api.post('/procurement/indents', payload);
        toast.success('Indent submitted — awaiting approval');
      }
      setModal(false); setEditingIndentId(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Pre-fill the Raise Indent modal with an existing indent's data so a
  // wrongly filled indent can be corrected in place. Indents that are
  // already approved or have an active Vendor PO against them are
  // blocked server-side anyway — we just hide the button for those.
  const openEditIndent = async (indent) => {
    try {
      const r = await api.get(`/procurement/indents/${indent.id}`);
      const data = r.data;
      setForm({
        site_name: data.site_name || '',
        raised_by_name: data.raised_by_name || '',
        notes: data.notes || '',
      });
      // Hydrate boqItems for this site so the BOQ Item dropdown populates.
      await reloadBoq(data.site_name || '');
      const rows = (data.items || []).map(it => ({
        po_item_id: it.po_item_id || '',
        item_master_id: it.item_master_id || '',
        description: it.description || '',
        make: it.make || '',
        quantity: +it.quantity || 0,
        unit: it.unit || 'nos',
        item_type: it.item_type || '',
        boq_qty: 0,
        remaining_qty: null,
        manual: !it.po_item_id && !!it.description,
      }));
      setIndentItems(rows.length ? rows : [{ ...EMPTY_ITEM }]);
      setEditingIndentId(indent.id);
      setModal('indent');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load indent');
    }
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
    // PO Number is now auto-generated server-side (VPO/YYYY/####) — no
    // manual entry. PO file is also optional; mam's flow is to create
    // the PO inside the ERP, not upload a Tally PDF.

    const items = Object.entries(poItemSelection)
      .filter(([, v]) => v.checked && +v.quantity > 0 && +v.rate > 0)
      .map(([iiId, v]) => ({ indent_item_id: +iiId, quantity: +v.quantity, rate: +v.rate }));

    const fd = new FormData();
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
      toast.success(`Vendor PO ${r.data.po_number} created (Rs ${r.data.total_amount.toLocaleString()}${r.data.lines ? `, ${r.data.lines} linked items` : ''}) — opening print view`);
      setModal(false); load();
      // mam asked for "after create show me po as pdf" — open the printable
      // PO in a new tab so she can review / print / share immediately. The
      // browser's "Save as PDF" handles the PDF generation.
      if (r.data.id) {
        setTimeout(() => window.open(`/vendor-po/${r.data.id}/print`, '_blank'), 300);
      }
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
    if (!form.document_type) return toast.error('Pick Sales Bill or Delivery Note');
    // document_number is now auto-generated server-side when blank — no
    // user-side required check. Mam can still type one to override.
    // File is OPTIONAL now — the ERP generates the document; the signed
    // copy is uploaded later via Mark Received. Mam: "like po I want from
    // erp create sales bill or dispatch which i give you format".
    const fd = new FormData();
    if (form.vendor_po_id) fd.append('vendor_po_id', form.vendor_po_id);
    if (form.delivery_date) fd.append('delivery_date', form.delivery_date);
    if (form.document_type) fd.append('document_type', form.document_type);
    // Only append a document_number if the user explicitly typed one
    // (mam can override the auto-generated value). When blank, the server
    // generates INV/YYYY/#### or DC/YYYY/#### automatically.
    if (form.document_number && form.document_number.trim()) fd.append('document_number', form.document_number.trim());
    if (form.notes) fd.append('notes', form.notes);
    // Document-type-specific fields driven by the conditional cards.
    if (form.document_type === 'challan') {
      ['vehicle_no', 'driver_name', 'driver_mobile', 'lr_challan_no', 'total_packages']
        .forEach(k => { if (form[k] != null && form[k] !== '') fd.append(k, form[k]); });
    } else {
      ['place_of_supply', 'state_code', 'e_way_bill_no', 'vehicle_no',
       'cgst_pct', 'sgst_pct', 'igst_pct', 'freight_amount', 'round_off_amount']
        .forEach(k => { if (form[k] != null && form[k] !== '') fd.append(k, form[k]); });
      if (form.reverse_charge) fd.append('reverse_charge', '1');
    }
    // Per-line-item overrides — only ship rows the user kept (include=true).
    // The server stores this in items_json and the print endpoint uses it
    // in preference to po_items / vendor_po_items. Each row carries qty,
    // rate and disc% so we can rebuild the taxable amount server-side.
    const includedItems = (dispatchItems || []).filter(it => it.include !== false);
    if (includedItems.length) {
      const payload = includedItems.map(it => {
        const qty = +it.quantity || 0;
        const rate = +it.rate || 0;
        const discPct = +it.disc_pct || 0;
        return {
          description: it.description || '',
          hsn: it.hsn || '',
          unit: it.unit || '',
          quantity: qty,
          rate,
          disc_pct: discPct,
          amount: +(qty * rate * (1 - discPct / 100)).toFixed(2),
          item_code: it.item_code || '',
          specification: it.specification || '',
          size: it.size || '',
          item_name: it.item_name || '',
        };
      });
      fd.append('items', JSON.stringify(payload));
      // Send computed subtotal + grand-total to the row too so the list
      // view can show the invoice value without re-joining items_json.
      const subtotal = payload.reduce((s, it) => s + it.amount, 0);
      const cgst = subtotal * (+form.cgst_pct || 0) / 100;
      const sgst = subtotal * (+form.sgst_pct || 0) / 100;
      const igst = subtotal * (+form.igst_pct || 0) / 100;
      const freight = +form.freight_amount || 0;
      const roundOff = +form.round_off_amount || 0;
      const grandTotal = subtotal + cgst + sgst + igst + freight + roundOff;
      fd.append('subtotal_amount', subtotal.toFixed(2));
      fd.append('grand_total_amount', grandTotal.toFixed(2));
    }
    if (form.dispatch_file) fd.append('file', form.dispatch_file);
    try {
      const r = await api.post('/procurement/delivery-notes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const which = form.document_type === 'challan' ? 'Delivery Challan' : 'Sales Bill';
      // Show the auto-generated number in the toast so mam knows what
      // INV/DC number was assigned.
      const generatedNo = r.data?.document_number;
      toast.success(generatedNo ? `${which} ${generatedNo} created` : `${which} created`);
      setModal(false); load();
      // Auto-open the generated document in a new tab so mam can print
      // immediately, matching the "create like a PO" feel she asked for.
      if (r.data?.id) {
        try {
          // Pull as arraybuffer + tag the blob as UTF-8 so ₹ / em-dash
          // don't render as mojibake when opened via blob: URL.
          const printRes = await api.get(`/procurement/delivery-notes/${r.data.id}/print`, { responseType: 'arraybuffer' });
          const blob = new Blob([printRes.data], { type: 'text/html;charset=utf-8' });
          window.open(URL.createObjectURL(blob), '_blank', 'noopener');
        } catch (_) { /* user can still click 🖨 Print in the list */ }
      }
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
    // Optional inventory hook — when mam picks a warehouse, the linked
    // vendor PO's items auto-land as stock IN at that warehouse on the
    // server side. Skipped silently if no warehouse selected.
    if (form.warehouse_id) fd.append('warehouse_id', form.warehouse_id);
    try {
      const r = await api.patch(`/procurement/delivery-notes/${form.receive_id}/receive`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const ins = r.data?.stock_ins || 0;
      toast.success(ins > 0 ? `Marked as received · ${ins} item${ins === 1 ? '' : 's'} added to stock` : 'Marked as received');
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
  // Merge indent items by (indent_id, item_master_id) so the same sub-item
  // appearing under multiple BOQs in one indent shows as a SINGLE row with
  // combined qty. mam's example: CHECK NUT appears under both MS PIPE and
  // FIRE BUCKET BOQs in IND-0007 — purchase team should fill rate ONCE,
  // not twice. Free-text manual entries (no item_master_id) keep their own
  // row since we can't safely merge them.
  const mergedRates = useMemo(() => {
    const groups = new Map();
    for (const r of itemRates) {
      const groupKey = r.item_master_id
        ? `${r.indent_id}__M${r.item_master_id}`
        : `__solo_${r.indent_item_id}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          ...r,
          indent_item_ids: [r.indent_item_id],
          rate_ids: r.rate_id ? [r.rate_id] : [],
          qty: +r.qty || 0,
        });
      } else {
        const m = groups.get(groupKey);
        m.indent_item_ids.push(r.indent_item_id);
        if (r.rate_id) m.rate_ids.push(r.rate_id);
        m.qty += +r.qty || 0;
        // Status: 'finalized' wins, else 'quoted', else 'pending'
        if (r.rate_status === 'finalized') m.rate_status = 'finalized';
        else if (r.rate_status === 'quoted' && m.rate_status !== 'finalized') m.rate_status = 'quoted';
        // Vendor data: keep the first non-empty value across the merged rows
        for (const n of [1, 2, 3]) {
          if (!m[`vendor${n}_name`] && r[`vendor${n}_name`]) {
            m[`vendor${n}_name`] = r[`vendor${n}_name`];
            m[`vendor${n}_rate`] = r[`vendor${n}_rate`];
            m[`vendor${n}_terms`] = r[`vendor${n}_terms`];
            m[`vendor${n}_credit_days`] = r[`vendor${n}_credit_days`];
          }
        }
        if (r.final_rate) {
          m.final_rate = r.final_rate;
          m.final_vendor_name = r.final_vendor_name;
          m.final_terms = r.final_terms;
          m.final_credit_days = r.final_credit_days;
        }
      }
    }
    return [...groups.values()];
  }, [itemRates]);

  // Apply a vendor / rate / terms patch to ALL underlying indent_items in
  // the merged group so the DB stays consistent across the rows that share
  // the same item_master in the same indent. Awaiting each call keeps the
  // UI's optimistic update logic intact.
  const updateMergedRate = async (mergedRow, patch) => {
    for (const iid of mergedRow.indent_item_ids) {
      await updateItemRate(iid, patch);
    }
  };

  // Admin-only: clear ALL the vendor quotes on a merged rate row so the row
  // returns to "Pending" status. Useful when mam wants to re-quote from
  // scratch (wrong rates entered, vendor list changed, etc.). Loops over
  // every rate_id in the merged group.
  const deleteMergedRate = async (mergedRow) => {
    if (!mergedRow.rate_ids?.length) {
      toast('Nothing to clear — no rates entered yet');
      return;
    }
    const label = [mergedRow.master_name || mergedRow.description, mergedRow.size, mergedRow.specification].filter(Boolean).join(' / ');
    if (!confirm(`Clear all vendor quotes for "${label}"?\nThe row will return to Pending.`)) return;
    try {
      for (const rid of mergedRow.rate_ids) {
        await api.delete(`/procurement/item-rates/${rid}`);
      }
      toast.success('Quotes cleared');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Clear failed'); }
  };

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
    // A merged row may carry multiple rate_ids (one per underlying indent_item
    // sharing the same item_master in the same indent). Finalize ALL of them
    // so the merged display stays consistent — every backing row picks the
    // same vendor + rate + terms.
    const rateIds = finalForm.row?.rate_ids?.length ? finalForm.row.rate_ids : [finalForm.rate_id].filter(Boolean);
    if (!rateIds.length) return toast.error('Enter a vendor rate first');
    try {
      for (const rid of rateIds) {
        await api.post(`/procurement/item-rates/${rid}/finalize`, finalForm);
      }
      toast.success('Rate finalized');
      setFinalModal(null); setFinalForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap items-center justify-between">
          <div className="flex gap-2 flex-wrap">{tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}>{t.label}</button>
          ))}</div>
          {/* One Export button — exports current tab's data */}
          <button onClick={() => {
            if (tab === 'indents')    exportCsv('indents',         ['Indent No','Date','Site','Raised By','Status','Items'], indents.map(i => [i.indent_number, i.indent_date, i.site_name, i.raised_by_name, i.status, (i.items||[]).length]));
            if (tab === 'pos')        exportCsv('vendor-pos',      ['PO Number','PO Date','Vendor','Amount','Status'], vendorPos.map(v => [v.po_number, v.po_date, v.vendor_name, v.total_amount, v.status]));
            if (tab === 'bills')      exportCsv('purchase-bills',  ['Bill No','Vendor','Date','Amount','GST','Total','Payment'], purchaseBills.map(b => [b.bill_number, b.vendor_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.payment_status]));
            if (tab === 'dispatch')   exportCsv('dispatch',        ['ID','Type','Doc No','PO','Date','Received By','Received On','Status'], deliveryNotes.map(d => [d.id, d.doc_type, d.doc_number, d.po_number, d.delivery_date, d.received_by_name, d.received_on, d.status]));
            if (tab === 'rates')      exportCsv('vendor-rates',    ['Item','Vendor 1','Rate 1','Vendor 2','Rate 2','Vendor 3','Rate 3','Final'], itemRates.map(r => [r.item_description, r.vendor1_name, r.vendor1_rate, r.vendor2_name, r.vendor2_rate, r.vendor3_name, r.vendor3_rate, r.final_rate]));
          }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
        </div>
      </div>

      {tab === 'indents' && (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h3 className="font-semibold">Raise Indent</h3>
            <button onClick={() => { setEditingIndentId(null); setForm({ notes: '', site_name: '', raised_by_name: user?.name || '' }); setIndentItems([{ ...EMPTY_ITEM }]); setBoqItems([]); setModal('indent'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Raise Indent</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
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
                        <div className="flex items-center gap-2">
                          <button onClick={() => toggleIndentRow(i.id)} className="text-xs text-red-600 hover:underline">
                            {items.length} item{items.length === 1 ? '' : 's'}
                          </button>
                          <a href={`/indent/${i.id}/print`} target="_blank" rel="noreferrer"
                             className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5"
                             title="Open print-friendly BoQ — Save as PDF from browser">
                            📄 PDF
                          </a>
                        </div>
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
                      {/* Separation of duties — mam (2026-05-21): a user
                          must NOT approve / reject their own indent.
                          Only show the Approve / Reject buttons when:
                          (a) status is 'submitted' AND
                          (b) the viewer has procurement-approve
                              permission (or is admin) AND
                          (c) the viewer is NOT the creator.
                          Backend enforces the same rule as a safety
                          net for direct API calls. */}
                      {i.status === 'submitted' && (canApprove('procurement') || isAdmin()) && i.created_by !== user?.id && (
                        <>
                          <button onClick={() => approveIndent(i.id, 'approved')} className="btn btn-success text-xs py-1 px-2">Approve</button>
                          <button onClick={() => approveIndent(i.id, 'rejected')} className="btn btn-danger text-xs py-1 px-2">Reject</button>
                        </>
                      )}
                      {/* If creator is viewing their own submitted indent,
                          show a small "Awaiting approval" hint instead so
                          they know what's happening. */}
                      {i.status === 'submitted' && i.created_by === user?.id && (
                        <span className="text-[10px] text-gray-500 italic" title="Only an approver can act on your indent">Awaiting approval</span>
                      )}
                      {i.status === 'draft' && <button onClick={() => approveIndent(i.id, 'submitted')} className="btn btn-primary text-xs py-1 px-2">Submit</button>}
                      {/* Edit — site engineers in training need to fix wrong
                          indents. Allowed for submitted / draft / rejected;
                          approved indents are frozen (server enforces too). */}
                      {(canEdit('procurement') || isAdmin()) && i.status !== 'approved' && (
                        <button onClick={() => openEditIndent(i)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit indent"><FiEdit2 size={14} /></button>
                      )}
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
                            <th className="text-left py-1 pr-3">BOQ Description</th>
                            <th className="text-left py-1 pr-3">Sub-Item (Item Master)</th>
                            <th className="text-left py-1 pr-3">Make</th>
                            <th className="text-right py-1 pr-3 w-20">Qty</th>
                            <th className="text-left py-1 pr-3 w-16">Unit</th>
                            <th className="text-left py-1 pr-3 w-16">Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it, idx) => (
                            <tr key={it.id} className="border-b border-gray-100 last:border-0 align-top">
                              <td className="py-1 pr-3 text-gray-500">{idx + 1}</td>
                              <td className="py-1 pr-3">{it.description || <span className="text-gray-400">—</span>}</td>
                              <td className="py-1 pr-3">
                                {/* Sub-Item column: shows item_code + name + size + spec from
                                    item_master so mam can tell rows of the same BOQ apart. */}
                                {(it.item_code || it.master_name) ? (
                                  <div>
                                    {it.item_code && <span className="font-mono text-[10px] text-gray-500">[{it.item_code}]</span>}
                                    {it.master_name && <span className="ml-1 font-medium">{it.master_name}</span>}
                                    {(it.master_specification || it.master_size) && (
                                      <div className="text-[10px] text-gray-500">
                                        {[it.master_size, it.master_specification].filter(Boolean).join(' / ')}
                                      </div>
                                    )}
                                  </div>
                                ) : <span className="text-gray-400 italic">manual entry</span>}
                              </td>
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
                  <span className="ml-1 opacity-80">({mergedRates.filter(r => f === 'all' ? true : (r.rate_status || 'pending') === f).length})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Desktop table — BOQ Item column intentionally removed:
              mam's spec is purchase team enters a vendor rate ONCE per
              (indent · sub-item), regardless of which BOQ line that
              sub-item came from. The same CHECK NUT used in two BOQs
              of one indent is now a SINGLE merged row. */}
          <div className="card p-0 overflow-x-auto hidden lg:block">
            <table className="text-xs" style={{ minWidth: '1400px' }}>
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-2 py-2 text-left" rowSpan="2">Indent</th>
                  <th className="px-2 py-2 text-left" rowSpan="2">Sub-Item<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(Item Master)</span></th>
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
                {mergedRates.filter(r => ratesFilter === 'all' ? true : (r.rate_status || 'pending') === ratesFilter).map(r => {
                  const stat = r.rate_status || 'pending';
                  const statColor = stat === 'finalized' ? 'bg-emerald-100 text-emerald-700' : stat === 'quoted' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700';
                  return (
                    <tr key={r.indent_item_ids.join('-')} className="border-b hover:bg-red-50/30">
                      <td className="px-2 py-2 whitespace-nowrap"><div className="font-medium text-red-700">{r.indent_number}</div><div className="text-[10px] text-gray-400">{r.site_name}</div></td>
                      <td className="px-2 py-2 align-top" style={{ width: '260px', minWidth: '260px', maxWidth: '260px' }}>
                        {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                        <div className="text-[11px] leading-snug font-medium">
                          {[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ') || <span className="text-gray-300">—</span>}
                        </div>
                        {r.make && <div className="text-[10px] text-gray-400 mt-0.5">Make: {r.make}</div>}
                        {r.indent_item_ids.length > 1 && (
                          <div className="text-[9px] text-gray-400 mt-0.5 italic">merged from {r.indent_item_ids.length} BOQ rows</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center font-semibold whitespace-nowrap">{r.qty} {cleanUnit(r.uom || r.unit)}</td>
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
                              onChange={(v) => updateMergedRate(r, { [`vendor${n}_name`]: v?.name || '' })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '120px' }}>
                            <input
                              className="input text-[11px] px-2 py-1 text-right"
                              style={{ width: '110px', minWidth: '110px' }}
                              type="number"
                              placeholder="0"
                              value={r[`vendor${n}_rate`] || ''}
                              onChange={e => updateMergedRate(r, { [`vendor${n}_rate`]: +e.target.value })}
                            />
                          </td>
                          <td className="px-1 py-1" style={{ minWidth: '180px' }}>
                            <div className="flex items-center gap-1">
                              <select
                                className="select text-[11px] px-2 py-1"
                                style={{ width: '90px', minWidth: '90px' }}
                                value={r[`vendor${n}_terms`] || ''}
                                onChange={e => updateMergedRate(r, { [`vendor${n}_terms`]: e.target.value })}
                              >
                                <option value="">—</option>
                                <option value="Advance">Advance</option>
                                <option value="Credit">Credit</option>
                              </select>
                              {/* Manual credit days entry — only when Credit
                                  is selected, otherwise hidden so Advance
                                  rows stay clean. */}
                              {r[`vendor${n}_terms`] === 'Credit' && (
                                <input
                                  type="number"
                                  min="0"
                                  className="input text-[11px] px-1 py-1 text-right"
                                  style={{ width: '70px' }}
                                  placeholder="days"
                                  value={r[`vendor${n}_credit_days`] || ''}
                                  onChange={e => updateMergedRate(r, { [`vendor${n}_credit_days`]: +e.target.value || 0 })}
                                  title="Credit days"
                                />
                              )}
                            </div>
                          </td>
                        </Fragment>
                      ))}
                      <td className="px-2 py-2"><span className={`badge ${statColor}`}>{stat}</span></td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          {stat === 'finalized'
                            ? <div className="text-[11px]"><div className="font-semibold text-emerald-700">{r.final_vendor_name}</div><div>Rs {r.final_rate}</div></div>
                            : <button onClick={() => openFinalize(r)} disabled={stat === 'pending'} className="btn btn-primary text-[11px] px-2 py-1 disabled:opacity-40">Finalize</button>}
                          {/* Admin-only: clear ALL vendor quotes for this row.
                              Useful when mam wants to re-quote (wrong rates,
                              vendor change, etc.). Returns row to Pending. */}
                          {(canApprove('procurement') || isAdmin()) && r.rate_ids?.length > 0 && (
                            <button onClick={() => deleteMergedRate(r)} className="p-1 text-gray-400 hover:text-red-600" title="Clear all quotes (re-quote)">
                              <FiTrash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {mergedRates.length === 0 && <tr><td colSpan="14" className="text-center py-8 text-gray-400">No indent items yet — raise an indent first.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout — uses the same merged-by-(indent · sub-item)
              data so the same item across multiple BOQs collapses to ONE
              card with the combined qty. */}
          <div className="lg:hidden space-y-2">
            {mergedRates.filter(r => ratesFilter === 'all' ? true : (r.rate_status || 'pending') === ratesFilter).map(r => {
              const stat = r.rate_status || 'pending';
              return (
                <div key={r.indent_item_ids.join('-')} className="card p-3 space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium text-red-700 text-xs">{r.indent_number}</div>
                      {r.item_code && <div className="text-[10px] font-mono text-gray-500">[{r.item_code}]</div>}
                      <div className="text-sm font-medium line-clamp-2">{[r.master_name || r.description, r.specification, r.size].filter(Boolean).join(' / ')}</div>
                      <div className="text-[10px] text-gray-400">{r.site_name} · {r.qty} {cleanUnit(r.uom || r.unit)}{r.make ? ` · ${r.make}` : ''}</div>
                      {r.indent_item_ids.length > 1 && (
                        <div className="text-[9px] text-gray-400 italic mt-0.5">merged from {r.indent_item_ids.length} BOQ rows</div>
                      )}
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
                          onChange={(v) => updateMergedRate(r, { [`vendor${n}_name`]: v?.name || '' })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input className="input text-xs" type="number" placeholder="Rate" value={r[`vendor${n}_rate`] || ''} onChange={e => updateMergedRate(r, { [`vendor${n}_rate`]: +e.target.value })} />
                        <select className="select text-xs" value={r[`vendor${n}_terms`] || ''} onChange={e => updateMergedRate(r, { [`vendor${n}_terms`]: e.target.value })}>
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
            {mergedRates.length === 0 && <div className="card text-center py-8 text-gray-400">No indent items yet.</div>}
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

          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>PO Number</th><th>Indent</th><th>PO Date</th><th>Vendor</th><th>Amount</th><th>File</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {vendorPos.map(v => (
                <tr key={v.id}>
                  <td className="font-medium">{v.po_number}</td>
                  {/* Indent column (mam, 2026-05-20). */}
                  <td className="text-xs">
                    <div className="font-mono font-semibold text-blue-800">{v.indent_number || <span className="text-gray-300">—</span>}</div>
                    {v.indent_site_name && <div className="text-[10px] text-gray-500 truncate max-w-[140px]" title={v.indent_site_name}>{v.indent_site_name}</div>}
                  </td>
                  <td>{v.po_date || <span className="text-gray-300">—</span>}</td>
                  <td>{v.vendor_name}</td>
                  <td>Rs {v.total_amount?.toLocaleString()}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <a href={`/vendor-po/${v.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-800 underline text-xs flex items-center gap-1">
                        <FiPrinter size={11} /> View / Print
                      </a>
                      {v.file_path && <a href={v.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-[10px]">attached PDF</a>}
                    </div>
                  </td>
                  <td>
                    {v.cancelled
                      ? <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-gray-200 text-gray-600 border border-gray-300" title={v.cancel_reason || 'Cancelled'}>Cancelled</span>
                      : <StatusBadge status={v.status} />}
                  </td>
                  <td>
                    {/* Three actions: Cancel (soft-delete, reverses), Restore
                        (only when already cancelled), Delete (hard, only when
                        no bills / delivery notes block it). */}
                    <div className="flex items-center gap-1">
                      {/* Edit (pencil) — mam (2026-05-20): "how can i
                          edit po after creation because some time
                          need".  Opens a modal with the safe-to-edit
                          header fields.  Hidden once cancelled
                          (restore first). */}
                      {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={() => openEditVendorPo(v)}
                                className="p-1 text-gray-400 hover:text-blue-700"
                                title="Edit PO (date / amount / advance / remarks)">
                          <FiEdit2 size={14} />
                        </button>
                      )}
                      {!v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={async () => {
                          const reason = prompt(`Cancel Vendor PO "${v.po_number}"?\n\nThe PO + linked bills/notes stay visible for audit, but it disappears from active follow-ups. Items go back to "Pending for PO".\n\nReason (optional):`);
                          if (reason === null) return;
                          try { await api.post(`/procurement/vendor-po/${v.id}/cancel`, { reason }); toast.success('PO cancelled'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Cancel failed'); }
                        }} className="p-1 text-gray-400 hover:text-amber-600" title="Cancel PO (soft delete)"><FiX size={14} /></button>
                      )}
                      {v.cancelled && (canApprove('procurement') || isAdmin()) && (
                        <button onClick={async () => {
                          if (!confirm(`Restore Vendor PO "${v.po_number}" from cancelled?`)) return;
                          try { await api.post(`/procurement/vendor-po/${v.id}/uncancel`); toast.success('PO restored'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Restore failed'); }
                        }} className="p-1 text-gray-400 hover:text-emerald-600" title="Restore PO"><FiCheck size={14} /></button>
                      )}
                      {canDelete('procurement') && (
                        <button onClick={async () => {
                          if (!confirm(`Permanently delete vendor PO "${v.po_number}"?\n\nWill fail if bills or delivery notes reference it — use Cancel instead in that case.`)) return;
                          try { await api.delete(`/procurement/vendor-po/${v.id}`); toast.success('Deleted'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600" title="Delete (hard)"><FiTrash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {vendorPos.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No vendor POs yet — click "Create Vendor PO"</td></tr>}
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
          // Skip cancelled POs — they're not waiting for a bill anymore.
          .filter(po => !billedPoIds.has(po.id) && !po.cancelled)
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
                    {/* Indent column added (mam, 2026-05-20: "show here
                        also indent number").  Carries indent_number +
                        site sub-text so mam can trace a PO back to its
                        raising indent without opening the row. */}
                    <th className="px-2 py-1 text-left">Indent</th>
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
                          <td className="px-2 py-1.5 max-w-[160px] whitespace-nowrap">
                            <div className="font-mono text-[11px] font-semibold text-blue-800">{po.indent_number || <span className="text-gray-300">—</span>}</div>
                            {po.indent_site_name && (
                              <div className="text-[10px] text-gray-500 truncate" title={po.indent_site_name}>{po.indent_site_name}</div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-1.5 text-center">{chip}</td>
                          {/* Show the LIVE computed total (items × 1.18 GST)
                              from display_total — matches what the PO print
                              shows.  Mam, 2026-05-16: header total drifted from
                              the line items.  Drift chip warns when the stored
                              total disagrees with the items sum. */}
                          <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                            Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}
                            {+po.total_amount_drift > 1 && (
                              <div className="text-[9px] text-amber-700 font-normal" title={`Stored: Rs ${(+po.total_amount).toLocaleString('en-IN')} · Items sum + 18% GST: Rs ${(+po.display_total).toLocaleString('en-IN')}`}>
                                ⚠ drift Rs {(+po.total_amount_drift).toLocaleString('en-IN')}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {/* Always show "View PO" — opens the ERP-generated
                                print page (PDF-able). If a Tally / signed scan
                                was also uploaded, show a second link below. */}
                            <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-800 underline text-[11px] font-semibold whitespace-nowrap">📄 View PO</a>
                            {po.file_path && (
                              <div><a href={po.file_path} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-[10px]">📎 attached file</a></div>
                            )}
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
          <div className="card p-0"><table className="freeze-head">
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
          billedPoIds.has(po.id) && !dispatchedPoIds.has(po.id) && !po.cancelled
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
          setDispatchItems([]);
          setDispatchItemsSource('empty');
          setDispatchBillTo(null);
          setModal('delivery');
          if (po?.id) {
            setDispatchItemsLoading(true);
            // Fire both fetches in parallel — items + bill-to.
            // Pass doc_type so the backend can refuse vendor-cost
            // fallback for sales_bill (mam, 2026-05-16: "if sales
            // bill we enter BOQ SITC rate").  openAddDispatch is
            // always called from a "create sales bill" path, so the
            // default is sales_bill; user can flip to challan in the
            // modal and we'll respect either way.
            Promise.all([
              api.get(`/procurement/vendor-pos/${po.id}/client-po-items`, { params: { doc_type: 'sales_bill' } }).catch(() => ({ data: { items: [], source: 'empty' } })),
              api.get(`/procurement/vendor-pos/${po.id}/bill-to`).catch(() => ({ data: null })),
            ]).then(([itemsRes, billRes]) => {
              const rawRows = (itemsRes.data?.items || []).map(it => ({
                include: true,
                description: [it.description, it.specification, it.size].filter(Boolean).join(' / ') || it.item_name || '',
                hsn: it.hsn_code || '',  // gst_text was misnamed — drop it (it's the rate, not HSN)
                unit: it.unit || '',
                quantity: +it.quantity || 0,
                rate: +it.rate || 0,
                disc_pct: 0,
                item_code: it.item_code || '',
                specification: it.specification || '',
                size: it.size || '',
                item_name: it.item_name || '',
              }));
              // Filter out ghost rows — anything with no description AND
              // (zero qty or zero rate) is junk that confuses mam (was
              // showing as "Item descrip · 0 · nos · 0 · 0" placeholders).
              const rows = rawRows.filter(r => {
                if (r.description && r.description.trim()) return true;
                return (+r.quantity > 0) || (+r.rate > 0);
              });
              setDispatchItems(rows);
              setDispatchItemsSource(rows.length ? (itemsRes.data?.source || 'po_items') : 'empty');
              setDispatchRateInfo({
                source: itemsRes.data?.rate_source || null,
                warning: itemsRes.data?.warning || null,
                rated: +itemsRes.data?.rated_count || 0,
                total: +itemsRes.data?.total_count || rows.length,
              });
              setDispatchBillTo(billRes.data || null);
              // Pre-fill GST defaults from the bill-to state (intra
              // vs inter-state).  Punjab = CGST/SGST 9% each.
              const sameState = (billRes.data?.client_state || '').toLowerCase() === 'punjab';
              setForm(f => ({
                ...f,
                cgst_pct: f.cgst_pct ?? (sameState ? 9 : 0),
                sgst_pct: f.sgst_pct ?? (sameState ? 9 : 0),
                igst_pct: f.igst_pct ?? (sameState ? 0 : 18),
                place_of_supply: f.place_of_supply || billRes.data?.client_state || '',
                state_code: f.state_code || billRes.data?.client_state_code || '',
              }));
            }).finally(() => setDispatchItemsLoading(false));
          }
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
                        <td className="px-2 py-1.5 font-semibold text-red-700 whitespace-nowrap">
                          {po.po_number}
                          <a href={`/vendor-po/${po.id}/print`} target="_blank" rel="noopener noreferrer" className="block text-[10px] text-red-600 hover:text-red-800 underline font-normal">📄 View PO</a>
                        </td>
                        <td className="px-2 py-1.5 max-w-[220px] truncate">{po.vendor_name}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.po_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-center whitespace-nowrap">{po.expected_receipt_date || <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                          Rs {(+po.display_total || +po.total_amount || 0).toLocaleString('en-IN')}
                          {+po.total_amount_drift > 1 && (
                            <div className="text-[9px] text-amber-700 font-normal" title={`Stored: Rs ${(+po.total_amount).toLocaleString('en-IN')} · Items sum + 18% GST: Rs ${(+po.display_total).toLocaleString('en-IN')}`}>
                              ⚠ drift Rs {(+po.total_amount_drift).toLocaleString('en-IN')}
                            </div>
                          )}
                        </td>
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
          <div className="card p-0"><table className="freeze-head">
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
                    {/* Print the auto-generated SEPL Delivery Note / Sales
                        Bill PDF (mam's templates). Fetched via axios so the
                        Bearer token rides along, then opened as a Blob URL —
                        plain window.open with a header-auth API would 401. */}
                    <button
                      onClick={async () => {
                        try {
                          // arraybuffer + utf-8 blob so ₹ / em-dash /
                          // 🖨 emoji don't render as Latin-1 mojibake.
                          const res = await api.get(`/procurement/delivery-notes/${d.id}/print`, { responseType: 'arraybuffer' });
                          const blob = new Blob([res.data], { type: 'text/html;charset=utf-8' });
                          window.open(URL.createObjectURL(blob), '_blank', 'noopener');
                        } catch (err) {
                          toast.error(err.response?.data?.error || 'Could not generate document');
                        }
                      }}
                      className="btn btn-secondary text-[10px] px-2 py-1 mr-1"
                      title={`Print SEPL ${d.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}`}
                    >🖨 Print</button>
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
      <Modal isOpen={modal === 'indent'} onClose={() => { setModal(false); setEditingIndentId(null); }} title={editingIndentId ? 'Edit Purchase Indent' : 'Raise Purchase Indent'} wide>
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
              {/* SUMMARY CHIPS — show BOQ count, sub-items count, Chargeable / FOC / POs expected.
                  Hidden until at least one row has a BOQ picked, otherwise the chips would all be 0. */}
              {(() => {
                const filled = indentItems.filter(it => it.po_item_id);
                if (filled.length === 0) return null;
                const boqCount = new Set(filled.map(it => it.po_item_id)).size;
                let chargeable = 0, foc = 0;
                filled.forEach(it => {
                  const t = String(it.item_type || '').toUpperCase();
                  if (t === 'FOC') foc++;
                  else if (t) chargeable++;
                });
                // POs expected ≈ unique makes among chargeable rows (one supplier = one PO).
                const posExpected = new Set(
                  filled.filter(it => String(it.item_type || '').toUpperCase() !== 'FOC')
                        .map(it => (it.make || '').trim().toLowerCase())
                        .filter(Boolean)
                ).size;
                const Chip = ({ label, value, color }) => (
                  <div className={`rounded-lg border ${color} px-2 py-1.5 text-center`}>
                    <div className="text-lg font-bold leading-none">{value}</div>
                    <div className="text-[10px] font-medium text-gray-600 mt-0.5 leading-tight">{label}</div>
                  </div>
                );
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <Chip label="BOQ items" value={boqCount} color="bg-blue-50 border-blue-200" />
                    <Chip label="Total sub-items" value={filled.length} color="bg-gray-50 border-gray-200" />
                    <Chip label="Chargeable" value={chargeable} color="bg-red-50 border-red-200" />
                    <Chip label="FOC" value={foc} color="bg-emerald-50 border-emerald-200" />
                    <Chip label="POs expected" value={posExpected || '—'} color="bg-purple-50 border-purple-200" />
                  </div>
                );
              })()}

              {/* GROUP rows by po_item_id so each BOQ is a parent section with its sub-items underneath.
                  Empty (un-picked) rows form their own placeholder group so the user can pick a BOQ. */}
              {(() => {
                const groups = [];
                const seen = new Map();
                indentItems.forEach((item, idx) => {
                  const key = item.po_item_id || `__empty_${idx}`;
                  if (!seen.has(key)) {
                    seen.set(key, groups.length);
                    groups.push({ boq_id: item.po_item_id || '', sample: item, rows: [] });
                  }
                  groups[seen.get(key)].rows.push({ item, idx });
                });

                return groups.map((group, gi) => (
                  // overflow-visible (not hidden) so the SearchableSelect's
                  // absolute-positioned options popup can escape this card.
                  // We use rounded-t-lg on the header instead so the top
                  // corners still look clean.
                  <div key={gi} className="border rounded-lg bg-gray-50/40">
                    {/* BOQ HEADER — picker if not yet picked, otherwise read-only summary */}
                    <div className={`${group.boq_id ? 'bg-gradient-to-r from-blue-50 to-blue-100' : 'bg-gray-50'} border-b px-3 py-2.5 rounded-t-lg`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          {group.boq_id ? (
                            <>
                              <div className="text-[10px] font-bold text-blue-700 uppercase">BOQ Item (from Client PO)</div>
                              <div className="text-sm font-semibold text-gray-800 truncate" title={group.sample.description}>
                                {group.sample.description || '(no description)'}
                              </div>
                              {(group.sample.boq_qty || group.sample.remaining_qty != null) ? (
                                <div className="text-[11px] text-gray-600 mt-0.5">
                                  {group.sample.boq_qty ? <>BOQ Qty: <span className="font-semibold">{group.sample.boq_qty}</span></> : null}
                                  {group.sample.remaining_qty != null ? <> · Remaining: <span className="font-semibold">{group.sample.remaining_qty}</span></> : null}
                                  <> · {group.rows.length} sub-item{group.rows.length === 1 ? '' : 's'}</>
                                </div>
                              ) : (
                                <div className="text-[11px] text-gray-500 mt-0.5">{group.rows.length} sub-item{group.rows.length === 1 ? '' : 's'}</div>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">BOQ Item — pick first <span className="text-red-500">*</span></div>
                              <SearchableSelect
                                options={boqItems.map(b => ({
                                  id: b.id,
                                  label: `${b.description || '(no desc)'}${b.boq_qty ? ' · Qty ' + b.boq_qty : ''}${b.item_type ? ' · ' + b.item_type : ''}`,
                                  ...b,
                                }))}
                                value={null} valueKey="id" displayKey="label"
                                placeholder={boqItems.length ? 'Search BOQ item from Client PO…' : 'No BOQ items for this site'}
                                onChange={(b) => pickBoqItem(group.rows[0].idx, b)}
                              />
                            </>
                          )}
                        </div>
                        {/* Remove the whole BOQ section (and all its sub-items) — only when more than one group exists. */}
                        {groups.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const idxToRemove = new Set(group.rows.map(r => r.idx));
                              setIndentItems(indentItems.filter((_, x) => !idxToRemove.has(x)));
                            }}
                            className="p-1 text-gray-400 hover:text-red-600 flex-shrink-0"
                            title="Remove this BOQ section"
                          >
                            <FiTrash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* SUB-ITEMS LIST — shown only when a BOQ is picked. Each row picks an Item Master sub-item. */}
                    {group.boq_id && (
                      <div className="p-2 space-y-2">
                        {/* Desktop column headers */}
                        <div className="hidden md:grid gap-2 text-[10px] font-bold text-gray-500 uppercase px-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                          <div className="col-span-4">Sub-Item (Item Master) <span className="text-red-500">*</span></div>
                          <div className="col-span-2">Make</div>
                          <div className="col-span-2">Type</div>
                          <div className="col-span-2">Qty</div>
                          <div className="col-span-2">Unit</div>
                          <div className="col-span-3">Required by</div>
                          <div></div>
                        </div>

                        {group.rows.map(({ item, idx: i }, subIdx) => {
                          const t = String(item.item_type || '').toUpperCase();
                          const typeClass = t === 'FOC' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : t === 'RGP' ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : t === 'PO' ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-gray-50 text-gray-500 border-gray-200';
                          const masterPicker = (
                            <SearchableSelect
                              options={masterItems.map(m => ({ id: m.id, label: `[${m.item_code}] ${m.display_name || m.item_name}${m.type ? ' · ' + m.type : ''}`, ...m }))}
                              value={item.item_master_id || null} valueKey="id" displayKey="label"
                              placeholder="Search sub-item from Item Master…"
                              onChange={(m) => pickMasterItem(i, m)}
                            />
                          );
                          const makeInput = <input className="input text-sm" placeholder="Make" value={item.make || ''} onChange={e => { const n = [...indentItems]; n[i].make = e.target.value; setIndentItems(n); }} />;
                          const qtyInput = <input className="input text-base font-bold text-right" type="number" min="0" placeholder="Qty" value={item.quantity} onChange={e => { const n = [...indentItems]; n[i].quantity = +e.target.value; setIndentItems(n); }} />;
                          // Per-item required-by date — mam (2026-05-21):
                          // each row on the Vendor PO print should show
                          // its own "DUE ON" date, not one PO-level
                          // date stamped on every line.
                          const reqDateInput = <input className="input text-sm" type="date" value={item.required_date || ''} onChange={e => { const n = [...indentItems]; n[i].required_date = e.target.value; setIndentItems(n); }} />;
                          // Unit dropdown — UNIT_OPTIONS covers the common cases.
                          // If the BOQ / Item Master has pre-filled a unit that
                          // isn't in the list (e.g. 'metres'), keep it as an
                          // option so it stays selected; otherwise mam can pick
                          // any standard unit without typing.
                          const curUnit = (item.unit || '').toString().trim();
                          const unitOpts = curUnit && !UNIT_OPTIONS.some(u => u.toLowerCase() === curUnit.toLowerCase())
                            ? [curUnit, ...UNIT_OPTIONS]
                            : UNIT_OPTIONS;
                          const unitInput = (
                            <select className="select text-sm" value={curUnit || 'nos'} onChange={e => { const n = [...indentItems]; n[i].unit = e.target.value; setIndentItems(n); }}>
                              {unitOpts.map(u => <option key={u} value={u}>{u}</option>)}
                            </select>
                          );
                          const typeBox = (
                            <div className={`text-center text-[11px] font-bold uppercase px-2 py-1.5 rounded-lg border ${typeClass}`} title="Auto-picked from Item Master sub-item">
                              {item.item_type || <span className="text-gray-400 normal-case font-normal">—</span>}
                            </div>
                          );
                          // Per-sub-item remove only meaningful when there's more than 1 sub-item in this BOQ;
                          // to remove the LAST sub-item, the user removes the entire BOQ section via the header trash.
                          const removeBtn = group.rows.length > 1 ? (
                            <button type="button" onClick={() => setIndentItems(indentItems.filter((_, x) => x !== i))} className="p-1 text-gray-300 hover:text-red-600" title="Remove sub-item">
                              <FiTrash2 size={14} />
                            </button>
                          ) : <div className="w-5" />;

                          return (
                            <div key={i}>
                              {/* MOBILE — stacked card */}
                              <div className="md:hidden border rounded-lg p-2.5 bg-white space-y-2 relative">
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-bold text-gray-400 uppercase">Sub-item {subIdx + 1}</span>
                                  {removeBtn}
                                </div>
                                <div>
                                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Sub-Item <span className="text-gray-400 font-normal normal-case">(Item Master)</span></label>
                                  {masterPicker}
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                  <div className="col-span-2"><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Qty</label>{qtyInput}</div>
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Unit</label>{unitInput}</div>
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Type</label>{typeBox}</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Make</label>{makeInput}</div>
                                  <div><label className="block text-[10px] font-bold text-gray-500 uppercase mb-0.5">Required by</label>{reqDateInput}</div>
                                </div>
                              </div>

                              {/* DESKTOP — single row */}
                              <div className="hidden md:block">
                                <div className="grid gap-2 items-center bg-white border rounded-lg p-2" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr)) auto' }}>
                                  <div className="col-span-4">{masterPicker}</div>
                                  <div className="col-span-2">{makeInput}</div>
                                  <div className="col-span-2">{typeBox}</div>
                                  <div className="col-span-2">{qtyInput}</div>
                                  <div className="col-span-2">{unitInput}</div>
                                  <div className="col-span-3" title="Required-by date for this item — shows on Vendor PO 'DUE ON' column">{reqDateInput}</div>
                                  {removeBtn}
                                </div>
                              </div>
                            </div>
                          );
                        })}

                        {/* Add another sub-item under the same BOQ — pre-fills the BOQ link so the user only picks the sub-item. */}
                        <button
                          type="button"
                          onClick={() => setIndentItems([...indentItems, {
                            ...EMPTY_ITEM,
                            po_item_id: group.boq_id,
                            description: group.sample.description,
                            boq_qty: group.sample.boq_qty,
                            remaining_qty: group.sample.remaining_qty,
                            unit: group.sample.unit || 'nos',
                          }])}
                          className="text-[11px] text-blue-600 hover:text-blue-800 font-medium px-1 py-1"
                        >+ Add sub-item to this BOQ</button>
                      </div>
                    )}
                  </div>
                ));
              })()}

              <button type="button" onClick={() => setIndentItems([...indentItems, { ...EMPTY_ITEM }])} className="btn btn-secondary text-xs">+ Add another BOQ item</button>
            </>
          )}
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Any remarks for Purchase…" /></div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
            <button type="button" onClick={() => { setModal(false); setEditingIndentId(null); }} className="btn btn-secondary w-full sm:w-auto">Cancel</button>
            <button type="submit" className="btn btn-primary w-full sm:w-auto">{editingIndentId ? 'Save Changes' : 'Submit Indent'}</button>
          </div>
        </form>
      </Modal>

      {/* Vendor PO Modal — PO is created INSIDE the ERP. PO number is
          auto-generated (VPO/YYYY/####) on save. File upload is optional
          (e.g. if mam later wants to attach a signed scan). */}
      <Modal isOpen={modal === 'vendorpo'} onClose={() => setModal(false)} title="Create Vendor PO" wide>
        <form onSubmit={saveVendorPo} className="space-y-4">
          <p className="text-[11px] text-gray-500 bg-blue-50 border border-blue-100 rounded px-3 py-2">
            Fill the details below — the PO number will be auto-generated as <b>VPO/{new Date().getFullYear()}/####</b> on save. Link to an indent so the "Pending for PO" list clears.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">PO Number <span className="text-gray-400 font-normal">(auto-generated)</span></label>
              <input
                className="input bg-gray-50 text-gray-700 cursor-not-allowed"
                placeholder={`VPO/${new Date().getFullYear()}/####`}
                value={`Auto-generated when you click "Create Vendor PO"`}
                readOnly
                title="PO numbers are issued by the system in VPO/YYYY/#### format — no manual entry needed."
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Format: VPO/{new Date().getFullYear()}/0001 — assigned automatically on save.</p>
            </div>
            <div>
              <label className="label">PO Date *</label>
              <input className="input" type="date" value={form.po_date || ''} onChange={e => setForm({...form, po_date: e.target.value})} required />
            </div>
            {/* Link to Indent now sits directly after PO Date — picking an indent
                here pre-fills the Vendor and pulls the indent's items into the
                line-item picker below. mam wanted this prominent so the PO is
                anchored to a specific indent up-front. */}
            <div className="sm:col-span-2">
              <label className="label">Link to Indent <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.indent_id || ''} onChange={e => pickIndentForPo(e.target.value)}>
                <option value="">— No indent link —</option>
                {indents.map(i => <option key={i.id} value={i.id}>{i.indent_number} — {i.site_name}</option>)}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">Picking an indent auto-fills the vendor + loads its items below for selection.</p>
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
              <label className="label">PO Total Amount <span className="text-gray-400 font-normal">(auto-computed from items)</span></label>
              <input className="input" type="number" step="0.01" min="0" placeholder="0" value={form.total_amount || ''} onChange={e => setForm({...form, total_amount: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Leave blank to use SUM(qty × rate) of the linked indent items.</p>
            </div>
            <div>
              <label className="label">Expected Receipt Date <span className="text-gray-400 font-normal">(when goods are due from vendor)</span></label>
              <input className="input" type="date" value={form.expected_receipt_date || ''} onChange={e => setForm({...form, expected_receipt_date: e.target.value})} />
              <p className="text-[10px] text-gray-400 mt-0.5">Used to chase vendor follow-ups and trigger the Purchase Bill upload.</p>
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
            <button type="submit" className="btn btn-primary">Create Vendor PO</button>
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

      {/* Create Sales Bill / Delivery Note — mam: "like po I want from erp
          create sales bill or dispatch". The form gathers everything the
          template needs, save submits the data, and the SEPL-format
          document is generated right after save (opens in a new tab).
          The signed-copy upload is now a follow-up step after delivery. */}
      <Modal isOpen={modal === 'delivery'} onClose={() => setModal(false)} title={(() => {
        const which = form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill';
        return form.vendor_po_number ? `Create ${which} — ${form.vendor_po_number}` : `Create ${which}`;
      })()}>
        <form onSubmit={saveDeliveryNote} className="space-y-4">
          {form.vendor_po_number && (
            <div className="bg-emerald-50 border border-emerald-200 rounded px-3 py-2 text-xs text-emerald-700">
              Linked to <strong>source Vendor PO</strong> <b>{form.vendor_po_number}</b>. Once this dispatch is recorded, the PO moves off the "Ready to Dispatch" list.
            </div>
          )}

          {/* BILL TO block — mam (2026-05-16): "no client / bill-to block"
              was issue #1.  Surfaces every field a tax invoice needs:
              client name + address + GSTIN + state + state code +
              linked client PO.  Pulled live when a Vendor PO is
              selected.  Yellow warning when any critical field is
              missing so mam knows to fix BB before saving. */}
          {form.document_type === 'sales_bill' && (
            <div className="border-2 border-blue-200 bg-blue-50/40 rounded p-3 space-y-2 text-xs">
              <div className="text-[10px] font-bold uppercase text-blue-700">Bill To · Customer</div>
              {!dispatchBillTo ? (
                <div className="text-gray-400 italic">Pick a Vendor PO to load client details…</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <div className="font-bold text-sm">{dispatchBillTo.client_company || <span className="text-amber-700">— client_company missing in BB —</span>}</div>
                      {dispatchBillTo.client_person_name && <div className="text-gray-600">Attn: {dispatchBillTo.client_person_name}</div>}
                      {dispatchBillTo.client_address && <div className="text-gray-600 mt-1">{dispatchBillTo.client_address}</div>}
                      <div className="text-gray-600">
                        {[dispatchBillTo.client_district, dispatchBillTo.client_state].filter(Boolean).join(', ')}
                      </div>
                      {(dispatchBillTo.client_phone || dispatchBillTo.client_email) && (
                        <div className="text-gray-600 mt-1">
                          {dispatchBillTo.client_phone && <>📞 {dispatchBillTo.client_phone}</>}
                          {dispatchBillTo.client_phone && dispatchBillTo.client_email && ' · '}
                          {dispatchBillTo.client_email}
                        </div>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      <div><span className="text-gray-500">GSTIN:</span> <span className="font-mono font-semibold">{dispatchBillTo.client_gstin || <span className="text-amber-700">— not set —</span>}</span></div>
                      <div><span className="text-gray-500">State Code:</span> <span className="font-mono">{dispatchBillTo.client_state_code || <span className="text-amber-700">—</span>}</span></div>
                      <div><span className="text-gray-500">Lead:</span> <span className="font-mono">{dispatchBillTo.lead_no || '—'}</span></div>
                      <div><span className="text-gray-500">Client PO:</span> <span className="font-mono">{dispatchBillTo.client_po_number || '—'}</span></div>
                      <div><span className="text-gray-500">Site:</span> {dispatchBillTo.site_name || '—'}</div>
                    </div>
                  </div>
                  {(!dispatchBillTo.client_company || !dispatchBillTo.client_gstin) && (
                    <div className="text-[10px] bg-amber-100 text-amber-800 border border-amber-200 rounded px-2 py-1 mt-1">
                      ⚠ Customer details incomplete in Business Book. Fix BB row before saving — a tax invoice without
                      {!dispatchBillTo.client_company && ' a client name'}
                      {!dispatchBillTo.client_company && !dispatchBillTo.client_gstin && ' /'}
                      {!dispatchBillTo.client_gstin && ' GSTIN'} is not legally valid.
                    </div>
                  )}
                </>
              )}
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
              <label className="label">Source Vendor PO <span className="text-[10px] text-gray-400 font-normal">(supply — items came from this PO)</span></label>
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
              <label className="label">{form.document_type === 'challan' ? 'Challan' : 'Sales Bill'} Number</label>
              {/* Auto-generated on save unless mam expands "Override" and
                  types her own. Keeps the modal clean and prevents
                  duplicate / inconsistent numbering. */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
                <span className="font-mono font-semibold">
                  {form.document_type === 'challan'
                    ? `DC/${new Date().getFullYear()}/####`
                    : `INV/${new Date().getFullYear()}/####`}
                </span>
                <span className="text-emerald-600">— auto-generated on save</span>
              </div>
              <details className="mt-1 text-[10px] text-gray-500">
                <summary className="cursor-pointer hover:text-gray-700">Override manually</summary>
                <input
                  className="input mt-1"
                  value={form.document_number || ''}
                  onChange={e => setForm({...form, document_number: e.target.value})}
                  placeholder={form.document_type === 'challan' ? 'e.g. DC/2026/0042' : 'e.g. INV/2026/0042'}
                />
              </details>
            </div>
            <div>
              <label className="label">Dispatch Date</label>
              <input className="input" type="date" value={form.delivery_date || ''} onChange={e => setForm({...form, delivery_date: e.target.value})} />
            </div>
          </div>

          {/* Editable line items — pulled from the Client PO (po_items) so
              the rate column is the SELLING price, not vendor cost. Mam:
              "give option for edit" — she wants to tweak qty / rate /
              disc % per row before the bill is generated. */}
          <div className="border border-red-200 bg-red-50/40 rounded p-3 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-[10px] font-bold uppercase text-red-700">Line Items</div>
                <div className="text-[10px] text-gray-500">
                  {dispatchItemsLoading ? 'Loading from Client PO…'
                   : form.document_type === 'challan'
                     ? 'Delivery Challan — no rate column (FOC / RGP, not billable). Uncheck items you\'re not dispatching today.'
                     : dispatchItemsSource === 'po_items'
                       ? <>Rate column = <strong className="text-emerald-700">BOQ SITC selling rate</strong> from Client PO. Tweak qty / disc % if needed, or uncheck rows you\'re not billing today.{dispatchRateInfo.rated < dispatchRateInfo.total && <span className="text-amber-700"> ⚠ {dispatchRateInfo.total - dispatchRateInfo.rated} of {dispatchRateInfo.total} BOQ rows have ₹0 rate — fill them in or skip.</span>}</>
                       : dispatchItemsSource === 'vendor_po' ? 'No Client PO items found — falling back to Vendor PO items (vendor cost). Verify rates before saving.'
                       : 'No items pre-filled. Add rows manually below.'}
                </div>
                {/* Hard warning when BOQ rates are missing on a Sales Bill — mam (2026-05-16) */}
                {form.document_type === 'sales_bill' && !dispatchItemsLoading && dispatchRateInfo.warning && (
                  <div className="text-[11px] bg-red-100 border border-red-300 text-red-800 rounded p-2 mt-1">
                    ❌ <strong>BOQ SITC rates missing.</strong> {dispatchRateInfo.warning}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="text-[11px] px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-100"
                onClick={() => setDispatchItems(prev => [...prev, {
                  include: true, description: '', hsn: '', unit: 'nos',
                  quantity: 0, rate: 0, disc_pct: 0,
                }])}
              >+ Add row</button>
            </div>
            {/* Challan = FOC / RGP, not billable, so we hide Rate / Disc /
                Amount columns entirely. Sales Bill keeps the full set. */}
            <div className="overflow-x-auto -mx-3">
              {(() => {
                const isChallan = form.document_type === 'challan';
                const emptyColspan = isChallan ? 6 : 9;
                const subtotalLabelColspan = isChallan ? 5 : 7;
                return (
              <table className="w-full text-[11px]">
                <thead className="bg-red-100/60 text-red-800 uppercase">
                  <tr>
                    <th className="px-1 py-1 text-center" style={{ width: '32px' }}>✓</th>
                    <th className="px-2 py-1 text-left">Description</th>
                    <th className="px-1 py-1 text-left" style={{ width: '70px' }}>HSN</th>
                    <th className="px-1 py-1 text-right" style={{ width: '70px' }}>Qty</th>
                    <th className="px-1 py-1 text-left" style={{ width: '60px' }}>UOM</th>
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '90px' }}>Rate (₹)</th>}
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '60px' }}>Disc %</th>}
                    {!isChallan && <th className="px-1 py-1 text-right" style={{ width: '100px' }}>Amount (₹)</th>}
                    <th className="px-1 py-1" style={{ width: '32px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {dispatchItems.length === 0 && !dispatchItemsLoading && (
                    <tr><td colSpan={emptyColspan} className="px-2 py-3 text-center text-gray-400 italic">No line items yet. Click "+ Add row" to add manually.</td></tr>
                  )}
                  {dispatchItems.map((it, idx) => {
                    const qty = +it.quantity || 0;
                    const rate = +it.rate || 0;
                    const discPct = +it.disc_pct || 0;
                    const amount = qty * rate * (1 - discPct / 100);
                    const update = (patch) => {
                      setDispatchItems(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
                    };
                    return (
                      <tr key={idx} className={`border-b border-red-100 ${it.include === false ? 'opacity-40 bg-gray-50' : ''}`}>
                        <td className="px-1 py-1 text-center">
                          <input type="checkbox" checked={it.include !== false} onChange={e => update({ include: e.target.checked })} className="w-3.5 h-3.5" />
                        </td>
                        <td className="px-2 py-1">
                          <input className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5" value={it.description || ''} onChange={e => update({ description: e.target.value })} placeholder="Item description" />
                        </td>
                        <td className="px-1 py-1">
                          <input className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-[10px]" value={it.hsn || ''} onChange={e => update({ hsn: e.target.value })} placeholder="HSN" />
                        </td>
                        <td className="px-1 py-1 text-right">
                          <input type="number" step="0.01" min="0" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.quantity ?? ''} onChange={e => update({ quantity: e.target.value })} />
                        </td>
                        <td className="px-1 py-1">
                          <input className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-[10px]" value={it.unit || ''} onChange={e => update({ unit: e.target.value })} placeholder="nos" />
                        </td>
                        {!isChallan && (
                          <td className="px-1 py-1 text-right">
                            <input type="number" step="0.01" min="0" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.rate ?? ''} onChange={e => update({ rate: e.target.value })} />
                          </td>
                        )}
                        {!isChallan && (
                          <td className="px-1 py-1 text-right">
                            <input type="number" step="0.01" min="0" max="100" className="w-full bg-transparent border-0 focus:outline-none focus:ring-1 focus:ring-red-300 rounded px-1 py-0.5 text-right" value={it.disc_pct ?? ''} onChange={e => update({ disc_pct: e.target.value })} placeholder="0" />
                          </td>
                        )}
                        {!isChallan && (
                          <td className="px-1 py-1 text-right font-mono">{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        )}
                        <td className="px-1 py-1 text-center">
                          <button type="button" className="text-red-400 hover:text-red-600 text-sm leading-none" title="Remove row" onClick={() => setDispatchItems(prev => prev.filter((_, i) => i !== idx))}>×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {!isChallan && dispatchItems.some(it => it.include !== false) && (() => {
                  // Compute live tax preview — mam (2026-05-16): "no
                  // GST preview before save".  Subtotal × form rates,
                  // shown right under the table so the grand total is
                  // visible while the user is still editing items.
                  const subtotal = dispatchItems.filter(it => it.include !== false).reduce((s, it) => {
                    const qty = +it.quantity || 0;
                    const rate = +it.rate || 0;
                    const discPct = +it.disc_pct || 0;
                    return s + qty * rate * (1 - discPct / 100);
                  }, 0);
                  const cgst = subtotal * (+form.cgst_pct || 0) / 100;
                  const sgst = subtotal * (+form.sgst_pct || 0) / 100;
                  const igst = subtotal * (+form.igst_pct || 0) / 100;
                  const freight = +form.freight_amount || 0;
                  const roundOff = +form.round_off_amount || 0;
                  const grand = subtotal + cgst + sgst + igst + freight + roundOff;
                  const fmt2 = (n) => (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  return (
                    <tfoot>
                      <tr className="border-t-2 border-red-300 font-semibold">
                        <td colSpan={subtotalLabelColspan} className="px-2 py-1 text-right text-red-800">Sub-total (taxable)</td>
                        <td className="px-1 py-1 text-right font-mono text-red-800">{fmt2(subtotal)}</td>
                        <td></td>
                      </tr>
                      {cgst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">CGST @ {form.cgst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(cgst)}</td><td></td></tr>
                      )}
                      {sgst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">SGST @ {form.sgst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(sgst)}</td><td></td></tr>
                      )}
                      {igst > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">IGST @ {form.igst_pct}%</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(igst)}</td><td></td></tr>
                      )}
                      {freight > 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">Freight</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(freight)}</td><td></td></tr>
                      )}
                      {roundOff !== 0 && (
                        <tr><td colSpan={subtotalLabelColspan} className="px-2 py-0.5 text-right text-gray-600 text-[10px]">Round-off</td><td className="px-1 py-0.5 text-right font-mono text-gray-700">{fmt2(roundOff)}</td><td></td></tr>
                      )}
                      <tr className="border-t-2 border-red-400 font-extrabold bg-red-100/40">
                        <td colSpan={subtotalLabelColspan} className="px-2 py-1.5 text-right text-red-900 text-sm">GRAND TOTAL</td>
                        <td className="px-1 py-1.5 text-right font-mono text-red-900 text-sm">₹ {fmt2(grand)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
                );
              })()}
            </div>
          </div>

          {/* Conditional fields per document type — fed into the auto-generated
              print page so it matches mam's SEPL Delivery Note / Sales Bill
              templates 1:1. */}
          {form.document_type === 'challan' && (
            <div className="border border-sky-200 bg-sky-50/40 rounded p-3 space-y-3">
              <div className="text-[10px] font-bold uppercase text-sky-700">Vehicle / Transport Details</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className="label">Vehicle No.</label><input className="input" value={form.vehicle_no || ''} onChange={e => setForm({ ...form, vehicle_no: e.target.value })} placeholder="e.g. PB10AB1234" /></div>
                <div><label className="label">Driver Name & Mobile</label><div className="grid grid-cols-2 gap-2"><input className="input" placeholder="Driver name" value={form.driver_name || ''} onChange={e => setForm({ ...form, driver_name: e.target.value })} /><input className="input" placeholder="Mobile" value={form.driver_mobile || ''} onChange={e => setForm({ ...form, driver_mobile: e.target.value })} /></div></div>
                <div><label className="label">LR / Challan No.</label><input className="input" value={form.lr_challan_no || ''} onChange={e => setForm({ ...form, lr_challan_no: e.target.value })} /></div>
                <div><label className="label">Total Packages</label><input className="input" value={form.total_packages || ''} onChange={e => setForm({ ...form, total_packages: e.target.value })} placeholder="e.g. 3 boxes + 2 bundles" /></div>
              </div>
            </div>
          )}
          {form.document_type === 'sales_bill' && (
            <div className="border border-emerald-200 bg-emerald-50/40 rounded p-3 space-y-3">
              <div className="text-[10px] font-bold uppercase text-emerald-700">Tax Invoice Details</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div><label className="label">Place of Supply</label><input className="input" value={form.place_of_supply || ''} onChange={e => setForm({ ...form, place_of_supply: e.target.value })} placeholder="e.g. Punjab" /></div>
                <div><label className="label">State Code</label><input className="input" value={form.state_code || ''} onChange={e => setForm({ ...form, state_code: e.target.value })} placeholder="e.g. 03" /></div>
                <div><label className="label">E-Way Bill No.</label><input className="input" value={form.e_way_bill_no || ''} onChange={e => setForm({ ...form, e_way_bill_no: e.target.value })} /></div>
                <div className="flex items-center gap-2"><input type="checkbox" id="rev_charge" checked={!!form.reverse_charge} onChange={e => setForm({ ...form, reverse_charge: e.target.checked })} className="w-4 h-4" /><label htmlFor="rev_charge" className="text-sm">Reverse Charge</label></div>
                <div><label className="label">Vehicle No.</label><input className="input" value={form.vehicle_no || ''} onChange={e => setForm({ ...form, vehicle_no: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                <div><label className="label">CGST %</label><input className="input" type="number" min="0" step="0.01" value={form.cgst_pct || ''} onChange={e => setForm({ ...form, cgst_pct: +e.target.value })} placeholder="9" /></div>
                <div><label className="label">SGST %</label><input className="input" type="number" min="0" step="0.01" value={form.sgst_pct || ''} onChange={e => setForm({ ...form, sgst_pct: +e.target.value })} placeholder="9" /></div>
                <div><label className="label">IGST %</label><input className="input" type="number" min="0" step="0.01" value={form.igst_pct || ''} onChange={e => setForm({ ...form, igst_pct: +e.target.value })} placeholder="0" /></div>
                <div><label className="label">Freight (Rs)</label><input className="input" type="number" min="0" value={form.freight_amount || ''} onChange={e => setForm({ ...form, freight_amount: +e.target.value })} /></div>
                <div><label className="label">Round Off (Rs)</label><input className="input" type="number" step="0.01" value={form.round_off_amount || ''} onChange={e => setForm({ ...form, round_off_amount: +e.target.value })} /></div>
              </div>
              <p className="text-[10px] text-emerald-700">For Punjab clients: CGST 9% + SGST 9% = 18%. For other states: IGST 18%.</p>
            </div>
          )}

          {/* Existing-document attachment is now optional + de-emphasised
              since the ERP itself generates the SEPL-format document.
              Use this only if you already have a paper copy you want to
              attach for reference. The signed copy goes in via Mark
              Received after delivery. */}
          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-700">Optionally attach an existing scan now (not required)</summary>
            <div className="mt-2">
              <input className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" onChange={e => setForm({ ...form, dispatch_file: e.target.files?.[0] || null })} />
              {form.dispatch_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.dispatch_file.name}</p>}
            </div>
          </details>
          <div><label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-[11px] text-blue-800">
            On <b>Create</b>, the ERP will generate the SEPL-format <b>{form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}</b> from this PO's items and client info, and open it in a new tab ready to print. The signed copy gets uploaded later via Mark Received.
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create {form.document_type === 'challan' ? 'Delivery Note' : 'Sales Bill'}</button></div>
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
              required
              onChange={e => setForm({ ...form, receipt_file: e.target.files?.[0] || null })}
            />
            {form.receipt_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.receipt_file.name}</p>}
            <p className="text-[10px] text-gray-400 mt-0.5">On mobile, tapping this opens the camera directly — take the photo of the stamped sales bill / challan.</p>
          </div>
          {/* Optional inventory link — pick a warehouse to auto-add the
              vendor PO's items as stock. Leave blank to skip. */}
          {warehouses.length > 0 && (
            <div>
              <label className="label">Add to Inventory at Warehouse <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="select" value={form.warehouse_id || ''} onChange={e => setForm({ ...form, warehouse_id: e.target.value })}>
                <option value="">— don't add to stock (manual entry later) —</option>
                {warehouses.filter(w => w.active).map(w => (
                  <option key={w.id} value={w.id}>{w.name}{w.type === 'office' ? ' ★' : ''}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-0.5">If selected, every item from this vendor PO automatically lands in that warehouse with the PO rate. Skip if you'll record stock manually in Inventory.</p>
            </div>
          )}
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
            <div>
              <label className="label">Final Vendor *</label>
              {/* Dropdown of the 3 quoted vendors. mam's flow: 90% of the
                  time the lowest rate (auto-suggested) is right; ~10% of
                  the time mam picks a HIGHER rate vendor because they
                  offer Credit. Picking a vendor here auto-fills the
                  matching rate / terms / credit days from that vendor's
                  quote — overrides allowed below. */}
              <select
                className="select"
                required
                value={finalForm.final_vendor_name || ''}
                onChange={e => {
                  const name = e.target.value;
                  // Find which of the 3 vendor slots matches the picked name,
                  // then copy its rate / terms / credit_days into the final fields.
                  let nMatch = 0;
                  for (const n of [1, 2, 3]) {
                    if (finalModal?.[`vendor${n}_name`] === name) { nMatch = n; break; }
                  }
                  setFinalForm(f => ({
                    ...f,
                    final_vendor_name: name,
                    final_rate: nMatch ? +finalModal[`vendor${nMatch}_rate`] || 0 : f.final_rate,
                    final_terms: nMatch ? finalModal[`vendor${nMatch}_terms`] || '' : f.final_terms,
                    final_credit_days: nMatch ? +finalModal[`vendor${nMatch}_credit_days`] || 0 : f.final_credit_days,
                  }));
                }}
              >
                <option value="">— Pick vendor —</option>
                {finalModal && [1, 2, 3].map(n => {
                  const name = finalModal[`vendor${n}_name`];
                  const rate = +finalModal[`vendor${n}_rate`] || 0;
                  if (!name || rate <= 0) return null;
                  const terms = finalModal[`vendor${n}_terms`] || '';
                  const days = +finalModal[`vendor${n}_credit_days`] || 0;
                  const label = `${name} — Rs ${rate}${terms ? ` · ${terms}` : ''}${terms === 'Credit' && days ? ` (${days}d)` : ''}`;
                  return <option key={n} value={name}>{label}</option>;
                })}
              </select>
            </div>
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

      {/* ─── Edit Vendor PO Modal ──────────────────────────────────
          Mam (2026-05-20).  Header-level safe edits only.  Line
          items / vendor swap need their own flow (not shipped yet).
          Total-amount + vendor edits get blocked server-side when
          any Purchase Bill references the PO.  Modal shows that
          context inline so user knows why a field might fail. */}
      {editPo && (
        <Modal isOpen={true} onClose={() => { setEditPo(null); setEditPoForm({}); }} title={`Edit Vendor PO — ${editPo.po_number}`}>
          <form onSubmit={saveEditVendorPo} className="space-y-3 text-sm">
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-gray-700">
              <strong>{editPo.po_number}</strong> · {editPo.vendor_name}
              {editPo.cancelled && <span className="ml-2 text-red-700">· CANCELLED (restore first to edit)</span>}
              <div className="text-[10px] text-gray-500 mt-0.5">
                PO number is immutable.  Total / vendor blocked if any Purchase Bill references this PO — cancel the bill first if needed.
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">PO Date</label>
                <input className="input" type="date"
                       value={editPoForm.po_date || ''}
                       onChange={e => setEditPoForm({ ...editPoForm, po_date: e.target.value })} />
              </div>
              <div>
                <label className="label">Expected Receipt Date</label>
                <input className="input" type="date"
                       value={editPoForm.expected_receipt_date || ''}
                       onChange={e => setEditPoForm({ ...editPoForm, expected_receipt_date: e.target.value })} />
              </div>
              <div>
                <label className="label">Total Amount (₹)</label>
                <input className="input text-right" type="number" step="0.01" min="0"
                       value={editPoForm.total_amount ?? ''}
                       onChange={e => setEditPoForm({ ...editPoForm, total_amount: +e.target.value })} />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Use only to correct typos. If items changed, recreate the PO.
                </p>
              </div>
              <div>
                <label className="label">Advance Required (₹)</label>
                <input className="input text-right" type="number" step="0.01" min="0"
                       value={editPoForm.advance_required ?? ''}
                       onChange={e => setEditPoForm({ ...editPoForm, advance_required: +e.target.value })} />
              </div>
            </div>

            <div>
              <label className="label">Remarks</label>
              <textarea className="input" rows="3"
                        value={editPoForm.remarks || ''}
                        onChange={e => setEditPoForm({ ...editPoForm, remarks: e.target.value })}
                        placeholder="Any notes about this PO — change reason, supplier follow-up, etc." />
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t">
              <button type="button" onClick={() => { setEditPo(null); setEditPoForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={editPoSaving} className="btn btn-primary">
                {editPoSaving ? 'Saving…' : 'Update PO'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
