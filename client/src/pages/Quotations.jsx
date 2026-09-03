import { useState, useEffect } from 'react';
import api from '../api';
import ResponsibilityTab from '../components/ResponsibilityTab';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../utils/datetime';

const blankRow = () => ({ description: '', quantity: 1, unit: 'nos', rate: 0, item_id: null, suggestion: null });

// ── Margin Chart editor (SOP-02 S5/S6, mam 2026-08-27) ──────────────────
// Fixed margin % per category (the chart) + the approval floor. Admin-only
// server-side; the Quote modal's category dropdown reads from here.
function MarginChartEditor({ chart, reload }) {
  const [floor, setFloor] = useState(chart.floor);
  // SOP-03 S3 discount chart: within auto → done; above → Sales Head; above md → MD sir.
  const [discAuto, setDiscAuto] = useState(chart.discount_auto);
  const [discMd, setDiscMd] = useState(chart.discount_md);
  const [cat, setCat] = useState('');
  const [pct, setPct] = useState('');
  useEffect(() => { setFloor(chart.floor); setDiscAuto(chart.discount_auto); setDiscMd(chart.discount_md); }, [chart.floor, chart.discount_auto, chart.discount_md]);
  const saveFloor = async () => {
    try {
      await api.post('/quotations/margin-chart', { floor: +floor || 0, discount_auto: +discAuto || 0, discount_md: +discMd || 0 });
      toast.success('Rules saved'); reload();
    }
    catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const addRow = async (e) => {
    e.preventDefault();
    if (!cat.trim()) return;
    try {
      await api.post('/quotations/margin-chart', { category: cat.trim(), margin_pct: +pct || 0 });
      toast.success('Saved'); setCat(''); setPct(''); reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const updateRow = async (r, newPct) => {
    try { await api.post('/quotations/margin-chart', { category: r.category, margin_pct: +newPct || 0 }); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  const delRow = async (r) => {
    if (!confirm(`Remove "${r.category}" from the margin chart?`)) return;
    try { await api.delete(`/quotations/margin-chart/${r.id}`); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };
  return (
    <div className="space-y-4">
      <div className="p-3 bg-amber-50 border border-amber-200 rounded space-y-2">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="label">Margin Floor %</label>
            <input type="number" className="input w-24" step="0.5" value={floor} onChange={e => setFloor(e.target.value)} />
          </div>
          <div>
            <label className="label">Discount OK up to %</label>
            <input type="number" className="input w-24" step="0.5" value={discAuto} onChange={e => setDiscAuto(e.target.value)} />
          </div>
          <div>
            <label className="label">MD sir above %</label>
            <input type="number" className="input w-24" step="0.5" value={discMd} onChange={e => setDiscMd(e.target.value)} />
          </div>
          <button onClick={saveFloor} className="btn btn-primary text-sm">Save Rules</button>
        </div>
        <p className="text-[11px] text-amber-800">
          Margin: at/above the floor a quote approves on its own; below it the Sales Head decides (SOP-02.6).
          Discount: within "OK up to" — done; above it — Sales Head; above the MD line — MD sir (SOP-03.3).
        </p>
      </div>
      <table className="w-full text-sm">
        <thead className="text-[10px] text-gray-500 uppercase bg-gray-50">
          <tr><th className="text-left p-2">Category</th><th className="text-center p-2 w-32">Margin %</th><th className="w-10"></th></tr>
        </thead>
        <tbody>
          {chart.rows.map(r => (
            <tr key={r.id} className="border-t">
              <td className="p-2 font-medium">{r.category}</td>
              <td className="text-center p-2">
                <input type="number" step="0.5" defaultValue={r.margin_pct} onBlur={e => +e.target.value !== r.margin_pct && updateRow(r, e.target.value)}
                  className="input text-center text-xs w-24 mx-auto" />
              </td>
              <td className="p-2"><button onClick={() => delRow(r)} className="text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button></td>
            </tr>
          ))}
          {chart.rows.length === 0 && <tr><td colSpan="3" className="text-center py-6 text-gray-400 text-xs">No categories yet — add the fixed margins below</td></tr>}
        </tbody>
      </table>
      <form onSubmit={addRow} className="flex items-end gap-2 border-t pt-3">
        <div className="flex-1"><label className="label">Category</label>
          <input className="input" placeholder="e.g. Fire Fighting / Electrical / Solar…" value={cat} onChange={e => setCat(e.target.value)} /></div>
        <div><label className="label">Margin %</label>
          <input type="number" step="0.5" className="input w-28" value={pct} onChange={e => setPct(e.target.value)} /></div>
        <button type="submit" className="btn btn-primary">Add</button>
      </form>
    </div>
  );
}

export default function Quotations() {
  const { canDelete, isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab(['boq', 'quotations', 'responsible'], 'boq');
  const [boqs, setBoqs] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [leads, setLeads] = useState([]);
  const [itemOptions, setItemOptions] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({});
  const [boqItems, setBoqItems] = useState([blankRow()]);

  useEffect(() => {
    api.get('/quotations/boq').then(r => setBoqs(r.data));
    api.get('/quotations').then(r => setQuotations(r.data));
    api.get('/leads').then(r => setLeads(r.data));
    api.get('/item-master/dropdown').then(r => setItemOptions(r.data));
  }, []);

  const reload = () => {
    api.get('/quotations/boq').then(r => setBoqs(r.data));
    api.get('/quotations').then(r => setQuotations(r.data));
  };

  const addBoqItem = () => setBoqItems([...boqItems, blankRow()]);

  // AI Agent: when an item is picked from the catalogue, fetch the
  // rate suggestion (last-quoted-to-this-client + 6-month stats) and
  // pre-fill the rate with the item_master current_price.
  const pickItem = async (rowIdx, item) => {
    const next = [...boqItems];
    if (!item) {
      next[rowIdx] = { ...next[rowIdx], item_id: null, suggestion: null };
      setBoqItems(next);
      return;
    }
    next[rowIdx] = {
      ...next[rowIdx],
      item_id: item.id,
      description: item.display_name,
      unit: item.uom || next[rowIdx].unit,
      rate: next[rowIdx].rate || item.current_price || 0,
    };
    setBoqItems(next);
    try {
      const params = { item_id: item.id };
      if (form.lead_id) params.lead_id = form.lead_id;
      const { data } = await api.get('/ai-agent/rate-suggestion', { params });
      setBoqItems(curr => {
        const c = [...curr];
        c[rowIdx] = { ...c[rowIdx], suggestion: data };
        return c;
      });
    } catch (e) { /* suggestion is best-effort */ }
  };

  const useSuggestedRate = (rowIdx, rate) => {
    const next = [...boqItems];
    next[rowIdx] = { ...next[rowIdx], rate };
    setBoqItems(next);
  };

  const createBoq = async (e) => {
    e.preventDefault();
    // Strip UI-only `suggestion` field before posting
    const items = boqItems.map(({ suggestion, ...rest }) => rest);
    await api.post('/quotations/boq', { ...form, items });
    toast.success('BOQ created');
    setModal(false);
    reload();
  };

  const createQuotation = async (e) => {
    e.preventDefault();
    await api.post('/quotations', form);
    toast.success('Quotation created');
    setModal(false);
    reload();
  };

  const updateQuotation = async (id, status) => {
    const q = quotations.find(x => x.id === id);
    try {
      const r = await api.put(`/quotations/${id}`, { ...q, status });
      // SOP-03 S4/S5: booking the order creates the ONE project record and
      // informs PM / Purchase / Accounts together.
      if (r.data.project) toast.success(`Order booked! Project record ${r.data.project.lead_no} created in Business Book — PM, Purchase & Accounts informed`, { duration: 7000 });
      else toast.success('Status updated');
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Update failed'); }
  };

  // SOP-03 S1: one tap per negotiation event — flips whose court the ball is in.
  const logNegotiation = async (id, side) => {
    try {
      await api.post(`/quotations/${id}/negotiation-log`, { side });
      toast.success(side === 'client' ? 'Client reply logged — ball is with US now' : 'Our reply logged — ball is with the CLIENT now');
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not log'); }
  };
  const decideDiscount = async (id, action) => {
    const reason = action === 'reject' ? (prompt('Reject reason (optional):') || '') : '';
    try {
      await api.post(`/quotations/${id}/discount-decision`, { action, reason });
      toast.success(action === 'approve' ? 'Discount approved' : 'Discount rejected');
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Decision failed'); }
  };

  // Quote-with-margin on a funnel BOQ row (mam 2026-08-27, SOP-02 F5-F7):
  // base = BOQ cost, margin % on top, optional quotation file upload.
  const [quoteFor, setQuoteFor] = useState(null);   // the funnel BOQ row being quoted
  const [quoteForm, setQuoteForm] = useState({ base_amount: 0, margin_pct: 10, category: '', quotation_file_link: '', valid_until: '' });
  const [quoteBusy, setQuoteBusy] = useState(false);
  // SOP-02 S5/S6: the fixed Margin Chart + floor — "margin chart, not guesswork".
  const [marginChart, setMarginChart] = useState({ rows: [], floor: 10 });
  const [chartOpen, setChartOpen] = useState(false);
  const loadChart = () => api.get('/quotations/margin-chart').then(r => setMarginChart(r.data)).catch(() => {});
  useEffect(() => { loadChart(); }, []);
  const openQuote = (b) => {
    setQuoteFor(b);
    setQuoteForm({ base_amount: +b.total_amount || 0, margin_pct: marginChart.floor ?? 10, category: '', quotation_file_link: '', valid_until: '' });
  };
  const pickCategory = (cat) => {
    const row = marginChart.rows.find(r => r.category === cat);
    setQuoteForm(f => ({ ...f, category: cat, margin_pct: row ? row.margin_pct : f.margin_pct }));
  };
  const uploadQuoteFile = async (file) => {
    if (!file) return;
    setQuoteBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setQuoteForm(f => ({ ...f, quotation_file_link: r.data.url }));
      toast.success('Quotation file uploaded');
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setQuoteBusy(false); }
  };
  const saveQuote = async (e) => {
    e.preventDefault();
    setQuoteBusy(true);
    try {
      const r = await api.post('/quotations/funnel-quote', { funnel_id: quoteFor.funnel_id, ...quoteForm });
      if (r.data.message) toast(r.data.message, { icon: '⏳', duration: 6000 });   // below-floor → Sales Head
      else toast.success(`${r.data.quotation_number} created — Rs ${r.data.final_amount.toLocaleString()}`);
      setQuoteFor(null);
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not create the quotation'); }
    finally { setQuoteBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="sticky-toolbar">
        <div className="flex gap-2">
          <button onClick={() => setTab('boq')} className={`btn ${tab === 'boq' ? 'btn-primary' : 'btn-secondary'}`}>BOQ / Drawings</button>
          <button onClick={() => setTab('quotations')} className={`btn ${tab === 'quotations' ? 'btn-primary' : 'btn-secondary'}`}>Quotations</button>
          <button onClick={() => setTab('responsible')} className={`btn ${tab === 'responsible' ? 'btn-primary' : 'btn-secondary'}`}>⚙ Responsible</button>
        </div>
      </div>

      {tab === 'responsible' && <ResponsibilityTab module="quotation" title="Quotation" />}

      {tab === 'boq' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-800">Bill of Quantities</h3>
            <div className="flex gap-2">
              <button onClick={() => exportCsv('boqs',
                ['Title','Client','Drawing','Total','Status','Date'],
                boqs.map(b => [b.title, b.company_name, b.drawing_required ? 'Yes' : 'No', b.total_amount, b.status, b.created_at]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              <button onClick={() => { setForm({ lead_id: '', title: '', drawing_required: false }); setBoqItems([blankRow()]); setModal('boq'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create BOQ</button>
            </div>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead><tr><th>Title</th><th>Client</th><th>Drawing</th><th>Total</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
              <tbody>
                {boqs.map(b => (
                  <tr key={b.id}>
                    <td className="font-medium">
                      {b.title}
                      {/* Sales-funnel BOQs listed alongside (mam 2026-08-27) —
                          first BOQ on a lead = FUNNEL, later additions = EXTRA. */}
                      {b.source === 'funnel' && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold align-middle">FUNNEL</span>}
                      {b.source === 'funnel_extra' && <span className="ml-2 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[9px] font-bold align-middle">EXTRA</span>}
                      {b.boq_file_link && (
                        <a href={b.boq_file_link} target="_blank" rel="noreferrer"
                           className="ml-2 text-blue-600 hover:underline text-[11px]">view file</a>
                      )}
                    </td>
                    <td>{b.company_name}</td>
                    <td>{b.drawing_required ? 'Yes' : 'No'}</td>
                    <td>Rs {b.total_amount?.toLocaleString()}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="text-gray-500">{fmtDate(b.created_at)}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        {/* Quote this funnel BOQ with margin (SOP-02 F5-F7) */}
                        {b.funnel_id && (
                          <button onClick={() => openQuote(b)}
                            className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 font-semibold"
                            title="Create a quotation from this BOQ — base amount + margin %">
                            ₹ Quote
                          </button>
                        )}
                        {(!b.source || b.source === 'boq') && canDelete('quotations') && <button onClick={async () => {
                          if (!confirm(`Delete BOQ "${b.title}"?`)) return;
                          try { await api.delete(`/quotations/boq/${b.id}`); toast.success('Deleted'); reload(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
                {boqs.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No BOQs yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'quotations' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-800">Quotations</h3>
            <div className="flex gap-2">
              {isAdmin() && (
                <button onClick={() => setChartOpen(true)} className="btn btn-secondary flex items-center gap-2"
                  title="Fixed margin % per category + the approval floor (SOP-02)">
                  ⚙ Margin Chart
                </button>
              )}
              <button onClick={() => exportCsv('quotations',
                ['Number','Client','Total','Discount','Final','Status','Valid Until'],
                quotations.map(q => [q.quotation_number, q.company_name, q.total_amount, q.discount, q.final_amount, q.status, q.valid_until]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              <button onClick={() => { setForm({ lead_id: '', boq_id: '', total_amount: 0, discount: 0, final_amount: 0, valid_until: '', notes: '' }); setModal('quotation'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Create Quotation</button>
            </div>
          </div>
          <div className="card p-0">
            <table className="freeze-head">
              <thead><tr><th>Number</th><th>Client</th><th>Total</th><th>Discount</th><th>Final</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {quotations.map(q => (
                  <tr key={q.id}>
                    <td className="font-medium">
                      {q.quotation_number}
                      {/* Funnel-uploaded quotations listed alongside (mam 2026-08-27) */}
                      {q.source === 'funnel' && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold align-middle">FUNNEL</span>}
                      {q.margin_pct != null && q.margin_pct !== 0 && (
                        <div className="text-[10px] text-indigo-600">margin {q.margin_pct}%</div>
                      )}
                      {q.quotation_file_link && (
                        <a href={q.quotation_file_link} target="_blank" rel="noreferrer"
                           className="ml-2 text-blue-600 hover:underline text-[11px]">view file</a>
                      )}
                      {/* SOP-03 S1 two clocks: days waited on each side, and
                          one-tap logging of who just replied. */}
                      {q.source !== 'funnel' && q.clock_client_days != null && (
                        <div className="flex items-center gap-1 mt-1 text-[10px]">
                          <span className={`px-1.5 py-0.5 rounded font-semibold ${q.clock_ball === 'client' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}
                            title="Days the ball has been in the CLIENT's court">client {q.clock_client_days}d</span>
                          <span className={`px-1.5 py-0.5 rounded font-semibold ${q.clock_ball === 'us' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}
                            title="Days the ball has been in OUR court">us {q.clock_us_days}d</span>
                          {!['accepted', 'rejected'].includes(q.status) && (
                            <>
                              <button onClick={() => logNegotiation(q.id, 'client')} className="text-blue-600 hover:underline" title="Log: the client just replied — ball comes to us">client replied</button>
                              <span className="text-gray-300">·</span>
                              <button onClick={() => logNegotiation(q.id, 'us')} className="text-blue-600 hover:underline" title="Log: we just replied / re-quoted — ball goes to the client">we replied</button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td>{q.company_name}</td>
                    <td>Rs {q.total_amount?.toLocaleString()}</td>
                    <td>Rs {q.discount?.toLocaleString()}</td>
                    <td className="font-semibold">Rs {q.final_amount?.toLocaleString()}</td>
                    <td>
                      <StatusBadge status={q.margin_approval === 'pending' ? 'pending_approval' : q.status} />
                      {/* SOP-03 S3 discount gate chip */}
                      {q.discount_approval === 'pending_sh' && <div className="text-[9px] font-bold text-amber-700 mt-0.5">DISC → SALES HEAD</div>}
                      {q.discount_approval === 'pending_md' && <div className="text-[9px] font-bold text-red-700 mt-0.5">DISC → MD SIR</div>}
                      {q.discount_approval === 'rejected' && <div className="text-[9px] font-bold text-red-700 mt-0.5">DISC REJECTED</div>}
                    </td>
                    <td>
                      {q.source === 'funnel' ? (
                        <span className="text-[11px] text-gray-400">from Sales Funnel</span>
                      ) : q.margin_approval === 'pending' ? (
                        // SOP-02 S6: below-floor margin — Sales Head decides.
                        <div className="flex gap-1 items-center">
                          <button onClick={async () => {
                            try { await api.post(`/quotations/${q.id}/margin-decision`, { action: 'approve' }); toast.success('Margin approved — quotation released'); reload(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Approve failed'); }
                          }} className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-semibold">✓ Approve</button>
                          <button onClick={async () => {
                            const reason = prompt('Reject reason (optional):') || '';
                            try { await api.post(`/quotations/${q.id}/margin-decision`, { action: 'reject', reason }); toast.success('Rejected'); reload(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Reject failed'); }
                          }} className="text-[11px] px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 font-semibold">✕ Reject</button>
                        </div>
                      ) : (q.discount_approval === 'pending_sh' || q.discount_approval === 'pending_md') ? (
                        // SOP-03 S3: above-chart discount — Sales Head / MD decides.
                        <div className="flex gap-1 items-center">
                          <span className="text-[10px] text-gray-500 mr-1">{q.discount_approval === 'pending_md' ? 'MD sir:' : 'Sales Head:'}</span>
                          <button onClick={() => decideDiscount(q.id, 'approve')} className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-semibold">✓ Approve</button>
                          <button onClick={() => decideDiscount(q.id, 'reject')} className="text-[11px] px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 font-semibold">✕ Reject</button>
                        </div>
                      ) : (
                        <div className="flex gap-2 items-center">
                          <select className="select w-32" value={q.status} onChange={e => updateQuotation(q.id, e.target.value)}>
                            {['draft','sent','negotiation','accepted','rejected'].map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                          {canDelete('quotations') && <button onClick={async () => {
                            if (!confirm(`Delete quotation "${q.quotation_number}"?`)) return;
                            try { await api.delete(`/quotations/${q.id}`); toast.success('Deleted'); reload(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                          }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {quotations.length === 0 && <tr><td colSpan="7" className="text-center py-8 text-gray-400">No quotations yet</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Margin Chart master (SOP-02 S5/S6): fixed margin % per category + floor */}
      <Modal isOpen={chartOpen} onClose={() => setChartOpen(false)} title="Margin Chart — fixed margins & floor">
        <MarginChartEditor chart={marginChart} reload={loadChart} />
      </Modal>

      {/* Quote-with-margin modal (mam 2026-08-27): base BOQ cost × (1 + margin%) */}
      <Modal isOpen={!!quoteFor} onClose={() => setQuoteFor(null)} title={`Quotation with Margin — ${quoteFor?.company_name || ''}`}>
        {quoteFor && (
          <form onSubmit={saveQuote} className="space-y-3">
            <p className="text-xs text-gray-500">
              From <b>{quoteFor.title}</b>{quoteFor.boq_file_link && <> · <a className="text-blue-600 underline" href={quoteFor.boq_file_link} target="_blank" rel="noreferrer">open BOQ file</a></>}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">BOQ Base Amount (Rs) *</label>
                <input type="number" className="input" required min="1" value={quoteForm.base_amount}
                  onChange={e => setQuoteForm(f => ({ ...f, base_amount: +e.target.value }))} />
              </div>
              <div>
                <label className="label">Category <span className="text-gray-400 font-normal">(margin chart)</span></label>
                <select className="select" value={quoteForm.category} onChange={e => pickCategory(e.target.value)}>
                  <option value="">— manual margin —</option>
                  {marginChart.rows.map(r => <option key={r.id} value={r.category}>{r.category} · {r.margin_pct}%</option>)}
                </select>
              </div>
              <div>
                <label className="label">Margin %</label>
                <input type="number" className="input" step="0.5" value={quoteForm.margin_pct}
                  onChange={e => setQuoteForm(f => ({ ...f, margin_pct: +e.target.value, category: '' }))} />
                {quoteForm.margin_pct < (marginChart.floor ?? 0)
                  ? <p className="text-[11px] text-amber-700 mt-1 font-semibold">⏳ Below the {marginChart.floor}% floor — will go to the Sales Head for approval</p>
                  : <p className="text-[11px] text-emerald-700 mt-1">✓ At/above the {marginChart.floor}% floor — approves on its own</p>}
              </div>
              <div>
                <label className="label">Quote Amount</label>
                <div className="input bg-gray-50 font-bold text-emerald-700">
                  Rs {Math.round((quoteForm.base_amount || 0) * (1 + (quoteForm.margin_pct || 0) / 100)).toLocaleString()}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Quotation File (optional)</label>
                <input type="file" className="input text-xs" onChange={e => uploadQuoteFile(e.target.files?.[0])} />
                {quoteForm.quotation_file_link && <p className="text-[11px] text-emerald-700 mt-1">✓ file attached</p>}
              </div>
              <div>
                <label className="label">Valid Until (optional)</label>
                <input type="date" className="input" value={quoteForm.valid_until}
                  onChange={e => setQuoteForm(f => ({ ...f, valid_until: e.target.value }))} />
              </div>
            </div>
            <p className="text-[11px] text-gray-400">Saves a quotation here AND stamps the Sales Funnel lead's quotation stage (number, amount, file, date).</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setQuoteFor(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={quoteBusy} className="btn btn-primary">{quoteBusy ? 'Saving…' : 'Create Quotation'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* BOQ Modal */}
      <Modal isOpen={modal === 'boq'} onClose={() => setModal(false)} title="Create BOQ" wide>
        <form onSubmit={createBoq} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Lead / Client</label>
              <select className="select" value={form.lead_id} onChange={e => setForm({...form, lead_id: e.target.value})}>
                <option value="">Select</option>
                {leads.map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
              </select>
            </div>
            <div><label className="label">Title *</label><input className="input" value={form.title || ''} onChange={e => setForm({...form, title: e.target.value})} required /></div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.drawing_required} onChange={e => setForm({...form, drawing_required: e.target.checked})} /> Drawing Required
          </label>
          <div className="flex items-baseline justify-between">
            <h4 className="font-semibold text-sm">Items</h4>
            <span className="text-xs text-gray-400">AI suggests rates based on past quotations</span>
          </div>
          {boqItems.map((item, i) => (
            <div key={i} className="space-y-2 border border-gray-100 rounded p-2 bg-gray-50">
              {/* Mobile-first layout: stacks on phone, single-row on desktop.
                  Was qty/unit/rate at col-span-1/1/2 of 12 → all three
                  fields disappeared on phone. */}
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 md:col-span-5">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">BOQ Item</div>
                  <SearchableSelect
                    options={itemOptions}
                    value={item.item_id}
                    valueKey="id"
                    displayKey="display_name"
                    placeholder="Pick from Item Master (or type description below)"
                    onChange={opt => pickItem(i, opt)}
                  />
                </div>
                <div className="col-span-12 md:col-span-3">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Description</div>
                  <input className="input" placeholder="Description (auto-filled or free text)"
                    value={item.description}
                    onChange={e => { const n = [...boqItems]; n[i].description = e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-4 md:col-span-1">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Qty</div>
                  {/* `|| ''` lets backspace clear the field instead of
                      snapping back to 0 (mam 2026-05-25). */}
                  <input className="input" type="number" placeholder="Qty" value={item.quantity || ''}
                    onChange={e => { const n = [...boqItems]; n[i].quantity = +e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-3 md:col-span-1">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Unit</div>
                  <input className="input" placeholder="Unit" value={item.unit}
                    onChange={e => { const n = [...boqItems]; n[i].unit = e.target.value; setBoqItems(n); }} />
                </div>
                <div className="col-span-5 md:col-span-2">
                  <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Rate</div>
                  {/* `|| ''` keeps backspace from snapping to 0 (mam 2026-05-25). */}
                  <input className="input" type="number" placeholder="Rate" value={item.rate || ''}
                    onChange={e => { const n = [...boqItems]; n[i].rate = +e.target.value; setBoqItems(n); }} />
                </div>
              </div>
              {item.suggestion && (item.suggestion.last_for_client || item.suggestion.last_overall) && (
                <RateSuggestion data={item.suggestion} onUse={r => useSuggestedRate(i, r)} />
              )}
            </div>
          ))}
          <button type="button" onClick={addBoqItem} className="btn btn-secondary text-xs">+ Add Item</button>
          <div className="text-right font-semibold">Total: Rs {boqItems.reduce((s, i) => s + i.quantity * i.rate, 0).toLocaleString()}</div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create BOQ</button>
          </div>
        </form>
      </Modal>

      {/* Quotation Modal */}
      <Modal isOpen={modal === 'quotation'} onClose={() => setModal(false)} title="Create Quotation">
        <form onSubmit={createQuotation} className="space-y-4">
          <div>
            <label className="label">Lead / Client</label>
            <select className="select" value={form.lead_id} onChange={e => setForm({...form, lead_id: e.target.value})}>
              <option value="">Select</option>
              {leads.map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">BOQ Reference</label>
            <select className="select" value={form.boq_id} onChange={e => setForm({...form, boq_id: e.target.value})}>
              <option value="">Select</option>
              {/* Native BOQs only — funnel reference rows can't back a quotation. */}
              {boqs.filter(b => !b.source || b.source === 'boq').map(b => <option key={b.id} value={b.id}>{b.title} - Rs {b.total_amount?.toLocaleString()}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div><label className="label">Total Amount</label><input className="input" type="number" value={form.total_amount} onChange={e => setForm({...form, total_amount: +e.target.value, final_amount: +e.target.value - (form.discount || 0)})} /></div>
            <div><label className="label">Discount</label><input className="input" type="number" value={form.discount} onChange={e => setForm({...form, discount: +e.target.value, final_amount: (form.total_amount || 0) - +e.target.value})} /></div>
            <div><label className="label">Final Amount</label><input className="input" type="number" value={form.final_amount} readOnly /></div>
          </div>
          <div><label className="label">Valid Until</label><input className="input" type="date" value={form.valid_until} onChange={e => setForm({...form, valid_until: e.target.value})} /></div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// AI Agent rate suggestion: shows last-quoted-to-this-client and the
// 6-month avg/low/high across all clients, with one-click "use" buttons
// so mam's team quotes consistently and never undersells by accident.
function RateSuggestion({ data, onUse }) {
  const { last_for_client, last_overall, six_month_stats, company_name } = data;
  const fmt = (n) => 'Rs ' + Math.round(n).toLocaleString();
  const ago = (iso) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  };

  return (
    <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs space-y-1">
      <div className="font-semibold text-blue-900 flex items-center gap-1">
        <span>AI rate suggestion</span>
      </div>
      {last_for_client && company_name && (
        <div className="flex items-center justify-between">
          <span>
            Last quoted to <span className="font-medium">{company_name}</span>:{' '}
            <span className="font-semibold text-blue-900">{fmt(last_for_client.rate)}</span>{' '}
            <span className="text-gray-500">· {ago(last_for_client.created_at)}{last_for_client.created_by_name ? ` · ${last_for_client.created_by_name}` : ''}</span>
          </span>
          <button type="button" onClick={() => onUse(last_for_client.rate)}
            className="text-blue-700 hover:bg-blue-100 px-2 py-0.5 rounded text-xs font-medium">Use this</button>
        </div>
      )}
      {!last_for_client && last_overall && (
        <div className="flex items-center justify-between">
          <span>
            Last quoted (any client): <span className="font-semibold text-blue-900">{fmt(last_overall.rate)}</span>{' '}
            <span className="text-gray-500">· {ago(last_overall.created_at)}{last_overall.company_name ? ` · ${last_overall.company_name}` : ''}</span>
          </span>
          <button type="button" onClick={() => onUse(last_overall.rate)}
            className="text-blue-700 hover:bg-blue-100 px-2 py-0.5 rounded text-xs font-medium">Use this</button>
        </div>
      )}
      {six_month_stats && (
        <div className="text-gray-600">
          Last 6 months ({six_month_stats.count} {six_month_stats.count === 1 ? 'quote' : 'quotes'}):
          {' '}avg <span className="font-medium text-gray-900">{fmt(six_month_stats.avg)}</span>
          {' '}· low <span className="font-medium text-gray-900">{fmt(six_month_stats.min)}</span>
          {' '}· high <span className="font-medium text-gray-900">{fmt(six_month_stats.max)}</span>
        </div>
      )}
    </div>
  );
}
