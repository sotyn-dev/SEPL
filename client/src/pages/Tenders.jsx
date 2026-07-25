import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import SearchableSelect from '../components/SearchableSelect';
import Modal from '../components/Modal';
import {
  FiPlus, FiTrash2, FiUploadCloud, FiDownload, FiSave, FiRefreshCw, FiArrowLeft,
  FiFileText, FiCheckCircle, FiClock, FiAward, FiSearch, FiZap, FiDollarSign,
} from 'react-icons/fi';

// AI Tenders (director 2026-07-25) — government / large-tender bid builder.
// Upload the NIT/BOQ → the SAME AI engine as Quotations extracts + matches +
// prices every line → track eligibility docs, submission and L1/L2 result.

const STATUS = {
  draft:     { label: 'Draft',           badge: 'badge-gray' },
  pricing:   { label: 'Pricing',         badge: 'badge-yellow' },
  ready:     { label: 'Ready to Submit', badge: 'badge-blue' },
  submitted: { label: 'Submitted',       badge: 'badge-purple' },
  won:       { label: 'Won',             badge: 'badge-green' },
  lost:      { label: 'Lost',            badge: 'badge-red' },
  withdrawn: { label: 'Withdrawn',       badge: 'badge-gray' },
};
const CONF = { high: 'badge-green', medium: 'badge-yellow', low: 'badge-gray', none: 'badge-red' };
const PORTALS = [['gem', 'GeM'], ['cppp', 'CPPP / eProc'], ['state', 'State Portal'], ['private', 'Private'], ['other', 'Other']];
const DISCIPLINES = ['Electrical', 'Mechanical', 'Low Voltage', 'Solar', 'Fire Fighting', 'Plumbing'];
const FILTERS = ['all', 'draft', 'pricing', 'ready', 'submitted', 'won', 'lost'];

const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const lineRate = (r) => {
  const tp = (+r.pp || 0) + (+r.acc || 0) + (+r.labour || 0);
  const rate = r2(tp * (1 + (+r.margin_pct || 0) / 100));
  return { tp, rate, amount: r2(rate * (+r.quantity || 0)) };
};

function DueBadge({ d }) {
  if (d == null) return <span className="badge badge-gray">No date</span>;
  if (d < 0) return <span className="badge badge-red">Overdue {-d}d</span>;
  if (d <= 3) return <span className="badge badge-red">{d}d left</span>;
  if (d <= 7) return <span className="badge badge-yellow">{d}d left</span>;
  return <span className="badge badge-gray">{d}d left</span>;
}

export default function Tenders() {
  const { canCreate, canEdit, canDelete, canApprove } = useAuth();
  const [list, setList] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);   // null → list view
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [l, s] = await Promise.all([
        api.get('/tenders', { params: filter === 'all' ? {} : { status: filter } }),
        api.get('/tenders/stats'),
      ]);
      setList(l.data || []);
      setStats(s.data || null);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to load tenders'); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { if (openId === null) loadList(); }, [openId, loadList]);

  if (openId !== null) {
    return <TenderDetail id={openId} onBack={() => setOpenId(null)}
      perms={{ canEdit: canEdit('tenders'), canApprove: canApprove('tenders'), canDelete: canDelete('tenders') }} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2"><FiAward /> AI Tenders</h1>
          <p className="text-sm text-gray-500">Upload the tender BOQ → AI prices the whole bid → track docs, submission &amp; result.</p>
        </div>
        <div className="flex gap-2">
          {canCreate('tenders') && <ImportFunnelButton onDone={loadList} onOpen={setOpenId} />}
          {canCreate('tenders') && <NewTenderButton onCreated={(id) => setOpenId(id)} />}
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={<FiFileText />} label="Open tenders" value={stats.open} />
          <StatCard icon={<FiClock />} label="Due ≤ 7 days" value={stats.due_soon} tone={stats.due_soon ? 'amber' : ''} />
          <StatCard icon={<FiCheckCircle />} label="Submitted" value={stats.by_status?.submitted?.count || 0} />
          <StatCard icon={<FiAward />} label="Win rate" value={stats.win_rate == null ? '—' : stats.win_rate + '%'} sub={`${stats.won}W / ${stats.lost}L`} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm capitalize ${filter === f ? 'bg-gray-900 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
            {f === 'all' ? 'All' : STATUS[f]?.label || f}
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="p-2">Tender</th><th className="p-2">Portal</th><th className="p-2">Department</th>
              <th className="p-2">Due</th><th className="p-2 text-right">Items</th>
              <th className="p-2 text-right">Bid Value</th><th className="p-2">Status</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {list.map(t => (
              <tr key={t.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => setOpenId(t.id)}>
                <td className="p-2">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-gray-400">{t.tender_no || 'No NIT no.'}</div>
                </td>
                <td className="p-2 uppercase text-xs">{t.portal}</td>
                <td className="p-2">{t.department || '—'}</td>
                <td className="p-2"><DueBadge d={t.days_left} /><div className="text-xs text-gray-400 mt-0.5">{fmtDate(t.bid_due_date)}</div></td>
                <td className="p-2 text-right">{t.item_count}</td>
                <td className="p-2 text-right font-medium">₹{fmt(t.bid_amount)}</td>
                <td className="p-2"><span className={`badge ${STATUS[t.status]?.badge}`}>{STATUS[t.status]?.label || t.status}</span></td>
                <td className="p-2 text-gray-400">›</td>
              </tr>
            ))}
            {!list.length && (
              <tr><td colSpan={8} className="p-8 text-center text-gray-400">
                {loading ? 'Loading…' : 'No tenders yet. Click “New Tender” or “Import from Sales Funnel”.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, tone }) {
  return (
    <div className={`card !p-3 ${tone === 'amber' ? 'ring-1 ring-amber-200 bg-amber-50' : ''}`}>
      <div className="flex items-center gap-2 text-gray-500 text-xs">{icon}{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

// ── New tender form (shared by create + edit) ───────────────────────────────
function TenderForm({ initial, onSubmit, submitLabel }) {
  const [f, setF] = useState(initial || { portal: 'other', default_margin: 15 });
  const S = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(f); }} className="space-y-3">
      <div><label className="label">Tender Title *</label>
        <input className="input" value={f.title || ''} onChange={e => S('title', e.target.value)} required placeholder="e.g. Fire Fighting System — District Hospital" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Tender / NIT No.</label><input className="input" value={f.tender_no || ''} onChange={e => S('tender_no', e.target.value)} placeholder="GEM/2026/B/12345" /></div>
        <div><label className="label">Portal</label>
          <select className="input" value={f.portal || 'other'} onChange={e => S('portal', e.target.value)}>
            {PORTALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
      </div>
      <div><label className="label">Department / Client</label><input className="input" value={f.department || ''} onChange={e => S('department', e.target.value)} placeholder="PWD / CPWD / Client name" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Bid Due Date</label><input type="datetime-local" className="input" value={f.bid_due_date ? String(f.bid_due_date).slice(0, 16) : ''} onChange={e => S('bid_due_date', e.target.value)} /></div>
        <div><label className="label">Default Margin %</label><input type="number" className="input" value={f.default_margin ?? 15} onChange={e => S('default_margin', e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div><label className="label">EMD Amount</label><input type="number" className="input" value={f.emd_amount || ''} onChange={e => S('emd_amount', e.target.value)} /></div>
        <div><label className="label">EMD Mode</label>
          <select className="input" value={f.emd_mode || ''} onChange={e => S('emd_mode', e.target.value)}>
            <option value="">—</option><option>DD</option><option>BG</option><option>Online</option><option>Exempt</option>
          </select></div>
        <div><label className="label">Estimated Value</label><input type="number" className="input" value={f.estimated_value || ''} onChange={e => S('estimated_value', e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <div><label className="label">PBG Amount</label><input type="number" className="input" value={f.pbg_amount || ''} onChange={e => S('pbg_amount', e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" checked={!!f.pbg_required} onChange={e => S('pbg_required', e.target.checked)} /> PBG required</label>
      </div>
      <div><label className="label">Notes</label><textarea className="input" rows={2} value={f.notes || ''} onChange={e => S('notes', e.target.value)} /></div>
      <button className="btn btn-primary w-full" type="submit">{submitLabel}</button>
    </form>
  );
}

function NewTenderButton({ onCreated }) {
  const [open, setOpen] = useState(false);
  const create = async (f) => {
    try { const { data } = await api.post('/tenders', f); toast.success('Tender created'); setOpen(false); onCreated(data.id); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to create'); }
  };
  return (<>
    <button className="btn btn-primary" onClick={() => setOpen(true)}><FiPlus /> New Tender</button>
    <Modal isOpen={open} onClose={() => setOpen(false)} title="New Tender" wide>
      <TenderForm onSubmit={create} submitLabel="Create Tender" />
    </Modal>
  </>);
}

function ImportFunnelButton({ onOpen }) {
  const [open, setOpen] = useState(false);
  const [leads, setLeads] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setOpen(true);
    try { const { data } = await api.get('/tenders/funnel-tenders'); setLeads(data || []); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load'); }
  };
  const pull = async (funnel_id) => {
    setBusy(true);
    try {
      const { data } = await api.post('/tenders/from-funnel', { funnel_id });
      toast.success(data.warn || `Imported ${data.imported} lines`);
      setOpen(false); onOpen(data.id);
    } catch (e) { toast.error(e.response?.data?.error || 'Import failed'); }
    finally { setBusy(false); }
  };
  return (<>
    <button className="btn btn-secondary" onClick={load}><FiDownload /> Import from Sales Funnel</button>
    <Modal isOpen={open} onClose={() => setOpen(false)} title="Government tenders captured in the Sales Funnel" wide>
      {busy && <div className="text-sm text-gray-500 mb-2 flex items-center gap-2"><FiZap className="animate-pulse" /> AI is importing &amp; pricing the BOQ…</div>}
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {leads.map(l => (
          <div key={l.id} className="flex items-center justify-between gap-2 border rounded-lg p-2">
            <div>
              <div className="font-medium text-sm">{l.project_name || l.company_name || l.client_name}</div>
              <div className="text-xs text-gray-400">{l.tender_id || 'No NIT'} · Due {fmtDate(l.bid_deadline)} · EMD ₹{fmt(l.emd_amount)}{l.boq_link ? ' · BOQ ✓' : ' · No BOQ'}</div>
            </div>
            {l.linked ? <span className="badge badge-gray">Imported</span>
              : <button className="btn btn-primary text-xs" disabled={busy} onClick={() => pull(l.id)}>Pull &amp; Price</button>}
          </div>
        ))}
        {!leads.length && <div className="text-center text-gray-400 py-6">No government tenders in the Sales Funnel.</div>}
      </div>
    </Modal>
  </>);
}

// ── Detail: header + Bid Builder / Documents / Submission tabs ───────────────
function TenderDetail({ id, onBack, perms }) {
  const [t, setT] = useState(null);
  const [tab, setTab] = useState('build');
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await api.get(`/tenders/${id}`); setT(data); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to load'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const saveHeader = async (f) => {
    try { await api.put(`/tenders/${id}`, f); toast.success('Saved'); setEditOpen(false); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const setStatus = async (status) => {
    try { await api.put(`/tenders/${id}`, { status }); load(); } catch (e) { toast.error('Failed'); }
  };

  if (!t) return <div className="p-8 text-center text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <button className="text-sm text-gray-500 flex items-center gap-1 hover:text-gray-800" onClick={onBack}><FiArrowLeft /> All tenders</button>

      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{t.title}</h1>
              <span className={`badge ${STATUS[t.status]?.badge}`}>{STATUS[t.status]?.label}</span>
            </div>
            <div className="text-sm text-gray-500 mt-1">
              {t.tender_no || 'No NIT no.'} · <span className="uppercase">{t.portal}</span> · {t.department || 'No dept'}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm mt-2">
              <span>Due: <b><DueBadge d={t.days_left} /></b> {fmtDate(t.bid_due_date)}</span>
              <span>EMD: <b>₹{fmt(t.emd_amount)}</b> {t.emd_mode ? `(${t.emd_mode})` : ''}</span>
              {t.pbg_required ? <span>PBG: <b>₹{fmt(t.pbg_amount)}</b></span> : null}
              {t.estimated_value ? <span>Est. value: <b>₹{fmt(t.estimated_value)}</b></span> : null}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-gray-400">Our bid</div>
            <div className="text-2xl font-bold">₹{fmt(t.bid_amount)}</div>
            <div className="text-xs text-gray-400">cost ₹{fmt(t.cost_amount)} · margin {t.bid_amount > 0 ? Math.round((1 - t.cost_amount / t.bid_amount) * 100) : 0}%</div>
            {perms.canEdit && (
              <div className="mt-2 flex gap-1 justify-end">
                <select className="input-compact text-xs" value={t.status} onChange={e => setStatus(e.target.value)}>
                  {['draft', 'pricing', 'ready', 'submitted', 'won', 'lost', 'withdrawn'].map(s => <option key={s} value={s}>{STATUS[s].label}</option>)}
                </select>
                <button className="btn btn-secondary text-xs" onClick={() => setEditOpen(true)}>Edit</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-1.5 border-b">
        {[['build', 'Bid Builder'], ['docs', 'Documents'], ['submit', 'Submission']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>

      {tab === 'build' && <BidBuilder t={t} reload={load} canEdit={perms.canEdit} />}
      {tab === 'docs' && <Documents t={t} reload={load} canEdit={perms.canEdit} />}
      {tab === 'submit' && <Submission t={t} reload={load} canEdit={perms.canEdit} canApprove={perms.canApprove} />}

      <Modal isOpen={editOpen} onClose={() => setEditOpen(false)} title="Edit Tender" wide>
        <TenderForm initial={t} onSubmit={saveHeader} submitLabel="Save Changes" />
      </Modal>
    </div>
  );
}

// ── Bid Builder: upload → AI price → editable grid ──────────────────────────
function BidBuilder({ t, reload, canEdit }) {
  const [rows, setRows] = useState(t.items || []);
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [margin, setMargin] = useState(t.default_margin ?? 15);
  const [ratePopup, setRatePopup] = useState(null); // {rowIdx, data}
  const fileRef = useRef(null);

  useEffect(() => { setRows(t.items || []); setDirty(false); }, [t.items]);

  const totals = useMemo(() => {
    let cost = 0, bid = 0;
    rows.forEach(r => { const { tp, amount } = lineRate(r); cost += tp * (+r.quantity || 0); bid += amount; });
    return { cost: r2(cost), bid: r2(bid), margin: bid > 0 ? Math.round((1 - cost / bid) * 100) : 0 };
  }, [rows]);

  const edit = (i, k, v) => { setRows(p => p.map((r, idx) => idx === i ? { ...r, [k]: v } : r)); setDirty(true); };
  const addRow = () => { setRows(p => [...p, { description: '', unit: 'nos', quantity: 1, pp: 0, acc: 0, labour: 0, margin_pct: margin, match_confidence: 'none' }]); setDirty(true); };
  const delRow = (i) => { setRows(p => p.filter((_, idx) => idx !== i)); setDirty(true); };

  const upload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const replace = rows.length ? window.confirm('Replace the current lines with this document? Click Cancel to append instead.') : true;
    setUploading(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const { data } = await api.post(`/tenders/${t.id}/extract?replace=${replace ? 1 : 0}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`AI imported ${data.imported} lines (${data.matched_by === 'ai' ? 'AI-matched' : 'keyword-matched'})`);
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Extract failed'); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const save = async () => {
    try { await api.put(`/tenders/${t.id}/items`, { items: rows.map((r, i) => ({ ...r, sn: i + 1 })) }); toast.success('Bid saved'); setDirty(false); reload(); }
    catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const reprice = async () => {
    try { await api.post(`/tenders/${t.id}/reprice`, { margin }); toast.success(`Re-priced at ${margin}% margin`); reload(); }
    catch (e) { toast.error('Re-price failed'); }
  };
  const exportXlsx = async () => {
    try {
      const resp = await api.get(`/tenders/${t.id}/export`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a'); a.href = url; a.download = `tender-${(t.tender_no || t.title || t.id).replace(/[^a-z0-9]/gi, '_')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast.error('Export failed'); }
  };
  const showRate = async (i) => {
    const row = rows[i]; if (!row.item_id) { toast('No catalogue item matched on this line', { icon: 'ℹ️' }); return; }
    try { const { data } = await api.get(`/tenders/${t.id}/rate/${row.item_id}`); setRatePopup({ i, data }); }
    catch (e) { toast.error('No rate history'); }
  };

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" className="hidden" accept=".pdf,.xlsx,.xls,.csv,.doc,.docx" onChange={upload} />
          <button className="btn btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <><FiZap className="animate-pulse" /> AI reading BOQ…</> : <><FiUploadCloud /> Upload tender BOQ (AI)</>}
          </button>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-500">Margin %</span>
            <input type="number" className="input-compact w-16" value={margin} onChange={e => setMargin(e.target.value)} />
            <button className="btn btn-secondary text-xs" onClick={reprice}><FiRefreshCw /> Re-price all</button>
          </div>
          <button className="btn btn-secondary text-sm" onClick={addRow}><FiPlus /> Add line</button>
          <div className="ml-auto flex gap-2">
            <button className="btn btn-secondary text-sm" onClick={exportXlsx}><FiDownload /> Export Excel</button>
            <button className={`btn text-sm ${dirty ? 'btn-success' : 'btn-secondary'}`} disabled={!dirty} onClick={save}><FiSave /> Save Bid</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto !p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b bg-gray-50">
              <th className="p-2 w-8">#</th><th className="p-2 min-w-[240px]">Description</th><th className="p-2">Matched item</th>
              <th className="p-2">Unit</th><th className="p-2 text-right">Qty</th>
              <th className="p-2 text-right">PP</th><th className="p-2 text-right">ACC</th><th className="p-2 text-right">Lab</th>
              <th className="p-2 text-right">Marg%</th><th className="p-2 text-right">Rate</th><th className="p-2 text-right">Amount</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const { rate, amount } = lineRate(r);
              return (
                <tr key={i} className="border-b hover:bg-gray-50 align-top">
                  <td className="p-2 text-gray-400">{i + 1}</td>
                  <td className="p-2">
                    <textarea className="input-compact w-full text-xs min-h-[2rem]" rows={1} value={r.description || ''} disabled={!canEdit}
                      onChange={e => edit(i, 'description', e.target.value)} />
                  </td>
                  <td className="p-2">
                    {r.matched_name
                      ? <><div className="text-[11px]">{r.matched_name}</div><span className={`badge ${CONF[r.match_confidence] || 'badge-gray'} !text-[9px]`}>{r.match_confidence}</span></>
                      : <span className="badge badge-red !text-[9px]">no match</span>}
                  </td>
                  <td className="p-2"><input className="input-compact w-14 text-xs" value={r.unit || ''} disabled={!canEdit} onChange={e => edit(i, 'unit', e.target.value)} /></td>
                  <td className="p-2"><input type="number" className="input-compact w-16 text-xs text-right" value={r.quantity ?? ''} disabled={!canEdit} onChange={e => edit(i, 'quantity', e.target.value)} /></td>
                  <td className="p-2"><input type="number" className="input-compact w-20 text-xs text-right" value={r.pp ?? ''} disabled={!canEdit} onChange={e => edit(i, 'pp', e.target.value)} /></td>
                  <td className="p-2"><input type="number" className="input-compact w-16 text-xs text-right" value={r.acc ?? ''} disabled={!canEdit} onChange={e => edit(i, 'acc', e.target.value)} /></td>
                  <td className="p-2"><input type="number" className="input-compact w-16 text-xs text-right" value={r.labour ?? ''} disabled={!canEdit} onChange={e => edit(i, 'labour', e.target.value)} /></td>
                  <td className="p-2"><input type="number" className="input-compact w-14 text-xs text-right" value={r.margin_pct ?? ''} disabled={!canEdit} onChange={e => edit(i, 'margin_pct', e.target.value)} /></td>
                  <td className="p-2 text-right font-medium">{fmt(rate)}</td>
                  <td className="p-2 text-right font-medium">{fmt(amount)}</td>
                  <td className="p-2 whitespace-nowrap">
                    <button className="text-gray-400 hover:text-blue-600" title="Rate history" onClick={() => showRate(i)}><FiSearch size={13} /></button>
                    {canEdit && <button className="text-gray-400 hover:text-red-600 ml-1" onClick={() => delRow(i)}><FiTrash2 size={13} /></button>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={12} className="p-8 text-center text-gray-400">No lines yet — upload the tender BOQ above and the AI will price it.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="font-bold border-t-2 bg-gray-50">
                <td className="p-2" colSpan={9}>TOTAL — margin {totals.margin}%</td>
                <td className="p-2 text-right">cost {fmt(totals.cost)}</td>
                <td className="p-2 text-right">₹{fmt(totals.bid)}</td><td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {ratePopup && (
        <Modal isOpen onClose={() => setRatePopup(null)} title="Rate history — this item">
          <RateHistory data={ratePopup.data} onApply={(v) => { edit(ratePopup.i, 'pp', v); setRatePopup(null); }} canEdit={canEdit} />
        </Modal>
      )}
    </div>
  );
}

function RateHistory({ data, onApply, canEdit }) {
  const s = data.six_month_stats;
  return (
    <div className="space-y-3 text-sm">
      <Row label="Last quoted to this client" v={data.last_for_client ? `₹${fmt(data.last_for_client.rate)} · ${fmtDate(data.last_for_client.created_at)}` : '—'} />
      <Row label="Last quoted (anyone)" v={data.last_overall ? `₹${fmt(data.last_overall.rate)} · ${data.last_overall.company_name || ''}` : '—'} />
      {s ? (
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-1">6-month rate ({s.count} quotes)</div>
          <div className="flex justify-between">
            <Apply label="Min" v={s.min} onApply={onApply} canEdit={canEdit} />
            <Apply label="Avg" v={s.avg} onApply={onApply} canEdit={canEdit} />
            <Apply label="Max" v={s.max} onApply={onApply} canEdit={canEdit} />
          </div>
        </div>
      ) : <div className="text-gray-400 text-xs">No 6-month history for this item.</div>}
      {canEdit && <p className="text-xs text-gray-400">Click a value to set it as this line's PP (material rate).</p>}
    </div>
  );
}
const Row = ({ label, v }) => <div className="flex justify-between"><span className="text-gray-500">{label}</span><b>{v}</b></div>;
const Apply = ({ label, v, onApply, canEdit }) => (
  <button disabled={!canEdit} onClick={() => onApply(v)} className={`text-center px-3 ${canEdit ? 'hover:bg-white rounded' : ''}`}>
    <div className="text-xs text-gray-400">{label}</div><div className="font-bold">₹{fmt(v)}</div>
  </button>
);

// ── Documents checklist ─────────────────────────────────────────────────────
function Documents({ t, reload, canEdit }) {
  const [docs, setDocs] = useState(t.documents || []);
  const [newName, setNewName] = useState('');
  useEffect(() => { setDocs(t.documents || []); }, [t.documents]);

  const setDoc = async (docId, patch) => {
    setDocs(p => p.map(d => d.id === docId ? { ...d, ...patch } : d));
    try { await api.put(`/tenders/documents/${docId}`, patch); } catch (e) { toast.error('Failed'); reload(); }
  };
  const add = async () => {
    if (!newName.trim()) return;
    try { await api.post(`/tenders/${t.id}/documents`, { doc_name: newName.trim() }); setNewName(''); reload(); } catch (e) { toast.error('Failed'); }
  };
  const del = async (docId) => { try { await api.delete(`/tenders/documents/${docId}`); reload(); } catch (e) { toast.error('Failed'); } };

  const done = docs.filter(d => d.status === 'attached' || d.status === 'na').length;
  return (
    <div className="space-y-3">
      <div className="text-sm text-gray-500">{done}/{docs.length} handled — attach or mark N.A. every required item before submitting.</div>
      <div className="card !p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 border-b bg-gray-50"><th className="p-2">Document</th><th className="p-2 w-64">Status</th><th className="p-2">Notes</th><th className="p-2"></th></tr></thead>
          <tbody>
            {docs.map(d => (
              <tr key={d.id} className="border-b">
                <td className="p-2">{d.doc_name}{d.required ? <span className="text-red-500"> *</span> : ''}</td>
                <td className="p-2">
                  <div className="flex gap-1">
                    {['pending', 'attached', 'na'].map(s => (
                      <button key={s} disabled={!canEdit} onClick={() => setDoc(d.id, { status: s })}
                        className={`px-2 py-1 rounded text-xs capitalize ${d.status === s ? (s === 'attached' ? 'bg-emerald-600 text-white' : s === 'na' ? 'bg-gray-500 text-white' : 'bg-amber-500 text-white') : 'bg-gray-100'}`}>
                        {s === 'na' ? 'N.A.' : s}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="p-2"><input className="input-compact w-full text-xs" defaultValue={d.notes || ''} disabled={!canEdit} onBlur={e => e.target.value !== (d.notes || '') && setDoc(d.id, { notes: e.target.value })} placeholder="ref / remark" /></td>
                <td className="p-2">{canEdit && <button className="text-gray-400 hover:text-red-600" onClick={() => del(d.id)}><FiTrash2 size={13} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <input className="input flex-1" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Add a custom document…" onKeyDown={e => e.key === 'Enter' && add()} />
          <button className="btn btn-secondary" onClick={add}><FiPlus /> Add</button>
        </div>
      )}
    </div>
  );
}

// ── Submission + result ─────────────────────────────────────────────────────
function Submission({ t, reload, canEdit, canApprove }) {
  const docsDone = (t.documents || []).filter(d => !d.required || d.status === 'attached' || d.status === 'na').length;
  const docsTotal = (t.documents || []).length;
  const submitted = ['submitted', 'won', 'lost', 'withdrawn'].includes(t.status);
  const [res, setRes] = useState({ result: 'won', our_rank: t.our_rank || '', l1_bidder: t.l1_bidder || '', l1_amount: t.l1_amount || '', result_notes: t.result_notes || '' });
  const S = (k, v) => setRes(p => ({ ...p, [k]: v }));

  const submit = async () => {
    try { await api.post(`/tenders/${t.id}/submit`); toast.success('Marked as submitted'); reload(); } catch (e) { toast.error('Failed'); }
  };
  const record = async () => {
    try { await api.post(`/tenders/${t.id}/result`, res); toast.success('Result recorded'); reload(); } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="card space-y-3">
        <h3 className="font-semibold flex items-center gap-2"><FiCheckCircle /> Pre-submission check</h3>
        <Row label="Priced lines" v={(t.items || []).length} />
        <Row label="Our bid value" v={`₹${fmt(t.bid_amount)}`} />
        <Row label="Documents handled" v={`${docsDone}/${docsTotal}`} />
        <Row label="EMD" v={t.emd_paid ? 'Paid' : `₹${fmt(t.emd_amount)} pending`} />
        {!submitted
          ? canEdit && <button className="btn btn-primary w-full" onClick={submit}><FiUploadCloud /> Mark as Submitted</button>
          : <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg p-2">Submitted{t.submitted_at ? ` on ${fmtDate(t.submitted_at)}` : ''}.</div>}
      </div>

      <div className="card space-y-3">
        <h3 className="font-semibold flex items-center gap-2"><FiDollarSign /> Record result (L1 / L2)</h3>
        {!canApprove && <p className="text-xs text-gray-400">Only users with approve rights can record the result.</p>}
        <div><label className="label">Outcome</label>
          <select className="input" value={res.result} disabled={!canApprove} onChange={e => S('result', e.target.value)}>
            <option value="won">Won</option><option value="lost">Lost</option><option value="withdrawn">Withdrawn</option>
          </select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Our Rank (L)</label><input type="number" className="input" value={res.our_rank} disabled={!canApprove} onChange={e => S('our_rank', e.target.value)} placeholder="1 = L1" /></div>
          <div><label className="label">L1 Amount</label><input type="number" className="input" value={res.l1_amount} disabled={!canApprove} onChange={e => S('l1_amount', e.target.value)} /></div>
        </div>
        <div><label className="label">L1 Bidder</label><input className="input" value={res.l1_bidder} disabled={!canApprove} onChange={e => S('l1_bidder', e.target.value)} /></div>
        <div><label className="label">Notes</label><textarea className="input" rows={2} value={res.result_notes} disabled={!canApprove} onChange={e => S('result_notes', e.target.value)} /></div>
        {canApprove && <button className="btn btn-success w-full" onClick={record}><FiAward /> Save Result</button>}
      </div>
    </div>
  );
}
