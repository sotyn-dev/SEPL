// FMS — Flow Monitoring Sheet → COCKPIT (mam 2026-07-25): ek hi dashboard se
// poora flow CONTROL hota hai, sirf monitor nahi. Design = "sheet hi cockpit":
//   • One-click gates (L1/CRM approve-reject, PO approve, Payment clear) ka
//     button CELL KE ANDAR hi hai — spreadsheet jaisa, koi popup/drawer nahi.
//   • Form-wale kaam (3-vendor rates + slip evidence) cell click pe usi row ke
//     NEECHE expansion row mein khulte hain — sheet ke andar hi form, indent
//     ka poora trail upar dikhta rehta hai.
//   • "Mera Kaam" filter — sirf wo rows jinka current step logged-in user ke
//     naam pe hai. Roz subah ki to-do list khud ban jaati hai.
// Baaki stages (PO banana, dispatch, receive, bills — bhaari file-forms) abhi
// deep-link se apne tab pe le jaate hain; wo agla phase hai.
// Header = main numbers · worst-late top · 60s auto-refresh · sab local.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

function fmtDur(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h * 10) / 10}h`;
  const d = Math.floor(h / 24); const rem = Math.round(h - d * 24);
  return rem ? `${d}d ${rem}h` : `${d}d`;
}
const inr = (n) => '₹' + Math.round(+n || 0).toLocaleString('en-IN');

// Stages whose WORK still lives in its Procurement tab (heavy forms) — cell
// click deep-links there, pre-filtered. Everything else acts inline.
const STAGE_LINK = {
  raised:      { tab: 'indents' },
  po_created:  { tab: 'vendorpo', subtab: 'pending' },
  dispatch:    { tab: 'delivery', subtab: 'ready' },
  received:    { tab: 'delivery', subtab: 'list' },
  pbill:       { tab: 'bills', subtab: 'followup' },
  sbill:       { tab: 'delivery', subtab: 'list' },
};

const tsMs = (s) => {
  if (!s) return null;
  let str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T') + 'Z';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00Z';
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
};

// ─── Inline 3-vendor rates workbench — the expansion row's content ─────────
// Same rules as the Vendor Rates tab, compact: slip evidence unlocks a slot
// (server enforces), lowest rate = L1, one-click "Order L1" finalizes.
function RatesWorkbench({ row, onDone }) {
  const [items, setItems] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ir, vq] = await Promise.all([
        api.get('/procurement/item-rates'),
        api.get(`/procurement/vendor-quotes?indent_id=${row.id}`),
      ]);
      setItems((ir.data || []).filter(r => r.indent_id === row.id));
      setQuotes(vq.data || []);
    } catch { toast.error('Rates load nahi hue'); }
  }, [row.id]);
  useEffect(() => { load(); }, [load]);

  const quoteFor = (slot) => quotes.find(q => q.vendor_slot === slot) || null;

  const uploadSlip = async (slot, file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file); fd.append('indent_id', row.id); fd.append('vendor_slot', slot);
    const t = toast.loading('Slip upload… AI padh raha hai');
    try {
      const { data } = await api.post('/procurement/vendor-quotes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.dismiss(t);
      toast.success(data.ai_status === 'parsed' ? `✓ AI ne ${data.ai_filled} rate bhar diye` : 'Slip attached ✓ — ab rate bharein');
      load();
    } catch (e) { toast.dismiss(t); toast.error(e.response?.data?.error || 'Upload failed'); }
  };

  const saveRate = async (it, slot, patch) => {
    try {
      await api.post('/procurement/item-rates', { indent_item_id: it.indent_item_id, ...patch });
      setItems(prev => prev.map(x => x.indent_item_id === it.indent_item_id ? { ...x, ...patch } : x));
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); load(); }
  };

  const orderL1 = async (it) => {
    const qs = [1, 2, 3].map(n => ({ name: it[`vendor${n}_name`], rate: +it[`vendor${n}_rate`] || 0, terms: it[`vendor${n}_terms`] || '', days: +it[`vendor${n}_credit_days`] || 0 }))
      .filter(v => v.name && v.rate > 0).sort((a, b) => a.rate - b.rate);
    if (qs.length < 3) return toast.error('Pehle teeno vendor ke naam + rate bharein');
    const l1 = qs[0];
    setBusy(true);
    try {
      // Refresh rate_id if the row was created after this list loaded
      let rid = it.rate_id;
      if (!rid) { const ir = await api.get('/procurement/item-rates'); rid = (ir.data || []).find(x => x.indent_item_id === it.indent_item_id)?.rate_id; }
      await api.post(`/procurement/item-rates/${rid}/finalize`, { final_vendor_name: l1.name, final_rate: l1.rate, final_terms: l1.terms, final_credit_days: l1.days });
      toast.success(`✓ L1 order: ${l1.name} @ ₹${l1.rate}`);
      await load(); onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'Finalize failed'); }
    finally { setBusy(false); }
  };

  if (!items) return <div className="p-3 text-center text-gray-400 text-xs">Loading rates…</div>;
  if (items.length === 0) return <div className="p-3 text-center text-gray-400 text-xs">Is indent ke items abhi rates list mein nahi aaye (approval check karein).</div>;

  return (
    <div className="space-y-1.5 p-2">
      <div className="flex items-center gap-3 text-[10px] text-gray-500">
        <span className="font-bold text-gray-700">3-Vendor Rates — {row.indent_number}</span>
        <span>📎 slip pehle → rate unlock → sabse sasta = L1 → ✓ Order L1</span>
      </div>
      {items.map(it => {
        const filled = [1, 2, 3].map(n => +it[`vendor${n}_rate`] || 0).filter(v => v > 0);
        const lowest = filled.length ? Math.min(...filled) : 0;
        const done = (it.rate_status || '') === 'finalized';
        return (
          <div key={it.indent_item_id} className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 ${done ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-200'}`}>
            <div className="min-w-[160px] flex-1">
              <div className="text-[11px] font-semibold text-gray-800 leading-tight">{it.master_name || it.description}</div>
              <div className="text-[9px] text-gray-500">{it.qty} {it.unit}{it.marketing_rate > 0 ? ` · AI mkt ₹${it.marketing_rate}` : ''}</div>
            </div>
            {done ? (
              <div className="text-[11px] font-semibold text-emerald-700">✓ Final: {it.final_vendor_name} @ ₹{it.final_rate}</div>
            ) : (
              <>
                {[1, 2, 3].map(n => {
                  const q = quoteFor(n);
                  const rate = +it[`vendor${n}_rate`] || 0;
                  const isL1 = rate > 0 && filled.length >= 2 && rate === lowest;
                  return (
                    <div key={n} className={`flex items-center gap-1 rounded border px-1.5 py-1 ${isL1 ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                      <span className="text-[9px] font-bold text-gray-400">V{n}</span>
                      {q ? (
                        <a href={q.url} target="_blank" rel="noreferrer" className="text-emerald-600 text-[11px]" title={q.original_name || 'slip'}>📎</a>
                      ) : (
                        <label className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 cursor-pointer" title={`Vendor ${n} ka slip upload — tabhi unlock`}>
                          📎<input type="file" accept="image/*,.pdf" className="hidden" onChange={e => { uploadSlip(n, e.target.files?.[0]); e.target.value = ''; }} />
                        </label>
                      )}
                      <input className="input text-[10px] px-1 py-0.5 w-[74px]" placeholder={q ? 'vendor' : '🔒'} disabled={!q}
                        defaultValue={it[`vendor${n}_name`] || ''}
                        onBlur={e => { const v = e.target.value.trim(); if (v !== (it[`vendor${n}_name`] || '')) saveRate(it, n, { [`vendor${n}_name`]: v }); }} />
                      <input className={`input text-[10px] px-1 py-0.5 w-[60px] text-right ${isL1 ? 'border-emerald-400' : ''}`} type="number" placeholder={q ? '₹' : '🔒'} disabled={!q}
                        defaultValue={rate || ''}
                        onBlur={e => { const v = +e.target.value || 0; if (v !== rate) saveRate(it, n, { [`vendor${n}_rate`]: v }); }} />
                      {isL1 && <span className="text-[8px] font-bold text-emerald-700">L1</span>}
                    </div>
                  );
                })}
                <button onClick={() => orderL1(it)} disabled={busy || filled.length < 3}
                  className="btn btn-primary text-[10px] px-2 py-1 disabled:opacity-40"
                  title={filled.length < 3 ? 'Teeno rate bharo pehle' : 'Sabse saste vendor pe finalize'}>
                  ✓ Order L1
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PO Create workbench — finalized items → one-click PO per vendor ───────
function PoCreateWorkbench({ row, onDone }) {
  const [groups, setGroups] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [ir, v] = await Promise.all([api.get('/procurement/item-rates'), api.get('/vendors')]);
        const mine = (ir.data || []).filter(r => r.indent_id === row.id && (r.rate_status || '') === 'finalized');
        const g = {};
        for (const it of mine) (g[it.final_vendor_name] = g[it.final_vendor_name] || []).push(it);
        setGroups(g); setVendors(v.data || []);
      } catch { toast.error('Load failed'); }
    })();
  }, [row.id]);

  const makePo = async (vendorName, items) => {
    const vend = vendors.find(v => String(v.name).trim().toLowerCase() === String(vendorName).trim().toLowerCase());
    if (!vend) return toast.error(`"${vendorName}" Vendor Master mein nahi mila — pehle Vendors tab mein add karein`);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('vendor_id', vend.id);
      fd.append('indent_id', row.id);
      fd.append('po_date', new Date().toISOString().slice(0, 10));
      fd.append('payment_terms', items[0]?.final_terms || '');
      fd.append('items', JSON.stringify(items.map(it => ({
        indent_item_id: it.indent_item_id, description: it.master_name || it.description,
        quantity: +it.qty, unit: it.unit, rate: +it.final_rate,
      }))));
      const { data } = await api.post('/procurement/vendor-po', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`✓ PO ban gaya: ${data.po_number || ''} — ab L1 approval pe jayega`);
      onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'PO create failed'); }
    finally { setBusy(false); }
  };

  if (!groups) return <div className="p-3 text-center text-gray-400 text-xs">Loading…</div>;
  const names = Object.keys(groups);
  if (!names.length) return <div className="p-3 text-center text-gray-400 text-xs">Koi finalized item nahi mila — pehle rates finalize karein.</div>;
  return (
    <div className="p-2 space-y-1.5">
      <div className="text-[10px] text-gray-500"><b className="text-gray-700">PO banao — {row.indent_number}</b> · finalized items vendor-wise; ek click = PO ban ke L1 approval pe</div>
      {names.map(n => {
        const items = groups[n];
        const total = items.reduce((s, it) => s + (+it.qty * +it.final_rate), 0);
        return (
          <div key={n} className="flex flex-wrap items-center justify-between gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
            <div className="text-[11px]">
              <span className="font-semibold text-gray-800">{n}</span>
              <span className="text-gray-500"> — {items.length} item{items.length > 1 ? 's' : ''} · {inr(total)}</span>
              <div className="text-[9px] text-gray-400 truncate max-w-[420px]">{items.map(it => `${it.master_name || it.description} ×${it.qty} @₹${it.final_rate}`).join(' · ')}</div>
            </div>
            <button disabled={busy} onClick={() => makePo(n, items)} className="btn btn-primary text-[10px] px-2 py-1 disabled:opacity-40">📄 PO banao</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Receive workbench — naam + proof photo, per pending delivery note ─────
function ReceiveWorkbench({ row, onDone }) {
  const [forms, setForms] = useState({});
  const [busy, setBusy] = useState(false);
  const pend = (row.dns || []).filter(d => d.type !== 'sales_bill' && !d.received_at);
  const set = (id, k, v) => setForms(f => ({ ...f, [id]: { ...f[id], [k]: v } }));

  const receive = async (dn) => {
    const f = forms[dn.id] || {};
    if (!f.name?.trim()) return toast.error('Received-by naam likhein');
    if (!f.file) return toast.error('Signed/stamped receipt ki photo attach karein');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('received_by_name', f.name.trim());
      fd.append('file', f.file);
      await api.patch(`/procurement/delivery-notes/${dn.id}/receive`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`✓ ${dn.doc_number || 'DN'} received — items site ke stock mein IN ho gaye`);
      onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'Receive failed'); }
    finally { setBusy(false); }
  };

  if (!pend.length) return <div className="p-3 text-center text-gray-400 text-xs">Koi pending delivery note nahi.</div>;
  return (
    <div className="p-2 space-y-1.5">
      <div className="text-[10px] text-gray-500"><b className="text-gray-700">Receive karo — {row.indent_number}</b> · naam + signed receipt photo; save hote hi site-stock mein auto-IN</div>
      {pend.map(dn => (
        <div key={dn.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
          <span className="text-[11px] font-semibold text-gray-800">{dn.doc_number || `DN #${dn.id}`}</span>
          {dn.po_number && <span className="text-[9px] text-gray-400">{dn.po_number}</span>}
          <input className="input text-[10px] px-1.5 py-0.5 w-[150px]" placeholder="Received by (naam)"
            value={forms[dn.id]?.name || ''} onChange={e => set(dn.id, 'name', e.target.value)} />
          <label className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 cursor-pointer">
            {forms[dn.id]?.file ? '📎 ' + forms[dn.id].file.name.slice(0, 18) : '📎 receipt photo'}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={e => set(dn.id, 'file', e.target.files?.[0])} />
          </label>
          <button disabled={busy} onClick={() => receive(dn)} className="btn btn-primary text-[10px] px-2 py-1 disabled:opacity-40">✓ Received</button>
        </div>
      ))}
    </div>
  );
}

// ─── Purchase Bill workbench — bill entry per unbilled PO ──────────────────
function BillWorkbench({ row, onDone }) {
  const [forms, setForms] = useState({});
  const [busy, setBusy] = useState(false);
  const pend = (row.pos || []).filter(p => !+p.bills);
  const set = (id, k, v) => setForms(f => ({ ...f, [id]: { ...f[id], [k]: v } }));

  const save = async (po) => {
    const f = forms[po.id] || {};
    if (!f.bill_number?.trim()) return toast.error('Bill number likhein');
    if (!f.file) return toast.error('Vendor bill ki photo/PDF attach karein');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('vendor_po_id', po.id);
      fd.append('bill_number', f.bill_number.trim());
      fd.append('bill_date', f.bill_date || new Date().toISOString().slice(0, 10));
      fd.append('amount', +f.amount || +po.amount || 0);
      fd.append('gst_amount', +f.gst || 0);
      fd.append('total_amount', (+f.amount || +po.amount || 0) + (+f.gst || 0));
      fd.append('file', f.file);
      await api.post('/procurement/purchase-bills', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`✓ Bill ${f.bill_number} entered — ${po.po_number}`);
      onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'Bill save failed'); }
    finally { setBusy(false); }
  };

  if (!pend.length) return <div className="p-3 text-center text-gray-400 text-xs">Sab POs ke bill enter ho chuke.</div>;
  return (
    <div className="p-2 space-y-1.5">
      <div className="text-[10px] text-gray-500"><b className="text-gray-700">Purchase Bill entry — {row.indent_number}</b> · bill no + amount + bill ki photo/PDF</div>
      {pend.map(po => (
        <div key={po.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
          <span className="text-[11px] font-semibold text-gray-800">{po.po_number}</span>
          <span className="text-[9px] text-gray-400">{inr(po.amount)}</span>
          <input className="input text-[10px] px-1.5 py-0.5 w-[110px]" placeholder="Bill no"
            value={forms[po.id]?.bill_number || ''} onChange={e => set(po.id, 'bill_number', e.target.value)} />
          <input className="input text-[10px] px-1.5 py-0.5 w-[112px]" type="date"
            value={forms[po.id]?.bill_date || new Date().toISOString().slice(0, 10)} onChange={e => set(po.id, 'bill_date', e.target.value)} />
          <input className="input text-[10px] px-1.5 py-0.5 w-[90px] text-right" type="number" placeholder={`₹ ${Math.round(po.amount)}`}
            value={forms[po.id]?.amount || ''} onChange={e => set(po.id, 'amount', e.target.value)} />
          <input className="input text-[10px] px-1.5 py-0.5 w-[70px] text-right" type="number" placeholder="GST ₹"
            value={forms[po.id]?.gst || ''} onChange={e => set(po.id, 'gst', e.target.value)} />
          <label className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 cursor-pointer">
            {forms[po.id]?.file ? '📎 ' + forms[po.id].file.name.slice(0, 18) : '📎 bill file'}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={e => set(po.id, 'file', e.target.files?.[0])} />
          </label>
          <button disabled={busy} onClick={() => save(po)} className="btn btn-primary text-[10px] px-2 py-1 disabled:opacity-40">✓ Bill Save</button>
        </div>
      ))}
    </div>
  );
}

// ─── Sales Bill workbench — generate (one-click) ya upload per challan ─────
function SbillWorkbench({ row, onDone }) {
  const [forms, setForms] = useState({});
  const [busy, setBusy] = useState(false);
  const challans = (row.dns || []).filter(d => d.type !== 'sales_bill' && !d.sb_number);
  const set = (id, k, v) => setForms(f => ({ ...f, [id]: { ...f[id], [k]: v } }));

  const generate = async (dn) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/procurement/delivery-notes/${dn.id}/generate-sales-bill`);
      toast.success(`✓ Sales Bill ${data.document_number} ban gaya${data.is_draft ? ' (DRAFT — rate/GSTIN check karke bhejein)' : ''}`);
      onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'Generate failed'); }
    finally { setBusy(false); }
  };
  const upload = async (dn) => {
    const f = forms[dn.id] || {};
    if (!f.number?.trim()) return toast.error('Sales Bill number likhein');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('sales_bill_number', f.number.trim());
      if (f.file) fd.append('file', f.file);
      await api.post(`/procurement/delivery-notes/${dn.id}/sales-bill`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`✓ Sales Bill ${f.number} attached`);
      onDone();
    } catch (e) { toast.error(e.response?.data?.error || 'Upload failed'); }
    finally { setBusy(false); }
  };

  if (!challans.length) return <div className="p-3 text-center text-gray-400 text-xs">Sab challans pe Sales Bill ho chuka (ya koi challan nahi).</div>;
  return (
    <div className="p-2 space-y-1.5">
      <div className="text-[10px] text-gray-500"><b className="text-gray-700">Sales Bill — {row.indent_number}</b> · ⚡ system se generate karo, ya bana-banaya upload karo</div>
      {challans.map(dn => (
        <div key={dn.id} className="flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
          <span className="text-[11px] font-semibold text-gray-800">{dn.doc_number || `DN #${dn.id}`}</span>
          <button disabled={busy} onClick={() => generate(dn)} className="btn btn-primary text-[10px] px-2 py-1 disabled:opacity-40">⚡ Generate SB</button>
          {!!dn.sb_pending && (
            <>
              <span className="text-[9px] text-gray-400">ya upload:</span>
              <input className="input text-[10px] px-1.5 py-0.5 w-[110px]" placeholder="SB number"
                value={forms[dn.id]?.number || ''} onChange={e => set(dn.id, 'number', e.target.value)} />
              <label className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300 cursor-pointer">
                {forms[dn.id]?.file ? '📎 ' + forms[dn.id].file.name.slice(0, 18) : '📎 SB file'}
                <input type="file" accept="image/*,.pdf" className="hidden" onChange={e => set(dn.id, 'file', e.target.files?.[0])} />
              </label>
              <button disabled={busy} onClick={() => upload(dn)} className="btn btn-secondary text-[10px] px-2 py-1 disabled:opacity-40">✓ Attach</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default function FlowMonitor() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('pending');
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [expanded, setExpanded] = useState(null);   // indent id with open workbench
  const [acting, setActing] = useState({});          // {`${rowId}:${action}`: true}
  const navigate = useNavigate();
  const timer = useRef(null);
  const { user } = useAuth();

  const load = useCallback(async () => {
    try {
      const r = await api.get('/procurement/flow-monitor');
      setData(r.data); setErr(null);
    } catch (e) { setErr(e.response?.data?.error || 'Load failed'); }
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 60000);
    return () => clearInterval(timer.current);
  }, [load]);

  const stages = data?.stages || [];
  const kp = data?.kpis;
  const ownerOf = (key) => stages.find(s => s.key === key)?.owner || null;
  const isMine = (r) => {
    if (!r.current_key || !user?.name) return false;
    const owner = ownerOf(r.current_key);
    // Raised-stage kaam raiser ke paas hota hai
    const eff = owner || (r.current_key === 'raised' ? r.raised_by_name : null);
    return !!eff && eff.toLowerCase().includes(user.name.toLowerCase().split(' ')[0]);
  };

  const src = view === 'pending' ? (data?.pending || []) : (data?.completed || []);
  const rows = src.filter(r => {
    if (mineOnly && !isMine(r)) return false;
    if (stageFilter && r.current_key !== stageFilter) return false;
    if (!q.trim()) return true;
    return `${r.indent_number} ${r.site_name || ''} ${r.raised_by_name || ''}`.toLowerCase().includes(q.trim().toLowerCase());
  });
  const myCount = (data?.pending || []).filter(isMine).length;

  const jump = (row, stageKey) => {
    const link = STAGE_LINK[stageKey] || { tab: 'indents' };
    const sp = new URLSearchParams({ tab: link.tab, q: row.indent_number });
    if (link.subtab) sp.set('subtab', link.subtab);
    navigate(`/procurement?${sp.toString()}`);
  };

  // ── Inline one-click actions (cell ke andar) ──
  const doAct = async (key, fn, okMsg) => {
    setActing(a => ({ ...a, [key]: true }));
    try { await fn(); toast.success(okMsg); await load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Action failed'); }
    finally { setActing(a => ({ ...a, [key]: false })); }
  };
  const approveIndent = (row) => {
    if (!window.confirm(`${row.indent_number} APPROVE karein?`)) return;
    doAct(`${row.id}:ap`, () => api.put(`/procurement/indents/${row.id}`, { status: 'approved' }), `✓ ${row.indent_number} approved`);
  };
  const rejectIndent = (row) => {
    const reason = window.prompt(`${row.indent_number} REJECT — reason likhein (zaroori):`);
    if (!reason || !reason.trim()) return;
    doAct(`${row.id}:rj`, () => api.put(`/procurement/indents/${row.id}`, { status: 'rejected', reason: reason.trim() }), `${row.indent_number} rejected`);
  };
  const approvePo = (row, po) => {
    if (!window.confirm(`PO ${po.po_number} approve karein?`)) return;
    doAct(`${row.id}:po${po.id}`, () => api.post(`/procurement/vendor-po/${po.id}/po-approve`), `✓ ${po.po_number} approved`);
  };
  const clearPayment = (row, po) => {
    if (!window.confirm(`PO ${po.po_number} ka payment CLEAR mark karein? (${inr(po.amount)})`)) return;
    doAct(`${row.id}:pay${po.id}`, () => api.patch(`/procurement/vendor-po/${po.id}/clear-payment`), `✓ Payment cleared — vendor ko bolo dispatch kare`);
  };

  // The current-stage cell — buttons INSIDE the cell, spreadsheet-style.
  const CurrentCell = ({ row, stage }) => {
    const late = row.late_hours > 0;
    const base = late ? 'bg-rose-100 border-rose-200' : 'bg-amber-50 border-amber-100';
    const timeLine = (
      <div className={`text-[10px] font-bold leading-tight ${late ? 'text-rose-700' : 'text-amber-700'}`}>
        {late ? `⚠ ${fmtDur(row.late_hours)} late` : `● ${fmtDur(row.elapsed_hours)}`}
      </div>
    );
    // l1 / crm — approval gates: ✅❌ inline
    if (stage.key === 'l1' || stage.key === 'crm') {
      return (
        <td className={`border-l px-1 py-1 text-center ${base}`}>
          {timeLine}
          <div className="flex items-center justify-center gap-1 mt-0.5">
            <button disabled={acting[`${row.id}:ap`]} onClick={() => approveIndent(row)}
              className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40" title="Approve — one click">✅</button>
            <button disabled={acting[`${row.id}:rj`]} onClick={() => rejectIndent(row)}
              className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40" title="Reject (reason ke saath)">❌</button>
          </div>
          <div className={`text-[8px] leading-tight ${late ? 'text-rose-600' : 'text-amber-600'}`}>{stage.owner || ''}</div>
        </td>
      );
    }
    // Workbench stages — form ussi row ke neeche khulta hai (Phase C: rates
    // ke saath PO create, receive, purchase bill, sales bill bhi inline).
    const WB_LABEL = { rates: '▼ rates bharo', po_created: '▼ PO banao', received: '▼ receive karo', pbill: '▼ bill entry', sbill: '▼ sales bill' };
    if (WB_LABEL[stage.key]) {
      const open = expanded === row.id;
      return (
        <td className={`border-l px-1 py-1 text-center ${base}`}>
          {timeLine}
          <button onClick={() => setExpanded(open ? null : row.id)}
            className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 mt-0.5"
            title="Yahin, isi screen pe — row ke neeche form khulega">
            {open ? '▲ band' : WB_LABEL[stage.key]}
          </button>
          <div className={`text-[8px] leading-tight ${late ? 'text-rose-600' : 'text-amber-600'}`}>{stage.owner || ''}</div>
        </td>
      );
    }
    // po_approved — per pending PO ✅
    if (stage.key === 'po_approved') {
      const pend = (row.pos || []).filter(p => p.approval === 'pending_l1' || p.approval === 'pending_l2');
      return (
        <td className={`border-l px-1 py-1 text-center ${base}`}>
          {timeLine}
          {pend.slice(0, 2).map(p => (
            <button key={p.id} disabled={acting[`${row.id}:po${p.id}`]} onClick={() => approvePo(row, p)}
              className="block mx-auto mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              title={`${p.po_number} · ${p.approval === 'pending_l1' ? 'L1' : 'L2'} approve`}>
              ✅ {p.approval === 'pending_l1' ? 'L1' : 'L2'}
            </button>
          ))}
          {pend.length === 0 && <div className="text-[8px] text-gray-500">PO pending nahi</div>}
        </td>
      );
    }
    // payment — per blocked PO ✓ Clear
    if (stage.key === 'payment') {
      const blocked = (row.pos || []).filter(p => p.block === 'pending');
      return (
        <td className={`border-l px-1 py-1 text-center ${base}`}>
          {timeLine}
          {blocked.slice(0, 2).map(p => (
            <button key={p.id} disabled={acting[`${row.id}:pay${p.id}`]} onClick={() => clearPayment(row, p)}
              className="block mx-auto mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              title={`${p.po_number} payment clear karo (${inr(p.amount)})`}>
              ✓ Clear
            </button>
          ))}
          {blocked.length === 0 && <div className="text-[8px] text-gray-500">koi hold nahi</div>}
          <div className={`text-[8px] leading-tight ${late ? 'text-rose-600' : 'text-amber-600'}`}>{stage.owner || ''}</div>
        </td>
      );
    }
    // heavy-form stages — deep link (agla phase: inline forms)
    return (
      <td className={`border-l p-0 ${base}`}>
        <button type="button" onClick={() => jump(row, stage.key)} className="w-full h-full px-1 py-1 text-center cursor-pointer"
          title={`${stage.label} — ${fmtDur(row.elapsed_hours)} se chal raha${stage.owner ? ' · ' + stage.owner : ''} — click: us kaam pe jao`}>
          {timeLine}
          <div className={`text-[9px] leading-tight truncate max-w-[86px] mx-auto ${late ? 'text-rose-600' : 'text-amber-600'}`}>{stage.owner || '—'} →</div>
        </button>
      </td>
    );
  };

  const cellFor = (row, idx) => {
    const s = stages[idx];
    const at = tsMs(row.stamps[s.key]);
    if (at) {
      let prev = null;
      for (let i = idx - 1; i >= 0; i--) { prev = tsMs(row.stamps[stages[i].key]); if (prev != null) break; }
      const took = prev != null ? Math.max(0, (at - prev) / 3600000) : null;
      return (
        <td key={s.key} className="border-l border-gray-100 px-1 py-1 text-center bg-emerald-50" title={`${s.label} — done · ${fmtDur(took)} laga`}>
          <span className="text-emerald-700 font-bold text-xs">✓</span>
          <div className="text-[9px] text-emerald-700/80 leading-tight">{fmtDur(took)}</div>
        </td>
      );
    }
    if (row.current_key === s.key && view === 'pending') return <CurrentCell key={s.key} row={row} stage={s} />;
    return <td key={s.key} className="border-l border-gray-100 px-1 py-1 text-center text-gray-300 text-[10px]">·</td>;
  };

  const tile = (label, big, sub, tone) => (
    <div className={`rounded-lg border px-3 py-2 min-w-[130px] ${tone}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70 truncate">{label}</div>
      <div className="text-xl font-bold leading-tight">{big}</div>
      {sub && <div className="text-[10px] leading-tight opacity-80 truncate">{sub}</div>}
    </div>
  );
  const worstStageLabel = kp?.worst ? (stages.find(s => s.key === kp.worst.stage)?.label || kp.worst.stage) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Flow Monitor — Indent → Sales Bill</h2>
          <p className="text-[11px] text-gray-500">Ek hi screen se dekho AUR karo — ✅❌ cell ke andar, rates row ke neeche. Auto-refresh 60s{data ? ` · updated ${new Date(data.generated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setMineOnly(m => !m)}
            className={`text-xs font-semibold rounded-lg border px-3 h-8 ${mineOnly ? 'bg-indigo-600 text-white border-indigo-700' : 'bg-white text-indigo-700 border-indigo-300'}`}
            title="Sirf wo kaam jinka current step aapke naam pe hai">
            👤 Mera Kaam ({myCount})
          </button>
          <input className="input text-xs h-8 w-40" placeholder="Search indent / site…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs">
            <button onClick={() => { setView('pending'); setStageFilter(null); }} className={`px-3 py-1.5 ${view === 'pending' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Pending ({data?.pending?.length ?? '…'})</button>
            <button onClick={() => { setView('completed'); setStageFilter(null); }} className={`px-3 py-1.5 ${view === 'completed' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Completed ({data?.completed?.length ?? '…'})</button>
          </div>
          <button onClick={load} className="btn btn-secondary h-8 text-xs" title="Refresh now">↻</button>
        </div>
      </div>

      {err && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}

      {kp && (
        <div className="flex flex-wrap gap-2">
          {tile('🔴 Stuck (late)', kp.stuck,
            kp.worst ? `worst: ${kp.worst.indent_number} · ${worstStageLabel} · ${fmtDur(kp.worst.late_hours)} late` : 'sab target ke andar ✓',
            kp.stuck > 0 ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-emerald-300 bg-emerald-50 text-emerald-700')}
          {tile('In flight', kp.in_flight, `${inr(kp.pipeline_value)} PO value pipeline mein`, 'border-blue-300 bg-blue-50 text-blue-700')}
          {tile('Is hafte complete', kp.week.completed, kp.week.avg_tat_days != null ? `avg TAT ${kp.week.avg_tat_days} din` : 'koi complete nahi', 'border-indigo-300 bg-indigo-50 text-indigo-700')}
          {tile('L1 discipline', kp.l1.finalized ? `${Math.round((kp.l1.at_l1 / kp.l1.finalized) * 100)}%` : '—',
            kp.l1.finalized ? `${kp.l1.at_l1}/${kp.l1.finalized} L1 pe · extra diya ${inr(kp.l1.extra_paid)}` : 'abhi koi rate finalize nahi',
            'border-amber-300 bg-amber-50 text-amber-700')}
          {tile('Bachaya (vs highest quote)', inr(kp.l1.saved_vs_highest), '3-vendor comparison ka fayda', 'border-emerald-300 bg-emerald-50 text-emerald-700')}
        </div>
      )}

      {kp && view === 'pending' && (
        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
          {stages.map((s, i) => {
            const p = kp.pileup[s.key] || { count: 0, late: 0, value: 0 };
            const active = stageFilter === s.key;
            const tone = p.late > 0 ? 'border-rose-300 bg-rose-50' : p.count > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white';
            return (
              <div key={s.key} className="flex items-center shrink-0">
                <button onClick={() => setStageFilter(active ? null : s.key)}
                  className={`rounded-lg border px-2 py-1 text-left min-w-[86px] transition ${tone} ${active ? 'ring-2 ring-indigo-400' : 'hover:shadow-sm'}`}
                  title={`${p.count} yahan atke${p.late ? `, ${p.late} late` : ''}${p.value ? ` · ${inr(p.value)}` : ''}${s.owner ? ` · ${s.owner}` : ''}`}>
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-500 leading-tight truncate max-w-[104px]">{s.label}</div>
                  <div className="flex items-baseline gap-1">
                    <span className={`text-base font-bold leading-none ${p.late > 0 ? 'text-rose-600' : p.count > 0 ? 'text-amber-600' : 'text-gray-300'}`}>{p.count}</span>
                    {p.late > 0 && <span className="text-[9px] font-bold text-rose-600">{p.late} late</span>}
                  </div>
                  <div className="text-[9px] text-gray-500 leading-tight truncate max-w-[104px]">{s.owner || '—'}{s.sla_hours != null ? ` · ${fmtDur(s.sla_hours)}` : ''}</div>
                </button>
                {i < stages.length - 1 && <span className="text-gray-300 mx-0.5">→</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="overflow-x-auto border rounded-lg bg-white">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide sticky top-0 z-10">
            <tr>
              <th className="text-left p-2 min-w-[150px]">Indent</th>
              {stages.map(s => (
                <th key={s.key} className="p-1.5 border-l border-gray-100 min-w-[90px] text-center">
                  <div className="text-[9px] leading-tight">{s.label}</div>
                  <div className="text-[9px] font-normal normal-case text-gray-400 leading-tight truncate max-w-[104px] mx-auto">
                    {s.owner || '—'}{s.sla_hours != null ? ` · ${fmtDur(s.sla_hours)}` : ''}
                  </div>
                </th>
              ))}
              {view === 'completed' && <th className="p-1.5 border-l border-gray-100 text-center text-[9px]">Done on</th>}
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={2 + stages.length} className="text-center p-10 text-gray-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={2 + stages.length} className="text-center p-10 text-gray-400">
                {mineOnly ? '✅ Aapke naam pe koi pending kaam nahi!' : view === 'pending' ? '✅ Koi pending kaam nahi — sab flow complete!' : 'Abhi koi completed indent nahi.'}
              </td></tr>
            ) : rows.map(r => {
              const done = () => { setExpanded(null); load(); };
              const WB = { rates: RatesWorkbench, po_created: PoCreateWorkbench, received: ReceiveWorkbench, pbill: BillWorkbench, sbill: SbillWorkbench }[r.current_key];
              return (
                <FragmentRow key={r.id} r={r} stages={stages} view={view} cellFor={cellFor}
                  expanded={expanded === r.id && !!WB}
                  workbench={WB ? <WB row={r} onDone={done} /> : null} />
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-gray-400">
        Legend: <span className="text-emerald-600 font-semibold">✓ done</span> · <span className="text-amber-600 font-semibold">● chal raha</span> · <span className="text-rose-600 font-semibold">⚠ late</span> · ✅❌ = wahin approve/reject · "▼ rates bharo" = row ke neeche hi 3-vendor form · ✓ Clear = payment unblock · baaki cells click = us tab pe (filtered).
      </p>
    </div>
  );
}

// Row + optional expansion row (rates workbench) — kept outside the main
// component so the table body stays readable.
function FragmentRow({ r, stages, view, cellFor, expanded, workbench }) {
  return (
    <>
      <tr className="border-t hover:bg-gray-50/50">
        <td className="p-2">
          <div className="font-semibold text-gray-800 leading-tight">{r.indent_number}</div>
          <div className="text-[10px] text-gray-500 leading-tight truncate max-w-[150px]">{r.site_name || '—'}</div>
          {r.po_total > 0 && <div className="text-[10px] text-gray-600 font-medium tabular-nums">{inr(r.po_total)}</div>}
        </td>
        {stages.map((s, i) => cellFor(r, i))}
        {view === 'completed' && (
          <td className="border-l border-gray-100 px-1 py-1 text-center text-[10px] text-emerald-700 font-semibold whitespace-nowrap">
            {String(r.completed_at).slice(0, 10)}
          </td>
        )}
      </tr>
      {expanded && (
        <tr className="border-t bg-indigo-50/40">
          <td colSpan={1 + stages.length + (view === 'completed' ? 1 : 0)} className="p-0">{workbench}</td>
        </tr>
      )}
    </>
  );
}
