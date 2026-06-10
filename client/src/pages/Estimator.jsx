import { useState, useEffect, useMemo, useRef } from 'react';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiDownload, FiUploadCloud, FiEdit2, FiSave } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// AI Auto-Quotation (Estimator) — mam 2026-06-09.
// Build a BOQ by picking items from Item Master (material rate PP auto-fills
// from current_price; the AI rate-suggestion shows the last-quoted rate).
// Each line: TP = PP + ACC + LAB, TPA = TP × qty,
//            SP = TPA × (1 + margin%)   ← margin is set PER CATEGORY.
// Mirrors mam's own quotation sheet columns (PP/ACC/LAB/TP/TPA/Margin/SP).

const blankRow = () => ({
  item_id: null, code: '', description: '', category: '', unit: 'nos',
  qty: 1, pp: 0, lab: 0, suggestion: null,
  confidence: '', matchedName: '', matchScore: 0, alternatives: [],
  subs: [], // accessory / FOC items bundled under this line
  fromKit: false, // material rate + labour + FOC pulled from a PO/FOC kit
});

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function Estimator() {
  const [itemOptions, setItemOptions] = useState([]);
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [title, setTitle] = useState('');
  const [accPct, setAccPct] = useState(0);          // accessories = % of material (PP)
  const [margins, setMargins] = useState({});        // { category: marginPct }
  const [rows, setRows] = useState([blankRow()]);
  const [matching, setMatching] = useState(false);
  const [kitByPoId, setKitByPoId] = useState({}); // po_item_id → PO/FOC kit (labour, focs, po_rate)
  // Manpower / additional cost block for the SUMMARY sheet (saizar format).
  const [manpower, setManpower] = useState([
    { name: 'Site Engineer', qty: 1, monthly_cost: 40000, months: 0 },
    { name: 'Junior Engineer', qty: 1, monthly_cost: 25000, months: 0 },
    { name: 'Room rent, Food etc', qty: 1, monthly_cost: 10000, months: 0 },
    { name: 'Hydra', qty: 1, monthly_cost: 75000, months: 0 },
    { name: 'Scaffolding', qty: 1, monthly_cost: 40000, months: 0 },
  ]);
  const [view, setView] = useState('build');     // 'build' | 'saved'
  const [savedList, setSavedList] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    api.get('/item-master/dropdown').then(r => setItemOptions(r.data)).catch(() => {});
    api.get('/leads').then(r => setLeads(r.data)).catch(() => {});
    // PO/FOC kits — so picking an item pulls its labour rate + FOC + material
    // rate from the PO/FOC module. Approved kits win over drafts.
    api.get('/quotations/po-foc').then(r => {
      const map = {};
      for (const k of (r.data.rows || [])) {
        if (!k.po_item_id) continue;
        if (!map[k.po_item_id] || (k.status === 'approved' && map[k.po_item_id].status !== 'approved')) {
          map[k.po_item_id] = { labour: k.labour, po_rate: k.po_rate, focs: k.focs || [], status: k.status };
        }
      }
      setKitByPoId(map);
    }).catch(() => {});
  }, []);

  // Pull labour + FOC + material rate from a PO/FOC kit for an item, if one exists.
  const kitFields = (itemId, fallbackPp) => {
    const kit = kitByPoId[itemId];
    if (!kit) return null;
    return {
      fromKit: true,
      lab: kit.labour || 0,
      pp: kit.po_rate || fallbackPp || 0,
      subs: (kit.focs || []).map(f => ({ item_id: f.item_id || null, name: f.name || '', qty: f.qty || 1, rate: f.rate || 0, foc: false })),
    };
  };

  // Categories present across the rows → drives the per-category margin inputs.
  const categories = useMemo(
    () => [...new Set(rows.map(r => r.category).filter(Boolean))],
    [rows]
  );
  const marginFor = (cat) => Number(margins[cat] ?? 0);

  const patchRow = (i, patch) =>
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  // Pick an item from Item Master → auto-fill material rate (PP), category,
  // unit, description, then fetch the AI rate suggestion.
  const pickItem = async (i, opt) => {
    if (!opt) { patchRow(i, { item_id: null, suggestion: null, matchedName: '', confidence: '', fromKit: false }); return; }
    const kit = kitFields(opt.id, opt.current_price);
    setRows(rs => rs.map((r, idx) => idx === i ? {
      ...r,
      item_id: opt.id,
      code: opt.item_code || '',
      description: r.description || opt.display_name || opt.item_name || '',
      category: opt.department || 'General',
      unit: (r.unit && r.unit !== 'nos') ? r.unit : (opt.uom || 'nos'),
      pp: opt.current_price || 0,
      lab: 0, subs: [], fromKit: false,
      ...(kit || {}),  // PO/FOC kit overrides pp + labour + FOC when it exists
      matchedName: opt.display_name || opt.item_name || '',
      matchScore: 100, confidence: 'high', alternatives: [],
    } : r));
    if (kit) toast.success('Labour + FOC pulled from PO/FOC kit');
    try {
      const params = { item_id: opt.id };
      if (leadId) params.lead_id = leadId;
      const { data } = await api.get('/ai-agent/rate-suggestion', { params });
      patchRow(i, { suggestion: data });
    } catch (e) { /* suggestion is best-effort */ }
  };

  // Swap a row to one of the AI's alternative matches (one-click review).
  const applyMatch = (i, m) => patchRow(i, {
    item_id: m.item_id, code: m.code, category: m.department, pp: m.rate,
    matchedName: m.name, matchScore: m.score,
    confidence: m.score >= 60 ? 'high' : m.score >= 30 ? 'medium' : 'low',
  });

  // Upload the CLIENT's BOQ Excel → AI matches every line to Item Master.
  const uploadBoq = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMatching(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/quotations/auto-match-boq', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const mapped = (data.rows || []).map(r => {
        const base = {
          ...blankRow(),
          item_id: r.match?.item_id || null,
          code: r.match?.code || '',
          description: r.description,
          category: r.match?.department || '',
          unit: r.unit || r.match?.uom || 'nos',
          qty: r.qty || 1,
          pp: r.match?.rate || 0,
          confidence: r.confidence,
          matchedName: r.match?.name || '',
          matchScore: r.match?.score || 0,
          alternatives: r.alternatives || [],
        };
        const kit = r.match?.item_id ? kitFields(r.match.item_id, r.match.rate) : null;
        return kit ? { ...base, ...kit } : base;
      });
      if (!mapped.length) { toast.error('No items found in that BOQ'); return; }
      setRows(mapped);
      const unsure = mapped.filter(m => m.confidence === 'low' || m.confidence === 'none').length;
      toast.success(`Matched ${mapped.length} item(s) — ${unsure} need a quick review`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not read that BOQ');
    } finally {
      setMatching(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Accessory / FOC sub-items under a line. FOC = free (₹0, just listed);
  // a non-FOC accessory adds rate×qty to that line's cost.
  const addSub = (i) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: [...(r.subs || []), { item_id: null, name: '', qty: 1, rate: 0, foc: true }] } : r));
  const patchSub = (i, si, patch) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: (r.subs || []).map((s, sj) => sj === si ? { ...s, ...patch } : s) } : r));
  const removeSub = (i, si) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, subs: (r.subs || []).filter((_, sj) => sj !== si) } : r));
  const pickSub = (i, si, opt) => patchSub(i, si, opt
    ? { item_id: opt.id, name: opt.display_name || opt.item_name, rate: opt.current_price || 0 }
    : { item_id: null, name: '' });

  const confBadge = (c, score) => {
    if (c === 'high') return <span className="text-emerald-600 font-semibold">✅ {score}%</span>;
    if (c === 'medium') return <span className="text-amber-600 font-semibold">⚠️ {score}%</span>;
    if (c === 'low') return <span className="text-red-500 font-semibold">❗ {score}% check</span>;
    if (c === 'none') return <span className="text-red-500 font-semibold">❗ no match</span>;
    return null;
  };

  // Per-row computed economics (matches mam's sheet).
  const calc = (row) => {
    const pp = Number(row.pp) || 0;
    const qty = Number(row.qty) || 0;
    const lab = Number(row.lab) || 0;
    // ACC = total of the FOC / accessory items of this PO line (mam 2026-06-10:
    // "acc = foc total rate of that po item") + an optional % of material.
    const subsCharged = r2((row.subs || []).filter(s => !s.foc)
      .reduce((t, s) => t + (Number(s.rate) || 0) * (Number(s.qty) || 0), 0));
    const acc = r2(subsCharged + pp * qty * (Number(accPct) || 0) / 100);
    const tp = r2(pp + lab);                 // per-unit base (material + labour)
    const tpa = r2(tp * qty + acc);          // line total = base × qty + accessories
    const mPct = marginFor(row.category);
    const sp = r2(tpa * (1 + mPct / 100));
    const rate = qty ? r2(sp / qty) : 0;
    return { acc, tp, tpa, mPct, sp, rate, cost: tpa, subsCharged };
  };

  const totals = useMemo(() => rows.reduce((t, row) => {
    const c = calc(row);
    t.cost += c.cost; t.sp += c.sp;
    return t;
  }, { cost: 0, sp: 0 }), [rows, accPct, margins]);
  const marginAmt = r2(totals.sp - totals.cost);

  const exportSheet = () => {
    const headers = ['S.NO', 'ITEM DESCRIPTION', 'UNIT', 'QTY', 'RATE', 'AMOUNT',
      'PP', 'ACC', 'LAB', 'TP', 'TPA', 'MARGIN %', 'SP', 'CATEGORY'];
    const data = [];
    // One row per main item only — FOC items are NOT listed in the export
    // (mam 2026-06-10). Their cost is already inside the line's TPA/SP.
    rows.filter(r => r.description).forEach((row, idx) => {
      const c = calc(row);
      data.push([idx + 1, row.description, row.unit, row.qty, c.rate, c.sp,
        row.pp, c.acc, row.lab, c.tp, c.tpa, c.mPct, c.sp, row.category]);
    });
    if (!data.length) { toast.error('Add at least one item'); return; }
    // Totals line
    data.push(['', 'TOTAL', '', '', '', totals.sp, '', '', '', '', totals.cost, '', totals.sp, '']);
    exportCsv(`quotation-${title || 'estimate'}`, headers, data);
  };

  const patchMp = (i, patch) => setManpower(m => m.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addMp = () => setManpower(m => [...m, { name: '', qty: 1, monthly_cost: 0, months: 0 }]);
  const removeMp = (i) => setManpower(m => m.filter((_, idx) => idx !== i));
  const mpAmt = (m) => (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);

  // Full saizar-format export: per-category sheets + SUMMARY + manpower.
  const exportXlsx = async () => {
    const data = rows.filter(r => r.description).map((row, idx) => {
      const c = calc(row);
      return { s_no: idx + 1, description: row.description, make: '', unit: row.unit, qty: Number(row.qty) || 0, rate: c.rate, sp: c.sp, pp: Number(row.pp) || 0, acc: c.acc, lab: Number(row.lab) || 0, tp: c.tp, tpa: c.tpa, margin: c.mPct, category: row.category || 'General' };
    });
    if (!data.length) { toast.error('Add at least one item'); return; }
    const clientName = leads.find(l => String(l.id) === String(leadId))?.company_name || '';
    try {
      const resp = await api.post('/quotations/estimate-export', { title, client_name: clientName, manpower, rows: data }, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a'); a.href = url; a.download = `quotation-${(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Quotation downloaded');
    } catch (e) { toast.error('Export failed'); }
  };

  // Save / list / edit saved quotations (client-wise).
  const loadSavedList = () => api.get('/quotations/estimates').then(r => setSavedList(r.data || [])).catch(() => {});
  useEffect(() => { if (view === 'saved') loadSavedList(); }, [view]);

  const saveEstimate = async () => {
    if (!rows.some(r => r.description)) { toast.error('Add at least one item'); return; }
    const clientName = leads.find(l => String(l.id) === String(leadId))?.company_name || '';
    const payload = { title, lead_id: leadId || null, client_name: clientName, acc_pct: accPct, margins, rows, manpower, cost: totals.cost, sp: totals.sp };
    try {
      if (currentId) { await api.put(`/quotations/estimates/${currentId}`, payload); }
      else { const r = await api.post('/quotations/estimates', payload); setCurrentId(r.data.id); }
      toast.success('Quotation saved');
    } catch (e) { toast.error('Save failed'); }
  };
  const editEstimate = async (id) => {
    try {
      const { data } = await api.get(`/quotations/estimates/${id}`);
      setTitle(data.title || ''); setLeadId(data.lead_id || ''); setAccPct(data.acc_pct || 0);
      setMargins(data.margins || {}); setManpower((data.manpower && data.manpower.length) ? data.manpower : []);
      setRows((data.rows && data.rows.length) ? data.rows : [blankRow()]);
      setCurrentId(id); setView('build'); toast.success('Loaded — you can edit and re-save');
    } catch (e) { toast.error('Failed to load'); }
  };
  const delEstimate = async (id) => { if (!confirm('Delete this saved quotation?')) return; try { await api.delete(`/quotations/estimates/${id}`); loadSavedList(); } catch (e) { toast.error('Failed'); } };
  const newEstimate = () => { setTitle(''); setLeadId(''); setAccPct(0); setMargins({}); setRows([blankRow()]); setCurrentId(null); setView('build'); };

  const lab = (s) => <span className="text-[10px] font-semibold text-gray-500 uppercase">{s}</span>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">🧮 AI Auto-Quotation {currentId && <span className="text-xs font-normal text-amber-600">(editing #{currentId})</span>}</h1>
          <p className="text-sm text-gray-500">Pick items from Item Master — material rate auto-fills, add labour, set margin per category, and the sale price is built automatically.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={newEstimate} className="btn btn-secondary text-sm flex items-center gap-1"><FiPlus size={14} /> New</button>
          <button onClick={() => setView('build')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${view === 'build' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200'}`}>Build</button>
          <button onClick={() => setView('saved')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${view === 'saved' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200'}`}>Saved (by client)</button>
        </div>
      </div>

      {view === 'saved' ? (
        <div className="card p-0 overflow-hidden">
          {savedList.length === 0 && <div className="p-8 text-center text-gray-400 text-sm">No saved quotations yet. Build one and click Save.</div>}
          {(() => {
            const byClient = {};
            savedList.forEach(s => { const c = s.client_name || '— No client —'; (byClient[c] = byClient[c] || []).push(s); });
            return Object.entries(byClient).map(([client, list]) => (
              <div key={client}>
                <div className="px-4 py-2 bg-gray-50 text-xs font-bold uppercase text-gray-600 border-b">{client} <span className="text-gray-400">({list.length})</span></div>
                {list.map(s => (
                  <div key={s.id} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-100 hover:bg-gray-50">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 truncate">{s.title || '(untitled)'}</div>
                      <div className="text-[11px] text-gray-400">Sale Price ₹{fmt(s.sp)} · {String(s.updated_at || '').slice(0, 10)}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => editEstimate(s.id)} className="btn btn-secondary text-xs flex items-center gap-1"><FiEdit2 size={12} /> Edit</button>
                      <button onClick={() => delEstimate(s.id)} className="text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            ));
          })()}
        </div>
      ) : (<>

      {/* Header inputs */}
      <div className="card p-4 grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div>
          <label className="label">Client / Lead</label>
          <select className="select" value={leadId} onChange={e => setLeadId(e.target.value)}>
            <option value="">Select</option>
            {leads.map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Quotation Title</label>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. 250 KVA Servo" />
        </div>
        <div>
          <label className="label" title="Accessories = this % of material rate">Accessories % (of material)</label>
          <input className="input" type="number" min="0" step="0.5" value={accPct} onChange={e => setAccPct(e.target.value)} />
        </div>
      </div>

      {/* Auto-build from client BOQ */}
      <div className="card p-4 flex flex-wrap items-center gap-3 bg-indigo-50/50 border border-indigo-100">
        <div className="flex-1 min-w-[220px]">
          <div className="font-semibold text-sm flex items-center gap-1">🤖 Auto-build from Client BOQ</div>
          <div className="text-xs text-gray-500">Upload the client's BOQ — Excel, PDF or Word. AI matches each line to your Item Master and fills the rates. Review the lines it flags ❗.</div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.doc,.docx" className="hidden" onChange={uploadBoq} />
        <button type="button" disabled={matching} onClick={() => fileRef.current?.click()}
          className="btn btn-primary text-sm flex items-center gap-1">
          <FiUploadCloud size={15} /> {matching ? 'Matching…' : 'Upload Client BOQ'}
        </button>
      </div>

      {/* Per-category margins */}
      {categories.length > 0 && (
        <div className="card p-4">
          <div className="text-sm font-semibold mb-2">Margin % per category</div>
          <div className="flex flex-wrap gap-3">
            {categories.map(cat => (
              <div key={cat} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                <span className="text-xs font-medium text-gray-700">{cat}</span>
                <input className="input w-20 text-right py-1" type="number" min="0" step="1"
                  value={margins[cat] ?? ''} placeholder="0"
                  onChange={e => setMargins(m => ({ ...m, [cat]: e.target.value }))} />
                <span className="text-xs text-gray-400">%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Items table */}
      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <th className="p-2">#</th>
              <th className="p-2 min-w-[240px]">Item (from Item Master)</th>
              <th className="p-2">Category</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-right" title="Material price (auto from Item Master)">PP ₹</th>
              <th className="p-2 text-right" title="Accessories = PP × Acc%">ACC ₹</th>
              <th className="p-2 text-right" title="Labour (enter manually / from labour sheet)">LAB ₹</th>
              <th className="p-2 text-right" title="TP = PP + ACC + LAB">TP ₹</th>
              <th className="p-2 text-right" title="TPA = TP × Qty (total cost)">TPA ₹</th>
              <th className="p-2 text-right">Margin</th>
              <th className="p-2 text-right" title="SP = TPA × (1 + margin%)">SP ₹</th>
              <th className="p-2 text-right" title="Sale rate per unit = SP ÷ Qty">Rate ₹</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const c = calc(row);
              return (
                <tr key={i} className={`border-t border-gray-100 align-top ${(row.confidence === 'low' || row.confidence === 'none') ? 'bg-red-50/40' : ''}`}>
                  <td className="p-2 text-gray-400">{i + 1}</td>
                  <td className="p-2">
                    <SearchableSelect
                      options={itemOptions}
                      value={row.item_id}
                      valueKey="id"
                      displayKey="display_name"
                      placeholder="Search Item Master…"
                      onChange={opt => pickItem(i, opt)}
                    />
                    <input className="input mt-1 text-xs" value={row.description}
                      onChange={e => patchRow(i, { description: e.target.value })}
                      placeholder="Description (auto-filled)" />
                    {row.suggestion && (row.suggestion.last_for_client || row.suggestion.last_overall) && (
                      <div className="text-[10px] text-indigo-600 mt-1">
                        🤖 last quoted: ₹{fmt(row.suggestion.last_for_client?.rate || row.suggestion.last_overall?.rate)}
                        <button type="button" className="ml-1 underline"
                          onClick={() => patchRow(i, { pp: row.suggestion.last_for_client?.rate || row.suggestion.last_overall?.rate })}>
                          use as material
                        </button>
                      </div>
                    )}
                    {row.matchedName && (
                      <div className="text-[10px] mt-1 flex items-center gap-1 flex-wrap">
                        {confBadge(row.confidence, row.matchScore)}
                        <span className="text-gray-500">→ {row.matchedName}</span>
                      </div>
                    )}
                    {row.alternatives?.length > 0 && (row.confidence === 'low' || row.confidence === 'medium' || row.confidence === 'none') && (
                      <div className="flex flex-wrap gap-1 mt-1 items-center">
                        <span className="text-[9px] text-gray-400">try:</span>
                        {row.alternatives.map((a, ai) => (
                          <button key={ai} type="button" onClick={() => applyMatch(i, a)}
                            className="text-[10px] bg-white hover:bg-indigo-100 border border-gray-200 rounded px-1 py-0.5">
                            {a.name} ({a.score}%)
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Accessory / FOC sub-items */}
                    <div className="mt-1.5 pl-2 border-l-2 border-indigo-100 space-y-1">
                      {(row.subs || []).map((s, si) => (
                        <div key={si} className="flex items-center gap-1 flex-wrap">
                          <div className="w-40">
                            <SearchableSelect options={itemOptions} value={s.item_id} valueKey="id"
                              displayKey="display_name" placeholder="Accessory…"
                              onChange={opt => pickSub(i, si, opt)} />
                          </div>
                          <input className="input w-12 text-center py-0.5 text-xs" type="number" min="0"
                            value={s.qty || ''} onChange={e => patchSub(i, si, { qty: e.target.value })} title="Qty" />
                          <label className="text-[10px] flex items-center gap-0.5" title="Free of cost">
                            <input type="checkbox" checked={s.foc} onChange={e => patchSub(i, si, { foc: e.target.checked })} />
                            <span className={s.foc ? 'text-emerald-600 font-semibold' : 'text-gray-400'}>FOC</span>
                          </label>
                          {!s.foc && (
                            <input className="input w-16 text-right py-0.5 text-xs" type="number" min="0"
                              value={s.rate || ''} onChange={e => patchSub(i, si, { rate: e.target.value })} placeholder="rate" />
                          )}
                          <button type="button" className="text-red-300 hover:text-red-500"
                            onClick={() => removeSub(i, si)}><FiTrash2 size={11} /></button>
                        </div>
                      ))}
                      <button type="button" className="text-[10px] text-indigo-600 hover:underline"
                        onClick={() => addSub(i)}>+ Accessory / FOC</button>
                    </div>
                  </td>
                  <td className="p-2 text-xs text-gray-600">{row.category || '—'}</td>
                  <td className="p-2 w-16">
                    <input className="input text-center py-1" type="number" min="0" value={row.qty || ''}
                      onChange={e => patchRow(i, { qty: e.target.value })} />
                  </td>
                  <td className="p-2 w-24">
                    <input className="input text-right py-1" type="number" min="0" value={row.pp || ''}
                      onChange={e => patchRow(i, { pp: e.target.value })} />
                  </td>
                  <td className="p-2 text-right text-gray-600">{fmt(c.acc)}</td>
                  <td className="p-2 w-24">
                    <input className="input text-right py-1" type="number" min="0" value={row.lab || ''}
                      onChange={e => patchRow(i, { lab: e.target.value })} placeholder="0" />
                    {row.fromKit && <div className="text-[9px] text-indigo-500 mt-0.5 text-right" title="Labour + FOC from the PO/FOC module">🔗 PO/FOC</div>}
                  </td>
                  <td className="p-2 text-right text-gray-700">{fmt(c.tp)}</td>
                  <td className="p-2 text-right text-gray-700">{fmt(c.tpa)}</td>
                  <td className="p-2 text-right text-gray-500">{c.mPct}%</td>
                  <td className="p-2 text-right font-bold text-emerald-700">{fmt(c.sp)}</td>
                  <td className="p-2 text-right">{fmt(c.rate)}</td>
                  <td className="p-2">
                    <button type="button" className="text-red-400 hover:text-red-600"
                      onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)}>
                      <FiTrash2 size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <td className="p-2" colSpan={8}></td>
              <td className="p-2 text-right" title="Total cost">{fmt(totals.cost)}</td>
              <td className="p-2 text-right text-emerald-700" title="Margin amount">+{fmt(marginAmt)}</td>
              <td className="p-2 text-right text-emerald-700 text-base">{fmt(totals.sp)}</td>
              <td className="p-2" colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Manpower / Additional cost — flows into the SUMMARY sheet */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-700">Manpower / Additional Cost (for the Summary sheet)</span>
          <button type="button" onClick={addMp} className="text-xs text-indigo-600 hover:underline flex items-center gap-1"><FiPlus size={12} /> Add row</button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-[10px] uppercase text-gray-400 text-left">
              <th className="p-1 min-w-[180px]">Item</th><th className="p-1 text-right">Qty</th><th className="p-1 text-right">Monthly Cost ₹</th><th className="p-1 text-right">Months</th><th className="p-1 text-right">Amount ₹</th><th></th>
            </tr></thead>
            <tbody>
              {manpower.map((m, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="p-1"><input className="input py-1" value={m.name} onChange={e => patchMp(i, { name: e.target.value })} placeholder="e.g. Site Engineer" /></td>
                  <td className="p-1 w-16"><input className="input text-right py-1" type="number" min="0" value={m.qty} onChange={e => patchMp(i, { qty: e.target.value })} /></td>
                  <td className="p-1 w-28"><input className="input text-right py-1" type="number" min="0" value={m.monthly_cost} onChange={e => patchMp(i, { monthly_cost: e.target.value })} /></td>
                  <td className="p-1 w-20"><input className="input text-right py-1" type="number" min="0" value={m.months} onChange={e => patchMp(i, { months: e.target.value })} /></td>
                  <td className="p-1 text-right font-medium">{fmt(mpAmt(m))}</td>
                  <td className="p-1"><button type="button" className="text-red-400 hover:text-red-600" onClick={() => removeMp(i)}><FiTrash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-gray-200 font-semibold"><td className="p-1" colSpan={4}>Manpower Total</td><td className="p-1 text-right text-indigo-700">₹{fmt(manpower.reduce((t, m) => t + mpAmt(m), 0))}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setRows(rs => [...rs, blankRow()])} className="btn btn-secondary text-sm flex items-center gap-1">
          <FiPlus size={14} /> Add Item
        </button>
        <button type="button" onClick={saveEstimate} className="btn btn-success text-sm flex items-center gap-1">
          <FiSave size={14} /> {currentId ? 'Update Saved' : 'Save Quotation'}
        </button>
        <button type="button" onClick={exportXlsx} className="btn btn-primary text-sm flex items-center gap-1">
          <FiDownload size={14} /> Export Quotation (Excel)
        </button>
        <div className="ml-auto text-sm text-gray-600">
          Cost <b>₹{fmt(totals.cost)}</b> &nbsp;·&nbsp; Margin <b className="text-emerald-700">₹{fmt(marginAmt)}</b> &nbsp;·&nbsp; Sale Price <b className="text-emerald-700 text-base">₹{fmt(totals.sp)}</b>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Formula: TPA = (PP + LAB) × Qty + ACC, where ACC = the total of this line's FOC / accessory items. SP = TPA × (1 + category margin%). Material (PP), labour (LAB) and FOC all pull from the 🔗 PO/FOC kit when the item has one.
      </p>
      </>)}
    </div>
  );
}
