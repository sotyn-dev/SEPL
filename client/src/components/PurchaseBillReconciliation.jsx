import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiCheckSquare, FiSquare, FiLayers, FiAlertCircle, FiInfo, FiPercent } from 'react-icons/fi';

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export default function PurchaseBillReconciliation({ vendors, initialVendor, initialPo, legacy, onClose, onSaved }) {
  const [freight, setFreight] = useState(legacy?.freight_amount || '');
  const [vendor, setVendor] = useState(String(legacy?.vendor_id || initialVendor || ''));
  const [data, setData] = useState({ pos: [], debits: [] });
  const [loading, setLoading] = useState(!!vendor);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(initialPo ? [+initialPo] : []);
  const [edits, setEdits] = useState({});
  const [debits, setDebits] = useState([]);
  const [number, setNumber] = useState(legacy?.bill_number || '');
  const [date, setDate] = useState(legacy?.bill_date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [totalGstPercent, setTotalGstPercent] = useState('18');

  useEffect(() => {
    let active = true;
    if (vendor) {
      setLoading(true);
      api.get('/procurement/purchase-bills/eligible', { params: { vendor_id: vendor, reconcile_bill_id: legacy?.id } })
        .then(r => {
          if (active) {
            const fetchedData = r.data || { pos: [], debits: [] };
            setData(fetchedData);
            if (initialPo) {
              setSelected(prev => Array.from(new Set([...prev, +initialPo])));
            }
            if (legacy && legacy.amount > 0) {
              setTotalGstPercent(String(round((legacy.gst_amount / legacy.amount) * 100)));
            } else if (fetchedData.pos?.length > 0) {
              const firstGst = fetchedData.pos.find(p => p.gst_pct != null)?.gst_pct;
              if (firstGst != null) setTotalGstPercent(String(firstGst));
            }
          }
        })
        .catch(e => {
          if (active) setError(e.response?.data?.error || 'Cannot load eligible POs for this vendor');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setData({ pos: [], debits: [] });
      setLoading(false);
    }
    return () => { active = false; };
  }, [vendor, legacy?.id, initialPo]);

  const rows = data.pos.filter(p => selected.includes(p.id)).flatMap(p => p.items.map(it => ({ ...it, po: p })));
  const value = (it) => ({
    quantity: edits[it.id]?.quantity ?? it.billable_qty,
    bill_rate: edits[it.id]?.bill_rate ?? it.po_rate
  });
  const lineBasic = (it) => round((+value(it).quantity || 0) * (+value(it).bill_rate || 0));

  // Total Basic Amount across all selected PO lines
  const subtotal = round(rows.reduce((s, it) => s + lineBasic(it), 0));
  // GST calculated directly on the Total Basic Amount
  const gst = round(subtotal * (+totalGstPercent || 0) / 100);
  // Total Invoice Amount = Basic + GST on Total + Freight
  const total = round(subtotal + gst + (+freight || 0));
  const allowedDebits = data.debits.filter(d => selected.includes(d.vendor_po_id));
  const adjustment = round(allowedDebits.filter(d => debits.includes(d.id)).reduce((s, d) => s + d.amount, 0));

  const edit = (id, k, v) => setEdits(old => ({ ...old, [id]: { ...old[id], [k]: v } }));

  const toggleAllPos = () => {
    if (selected.length === data.pos.length) {
      setSelected([]);
    } else {
      setSelected(data.pos.filter(p => !p.reconciliation_required).map(p => p.id));
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (selected.length === 0) {
      return toast.error('Please select at least one Purchase Order (PO) to book this bill against');
    }
    const billableRows = rows.filter(it => +value(it).quantity > 0);
    if (billableRows.length === 0) {
      return toast.error('Please enter bill quantity greater than 0 for at least one item');
    }
    if (!file && !legacy) {
      return toast.error('Please attach the vendor purchase bill file (PDF/Image)');
    }

    setSaving(true);
    setError('');
    try {
      const body = new FormData();
      for (const [k, v] of Object.entries({
        vendor_id: vendor,
        bill_number: number.trim(),
        bill_date: date,
        request_key: key,
        freight_amount: freight || 0
      })) {
        body.append(k, v);
      }
      body.append('items', JSON.stringify(billableRows.map(it => ({
        vendor_po_id: it.po.id,
        vendor_po_item_id: it.id,
        quantity: value(it).quantity,
        bill_rate: value(it).bill_rate,
        gst_percent: +totalGstPercent || 0
      }))));
      body.append('debit_ids', JSON.stringify(allowedDebits.filter(d => debits.includes(d.id)).map(d => d.id)));
      if (file) body.append('file', file);

      const res = await api.post(
        legacy ? `/procurement/purchase-bills/${legacy.id}/reconcile` : '/procurement/purchase-bills',
        body
      );

      toast.success(
        selected.length > 1
          ? `Single Purchase Bill saved against ${selected.length} POs!`
          : 'Purchase bill saved successfully!'
      );
      if (typeof onSaved === 'function') {
        onSaved(res.data);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save purchase bill. Please review quantities and rates.');
    } finally {
      setSaving(false);
    }
  };

  const selectedPos = data.pos.filter(p => selected.includes(p.id));

  return (
    <Modal
      isOpen
      xwide
      title={
        legacy
          ? 'Reconcile Historical Purchase Bill'
          : selected.length > 1
          ? `Upload Single Purchase Bill — Combined Across ${selected.length} POs`
          : 'Upload Purchase Bill — PO Settlement'
      }
      onClose={() => !saving && onClose()}
    >
      <form className="space-y-4" onSubmit={submit}>
        {/* Concept Clarification Banner for Accounts / Aanchal */}
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-3.5 text-xs text-blue-900 flex items-start gap-3 shadow-xs">
          <FiLayers className="w-5 h-5 text-blue-700 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold text-sm text-blue-950 flex items-center gap-2">
              <span>Single Purchase Bill Against Multiple POs (Multi-PO Billing)</span>
              {selected.length > 1 && (
                <span className="bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold">
                  {selected.length} POs Selected
                </span>
              )}
            </div>
            <p className="text-blue-800 leading-relaxed">
              When a vendor sends <strong>one single tax invoice</strong> covering items from different Purchase Orders, select all the corresponding POs below. All selected POs will be settled together under this single invoice, and will automatically clear from the Bill Follow-up screen.
            </p>
          </div>
        </div>

        {legacy && (
          <p className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            <strong>Reconciliation Mode:</strong> Match original invoice totals: Taxable ₹{legacy.amount}, GST ₹{legacy.gst_amount}, Total ₹{legacy.total_amount}. Existing payment records will be preserved.
          </p>
        )}

        {/* Vendor Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-xs font-bold text-gray-700">
            Vendor <span className="text-red-500">*</span>
            <select
              className="input mt-1 w-full font-medium"
              required
              value={vendor}
              disabled={!!legacy}
              onChange={e => {
                setVendor(e.target.value);
                setSelected([]);
                setEdits({});
                setDebits([]);
                setData({ pos: [], debits: [] });
                setError('');
              }}
            >
              <option value="">Select Vendor to view open POs</option>
              {vendors.map(v => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>

          {/* Quick Stats Banner */}
          {vendor && (
            <div className="flex items-center gap-4 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-xs">
              <div>
                <div className="text-gray-400 font-medium">Open Unbilled POs</div>
                <div className="text-base font-bold text-gray-800">{data.pos.length}</div>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <div className="text-gray-400 font-medium">Selected POs</div>
                <div className="text-base font-bold text-blue-700">{selected.length}</div>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <div className="text-gray-400 font-medium">Items to Bill</div>
                <div className="text-base font-bold text-emerald-700">{rows.length}</div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-xs flex items-center gap-2">
            <FiAlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-gray-500 text-xs">
            <div className="animate-spin inline-block w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full mr-2" />
            Loading open purchase orders and pending balances...
          </div>
        ) : (
          <>
            {vendor && data.pos.length === 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-800 flex items-center gap-2">
                <FiInfo className="w-4 h-4 flex-shrink-0 text-amber-600" />
                <span>No open unbilled POs found for this vendor. All POs may already be fully billed.</span>
              </div>
            )}

            {/* Step 1: Select One or Multiple POs */}
            {data.pos.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                    Step 1: Select Purchase Orders Covered by This Invoice ({data.pos.length} Available)
                  </span>
                  {data.pos.length > 1 && (
                    <button
                      type="button"
                      onClick={toggleAllPos}
                      className="text-xs text-blue-700 font-semibold hover:underline flex items-center gap-1"
                    >
                      {selected.length === data.pos.length ? <FiSquare size={13} /> : <FiCheckSquare size={13} />}
                      {selected.length === data.pos.length ? 'Deselect All' : 'Select All POs'}
                    </button>
                  )}
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-52 overflow-y-auto p-1 border border-gray-200 rounded-xl bg-slate-50/50">
                  {data.pos.map(p => {
                    const isChecked = selected.includes(p.id);
                    return (
                      <label
                        key={p.id}
                        className={`p-3 rounded-lg text-xs flex items-start gap-3 cursor-pointer transition-all border ${
                          isChecked
                            ? 'bg-blue-50/90 border-blue-400 shadow-xs ring-1 ring-blue-300'
                            : 'bg-white border-gray-200 hover:border-gray-300 text-gray-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          disabled={p.reconciliation_required}
                          checked={isChecked}
                          onChange={e =>
                            setSelected(old =>
                              e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id)
                            )
                          }
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-bold text-gray-900">{p.po_number}</span>
                            <span className="text-[10px] text-emerald-700 font-black bg-emerald-100/70 px-1.5 py-0.2 rounded">
                              ₹{Math.round(p.pending_value).toLocaleString('en-IN')}
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            {p.items?.length || 0} line item{p.items?.length === 1 ? '' : 's'}
                            {p.indent_site_name ? ` · ${p.indent_site_name}` : ''}
                          </div>
                          {p.reconciliation_required && (
                            <span className="block text-[10px] text-amber-700 mt-1 font-semibold">
                              ⚠️ Historical bill needs reconciliation first.
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 2: Line Item Breakdown from Selected POs */}
            {rows.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-gray-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                    Step 2: Enter Billed Quantities & Rates (Consolidated Across {selectedPos.length} POs)
                  </span>
                  <span className="text-xs text-gray-500">
                    {rows.length} item line{rows.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
                  {rows.map(it => {
                    const v = value(it);
                    const basic = lineBasic(it);
                    const variance = round((+v.bill_rate || 0) - it.po_rate);
                    return (
                      <div
                        key={`${it.po.id}-${it.id}`}
                        className="border border-slate-200 rounded-xl p-3 bg-white shadow-2xs hover:border-slate-300 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-slate-100">
                          <div className="flex items-center gap-2">
                            <span className="bg-blue-600 text-white font-black text-[10px] px-2 py-0.5 rounded-full">
                              {it.po.po_number}
                            </span>
                            <span className="font-bold text-xs text-gray-900 truncate">
                              {it.description}
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-500">
                            Unit: <span className="font-semibold text-gray-700">{it.unit || 'PCS'}</span>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2.5 text-[11px] text-gray-600 bg-slate-50 p-2 rounded-lg">
                          <div>Ordered: <b className="text-gray-900">{it.ordered_qty}</b></div>
                          <div>Received: <b className="text-gray-900">{it.received_qty || 0}</b></div>
                          <div>Prev Billed: <b className="text-gray-900">{it.previously_billed_qty || 0}</b></div>
                          <div>Max Billable: <b className="text-emerald-700">{it.billable_qty}</b></div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 text-xs items-center">
                          <label>
                            <span className="text-gray-600 font-medium">Bill Qty *</span>
                            <input
                              aria-label={`Bill qty ${it.po.po_number} ${it.description}`}
                              className="input mt-1 w-full text-xs font-bold"
                              type="number"
                              min="0"
                              max={it.billable_qty}
                              step="any"
                              value={v.quantity}
                              onChange={e => edit(it.id, 'quantity', e.target.value)}
                            />
                          </label>

                          <label>
                            <span className="text-gray-500 font-medium">PO Rate</span>
                            <input
                              className="input mt-1 w-full text-xs bg-gray-50 text-gray-500 cursor-not-allowed"
                              readOnly
                              value={it.po_rate}
                            />
                          </label>

                          <label>
                            <span className="text-gray-600 font-medium">Bill Rate *</span>
                            <input
                              aria-label={`Bill rate ${it.po.po_number} ${it.description}`}
                              className="input mt-1 w-full text-xs font-bold"
                              required
                              type="number"
                              min="0"
                              step="any"
                              value={v.bill_rate}
                              onChange={e => edit(it.id, 'bill_rate', e.target.value)}
                            />
                          </label>

                          <div>
                            <span className="text-gray-500 font-medium">Rate Diff</span>
                            <div className={`mt-2 font-bold ${variance ? 'text-amber-700' : 'text-gray-400'}`}>
                              ₹{variance}
                            </div>
                          </div>

                          <div className="text-right">
                            <span className="text-gray-500 font-medium">Line Basic</span>
                            <div className="font-extrabold text-sm text-gray-900 mt-1">
                              ₹{basic.toLocaleString('en-IN')}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Optional Debits Allocation */}
            {!!allowedDebits.length && !legacy && (
              <fieldset className="border border-gray-200 rounded-xl p-3 text-xs bg-slate-50/50">
                <legend className="font-bold text-gray-700 px-1">Apply Agreed Debit Adjustment (Optional)</legend>
                <div className="space-y-1.5 mt-1">
                  {allowedDebits.map(d => (
                    <label key={d.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={debits.includes(d.id)}
                        onChange={e =>
                          setDebits(old =>
                            e.target.checked ? [...old, d.id] : old.filter(id => id !== d.id)
                          )
                        }
                      />
                      <span>
                        <b>{d.dn_number}</b> · {d.type} · ₹{Math.round(d.amount).toLocaleString('en-IN')} ({d.reason || 'No reason'})
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {/* Financial Totals Ribbon — GST on Total Basic Amount of All Selected POs */}
            <div className="rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-200 p-4 text-xs shadow-xs space-y-3">
              <div className="flex items-center justify-between border-b border-blue-200/80 pb-2">
                <span className="font-bold text-xs text-blue-950 uppercase tracking-wide flex items-center gap-1.5">
                  <FiPercent className="text-blue-600" />
                  <span>Financial Totals (Consolidated Across {selected.length} Selected POs)</span>
                </span>
                <span className="text-[11px] text-blue-800 font-semibold">
                  GST is applied directly on the Total Basic Amount
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                {/* 1. Total Basic Amount of All Selected POs */}
                <div className="bg-white p-3 rounded-xl border-2 border-blue-300 shadow-2xs">
                  <span className="text-blue-900 font-bold text-[11px] block uppercase tracking-wider">
                    Total Basic Amount
                  </span>
                  <div className="font-black text-lg text-blue-950 mt-1">
                    ₹{subtotal.toLocaleString('en-IN')}
                  </div>
                  <span className="text-[10px] text-gray-500 font-medium">
                    Sum of selected PO lines
                  </span>
                </div>

                {/* 2. GST on Total Basic (EDITABLE HERE DIRECTLY!) */}
                <div className="bg-white p-3 rounded-xl border-2 border-indigo-400 shadow-2xs col-span-2 sm:col-span-1">
                  <div className="flex items-center justify-between">
                    <span className="text-indigo-900 font-bold text-[11px] uppercase tracking-wider">
                      GST on Total Basic
                    </span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="any"
                        value={totalGstPercent}
                        onChange={e => setTotalGstPercent(e.target.value)}
                        className="w-12 text-xs font-black text-indigo-950 border border-indigo-300 rounded px-1 py-0.5 text-center bg-indigo-50/50 outline-none focus:ring-1 focus:ring-indigo-500"
                        aria-label="GST % on total basic"
                      />
                      <span className="font-bold text-indigo-950 text-xs">%</span>
                    </div>
                  </div>
                  <div className="font-black text-lg text-indigo-950 mt-1">
                    ₹{gst.toLocaleString('en-IN')}
                  </div>
                  {/* Quick Rates for Total GST */}
                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    {[0, 5, 12, 18, 28].map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setTotalGstPercent(String(r))}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-black transition cursor-pointer ${
                          Number(totalGstPercent) === r
                            ? 'bg-indigo-600 text-white shadow-xs'
                            : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200'
                        }`}
                      >
                        {r}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3. Invoice Total */}
                <div className="bg-white p-3 rounded-xl border border-blue-200 shadow-2xs">
                  <span className="text-blue-900 font-bold text-[11px] block uppercase tracking-wider">
                    Invoice Total
                  </span>
                  <div className="font-black text-lg text-blue-950 mt-1">
                    ₹{total.toLocaleString('en-IN')}
                  </div>
                  <span className="text-[10px] text-gray-500 font-medium">
                    Basic + GST {freight ? `+ ₹${freight} Frt` : ''}
                  </span>
                </div>

                {/* 4. Debit Adjusted */}
                <div className="bg-white p-3 rounded-xl border border-blue-200 shadow-2xs">
                  <span className="text-amber-800 font-bold text-[11px] block uppercase tracking-wider">
                    Debit Adjusted
                  </span>
                  <div className="font-bold text-lg text-amber-800 mt-1">
                    - ₹{adjustment.toLocaleString('en-IN')}
                  </div>
                  <span className="text-[10px] text-gray-500 font-medium">
                    Agreed debit notes
                  </span>
                </div>

                {/* 5. Net Payable */}
                <div className="bg-emerald-50/80 p-3 rounded-xl border-2 border-emerald-400 shadow-2xs col-span-2 sm:col-span-1">
                  <span className="text-emerald-900 font-black text-[11px] block uppercase tracking-wider">
                    Net Payable
                  </span>
                  <div className="font-black text-xl text-emerald-700 mt-0.5">
                    ₹{Math.max(0, total - adjustment).toLocaleString('en-IN')}
                  </div>
                  <span className="text-[10px] text-emerald-800 font-medium">
                    Final payable balance
                  </span>
                </div>
              </div>
            </div>

            {/* Step 3: Vendor Invoice Details & Attachment */}
            <div className="pt-2 border-t border-gray-100 space-y-3">
              <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                Step 3: Vendor Tax Invoice Details & Proof File
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs font-semibold text-gray-700">
                  Vendor Bill Number <span className="text-red-500">*</span>
                  <input
                    className="input mt-1 w-full font-bold"
                    placeholder="e.g. INV-2026-990"
                    required
                    maxLength={100}
                    readOnly={!!legacy}
                    value={number}
                    onChange={e => setNumber(e.target.value)}
                  />
                </label>

                <label className="text-xs font-semibold text-gray-700">
                  Bill Date <span className="text-red-500">*</span>
                  <input
                    className="input mt-1 w-full font-medium"
                    required
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                  />
                </label>

                <label className="text-xs font-semibold text-gray-700">
                  Freight Amount (₹)
                  <input
                    className="input mt-1 w-full font-medium"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    readOnly={!!legacy}
                    value={freight}
                    onChange={e => setFreight(e.target.value)}
                  />
                </label>
              </div>

              <label className="block text-xs font-semibold text-gray-700">
                Upload Vendor Bill File (PDF / Image) {!legacy && <span className="text-red-500">*</span>}
                <input
                  className="input mt-1 w-full text-xs"
                  type="file"
                  required={!legacy}
                  accept=".pdf,.jpg,.jpeg,.png,.xlsx"
                  onChange={e => setFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            {/* Submit Action */}
            <button
              type="submit"
              disabled={saving || loading || selected.length === 0 || !rows.some(it => +value(it).quantity > 0)}
              className="btn btn-primary w-full py-2.5 text-sm font-bold shadow-md hover:shadow-lg transition-all"
            >
              {saving
                ? 'Saving Bill & Settling POs...'
                : legacy
                ? 'Save Item Reconciliation'
                : selected.length > 1
                ? `Save Single Purchase Bill for ${selected.length} Selected POs`
                : 'Save Purchase Bill'}
            </button>
          </>
        )}
      </form>
    </Modal>
  );
}
