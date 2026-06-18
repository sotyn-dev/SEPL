// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18).
// Mirrors the "Cash Flow June-2026.xlsx": AR (expected receipts by party ×
// week), AP (expected payments by party × week) and a Summary that nets each
// week into a running balance. Amounts are in LAKHS (₹L).
//
// The key rule: changing an amount or a date is blocked until a remark is
// entered, and every change lands in a searchable, exportable Change Log.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime } from '../utils/datetime';
import { exportCsv } from '../utils/exportCsv';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiUpload, FiClipboard, FiTrendingUp, FiTrendingDown, FiBarChart2, FiClock } from 'react-icons/fi';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtCol = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]} ${MONTHS[+m[2] - 1]}` : (d || ''); };
const fmtL = (n) => (n == null || n === '' ? '' : (+n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
const STATUSES = ['planned', 'partial', 'done', 'cancelled'];
const eff = (r) => (r.actual != null && r.actual !== '' ? +r.actual : +r.planned || 0);

export default function ArApTracker() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [tab, setTab] = useState('ar');                 // ar | ap | summary | log
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState({ rows: [], totals: {} });
  const [log, setLog] = useState([]);
  const [logSearch, setLogSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);          // original row when editing
  const [form, setForm] = useState({});
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/ar-ap-tracker').then(r => setEntries(r.data || [])).catch(() => {});
    api.get('/ar-ap-tracker/summary').then(r => setSummary(r.data || { rows: [], totals: {} })).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'log') return;
    api.get('/ar-ap-tracker/changelog', { params: { search: logSearch || undefined } })
      .then(r => setLog(r.data || [])).catch(() => {});
  }, [tab, logSearch]);

  const kind = tab === 'ap' ? 'AP' : 'AR';
  const rows = useMemo(() => entries.filter(e => e.kind === kind), [entries, kind]);

  // Pivot: party rows × date columns, cell = sum of effective amounts.
  const pivot = useMemo(() => {
    const dates = [...new Set(rows.map(r => r.due_date))].sort();
    const parties = [...new Set(rows.map(r => r.party))].sort();
    const cell = {};
    for (const r of rows) cell[`${r.party}|${r.due_date}`] = (cell[`${r.party}|${r.due_date}`] || 0) + eff(r);
    const colTot = Object.fromEntries(dates.map(d => [d, parties.reduce((s, p) => s + (cell[`${p}|${d}`] || 0), 0)]));
    const rowTot = Object.fromEntries(parties.map(p => [p, dates.reduce((s, d) => s + (cell[`${p}|${d}`] || 0), 0)]));
    const grand = dates.reduce((s, d) => s + colTot[d], 0);
    return { dates, parties, cell, colTot, rowTot, grand };
  }, [rows]);

  const openAdd = () => { setEditing(null); setForm({ kind, party: '', due_date: '', planned: '', actual: '', status: 'planned', note: '', remark: '' }); setModal(true); };
  const openEdit = (r) => { setEditing(r); setForm({ ...r, planned: r.planned ?? '', actual: r.actual ?? '', remark: '' }); setModal(true); };

  // Client-side mirror of the server's rule so the user gets instant feedback.
  const amountOrDateChanged = () => editing && (
    (+form.planned || 0) !== (+editing.planned || 0) ||
    (form.actual === '' ? null : +form.actual) !== (editing.actual == null ? null : +editing.actual) ||
    form.due_date !== editing.due_date
  );

  const save = async (e) => {
    e.preventDefault();
    if (!form.party?.trim()) return toast.error('Party is required');
    if (!form.due_date) return toast.error('Date is required');
    if (editing && amountOrDateChanged() && (!form.remark || form.remark.trim().length < 3)) {
      return toast.error('Enter a remark (min 3 chars) to change an amount or date.');
    }
    try {
      if (editing) await api.put(`/ar-ap-tracker/${editing.id}`, form);
      else await api.post('/ar-ap-tracker', form);
      toast.success(editing ? 'Updated' : 'Added');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (r) => {
    const remark = window.prompt(`Delete ${r.kind} · ${r.party} · ${fmtCol(r.due_date)} (₹${fmtL(eff(r))}L)?\n\nEnter a reason (required):`);
    if (remark == null) return;
    if (remark.trim().length < 3) return toast.error('A reason (min 3 chars) is required to delete.');
    try { await api.delete(`/ar-ap-tracker/${r.id}`, { data: { remark: remark.trim() } }); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Upload the Cash-Flow workbook — server parses both sheets, matches AR
  // parties to Business Book clients and AP parties to Vendors, and upserts.
  const doImport = async (file) => {
    if (!file) return;
    setImporting(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/ar-ap-tracker/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(r.data);
      toast.success(`Imported ${r.data.imported} new · ${r.data.updated} updated · ${r.data.matched}/${r.data.total} matched`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Import failed'); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  // Bulk paste — send the textarea + active kind to the same matching/upsert.
  const doBulk = async () => {
    if (!bulkText.trim()) return toast.error('Paste some rows first');
    setBulkBusy(true);
    try {
      const r = await api.post('/ar-ap-tracker/bulk', { kind, text: bulkText });
      setBulkOpen(false); setBulkText(''); setImportResult(r.data);
      toast.success(`Added ${r.data.imported} · updated ${r.data.updated}`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Bulk add failed'); }
    finally { setBulkBusy(false); }
  };

  const exportLog = () => exportCsv('arap-change-log',
    ['When (IST)', 'User', 'Kind', 'Party', 'Field', 'Old', 'New', 'Remark'],
    log.map(l => [fmtDateTime(l.changed_at), l.changed_by_name, l.kind, l.party, l.field, l.old_value, l.new_value, l.remark]));

  const TABS = [
    { k: 'ar', label: 'Receivables (AR)', icon: FiTrendingUp },
    { k: 'ap', label: 'Payables (AP)', icon: FiTrendingDown },
    { k: 'summary', label: 'Summary', icon: FiBarChart2 },
    { k: 'log', label: 'Change Log', icon: FiClock },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiBarChart2 className="text-blue-700" /> AR / AP Tracker</h1>
          <p className="text-sm text-gray-500">Rolling weekly cash-flow forecast · amounts in ₹ Lakhs · every amount/date edit needs a remark</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {canCreate('ar_ap_tracker') && (
            <>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => doImport(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={importing} className="btn btn-secondary flex items-center gap-2" title="Upload the Cash-Flow Excel — AR matched to Business Book clients, AP to Vendors">
                <FiUpload /> {importing ? 'Importing…' : 'Import Excel'}
              </button>
            </>
          )}
          {(tab === 'ar' || tab === 'ap') && canCreate('ar_ap_tracker') && (
            <button onClick={() => setBulkOpen(true)} className="btn btn-secondary flex items-center gap-2" title="Paste many rows at once"><FiClipboard /> Bulk {kind}</button>
          )}
          {(tab === 'ar' || tab === 'ap') && canCreate('ar_ap_tracker') && (
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add {kind}</button>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${tab === t.k ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 border'}`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── AR / AP : grid + list ──────────────────────────────── */}
      {(tab === 'ar' || tab === 'ap') && (
        <>
          <div className="card p-0 overflow-x-auto">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase border-b">Forecast grid — party × week (₹L)</div>
            {pivot.parties.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">No {kind} entries yet. Click “Add {kind}”.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-3 py-2 sticky left-0 bg-gray-50">Party</th>
                    {pivot.dates.map(d => <th key={d} className="px-2 py-2 text-right whitespace-nowrap">{fmtCol(d)}</th>)}
                    <th className="px-3 py-2 text-right font-bold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pivot.parties.map(p => (
                    <tr key={p} className="border-t hover:bg-blue-50/40">
                      <td className="px-3 py-1.5 font-medium sticky left-0 bg-white">{p}</td>
                      {pivot.dates.map(d => <td key={d} className="px-2 py-1.5 text-right text-gray-700">{pivot.cell[`${p}|${d}`] ? fmtL(pivot.cell[`${p}|${d}`]) : <span className="text-gray-300">·</span>}</td>)}
                      <td className="px-3 py-1.5 text-right font-bold">{fmtL(pivot.rowTot[p])}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 bg-gray-50 font-bold">
                    <td className="px-3 py-2 sticky left-0 bg-gray-50">Total</td>
                    {pivot.dates.map(d => <td key={d} className="px-2 py-2 text-right">{fmtL(pivot.colTot[d])}</td>)}
                    <td className="px-3 py-2 text-right text-blue-700">{fmtL(pivot.grand)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-0 overflow-x-auto">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase border-b">Entries</div>
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-3 py-2">Party</th><th className="text-left px-3 py-2">Week</th>
                <th className="text-right px-3 py-2">Planned</th><th className="text-right px-3 py-2">Actual</th>
                <th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">Note</th><th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No entries.</td></tr>}
                {rows.map(r => (
                  <tr key={r.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">{r.party}</td>
                    <td className="px-3 py-2">{fmtCol(r.due_date)}</td>
                    <td className="px-3 py-2 text-right">{fmtL(r.planned)}</td>
                    <td className="px-3 py-2 text-right">{r.actual == null || r.actual === '' ? <span className="text-gray-300">—</span> : <b className="text-emerald-700">{fmtL(r.actual)}</b>}</td>
                    <td className="px-3 py-2"><span className="text-[11px] px-2 py-0.5 rounded bg-gray-100">{r.status}</span></td>
                    <td className="px-3 py-2 text-gray-500 text-xs max-w-[180px] truncate" title={r.note || ''}>{r.note}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canEdit('ar_ap_tracker') && <button onClick={() => openEdit(r)} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><FiEdit2 size={14} /></button>}
                      {canDelete('ar_ap_tracker') && <button onClick={() => del(r)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Delete"><FiTrash2 size={14} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Summary : per-week AR / AP / net / running balance ──── */}
      {tab === 'summary' && (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-500 uppercase">
              <th className="text-left px-4 py-2">Week</th><th className="text-right px-4 py-2">AR (in)</th>
              <th className="text-right px-4 py-2">AP (out)</th><th className="text-right px-4 py-2">Net</th>
              <th className="text-right px-4 py-2">Running balance</th>
            </tr></thead>
            <tbody>
              {summary.rows.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-gray-400">No data yet.</td></tr>}
              {summary.rows.map(d => (
                <tr key={d.date} className="border-t">
                  <td className="px-4 py-2 font-medium">{fmtCol(d.date)}</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{fmtL(d.ar)}</td>
                  <td className="px-4 py-2 text-right text-red-600">{fmtL(d.ap)}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${d.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{d.net < 0 ? '(' + fmtL(-d.net) + ')' : fmtL(d.net)}</td>
                  <td className={`px-4 py-2 text-right font-bold ${d.balance < 0 ? 'text-red-700' : 'text-blue-700'}`}>{d.balance < 0 ? '(' + fmtL(-d.balance) + ')' : fmtL(d.balance)}</td>
                </tr>
              ))}
              {summary.rows.length > 0 && (
                <tr className="border-t-2 bg-gray-50 font-bold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right text-emerald-700">{fmtL(summary.totals.ar)}</td>
                  <td className="px-4 py-2 text-right text-red-600">{fmtL(summary.totals.ap)}</td>
                  <td className="px-4 py-2 text-right">{fmtL(summary.totals.net)}</td>
                  <td className="px-4 py-2"></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Change Log : searchable + CSV export ───────────────── */}
      {tab === 'log' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input className="input max-w-xs" placeholder="Search party / remark / user…" value={logSearch} onChange={e => setLogSearch(e.target.value)} />
            <button onClick={exportLog} className="btn flex items-center gap-2 border"><FiDownload size={14} /> Export CSV</button>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50 text-gray-500 uppercase">
                <th className="text-left px-3 py-2">When (IST)</th><th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Kind</th><th className="text-left px-3 py-2">Party</th>
                <th className="text-left px-3 py-2">Field</th><th className="text-left px-3 py-2">Change</th>
                <th className="text-left px-3 py-2">Remark</th>
              </tr></thead>
              <tbody>
                {log.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No changes logged.</td></tr>}
                {log.map(l => (
                  <tr key={l.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{fmtDateTime(l.changed_at)}</td>
                    <td className="px-3 py-2">{l.changed_by_name}</td>
                    <td className="px-3 py-2">{l.kind}</td>
                    <td className="px-3 py-2 font-medium">{l.party}</td>
                    <td className="px-3 py-2">{l.field}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><span className="text-red-500 line-through">{l.old_value || '∅'}</span> → <span className="text-emerald-700 font-semibold">{l.new_value || '∅'}</span></td>
                    <td className="px-3 py-2 text-gray-700">{l.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Add / Edit modal ───────────────────────────────────── */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? `Edit ${kind} entry` : `Add ${kind} entry`}>
        <form onSubmit={save} className="space-y-3">
          <div><label className="label">Party *</label><input className="input" value={form.party || ''} onChange={e => setForm({ ...form, party: e.target.value })} placeholder="e.g. SBJ, sael, Salaries…" required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Week / Date *</label><input type="date" className="input" value={form.due_date || ''} onChange={e => setForm({ ...form, due_date: e.target.value })} required /></div>
            <div><label className="label">Status</label><select className="select" value={form.status || 'planned'} onChange={e => setForm({ ...form, status: e.target.value })}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
            <div><label className="label">Planned (₹L)</label><input type="number" step="0.01" className="input" value={form.planned ?? ''} onChange={e => setForm({ ...form, planned: e.target.value })} /></div>
            <div><label className="label">Actual (₹L)</label><input type="number" step="0.01" className="input" value={form.actual ?? ''} onChange={e => setForm({ ...form, actual: e.target.value })} placeholder="once realised" /></div>
          </div>
          <div><label className="label">Note</label><input className="input" value={form.note || ''} onChange={e => setForm({ ...form, note: e.target.value })} /></div>
          {editing && (
            <div>
              <label className="label">Remark {amountOrDateChanged() ? <span className="text-red-600">* required (amount/date changed)</span> : <span className="text-gray-400 font-normal normal-case">(logged with this change)</span>}</label>
              <textarea className="input" rows="2" value={form.remark || ''} onChange={e => setForm({ ...form, remark: e.target.value })} placeholder="Why is this changing?" />
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="submit" className="btn btn-primary flex-1">{editing ? 'Save changes' : 'Add entry'}</button>
            <button type="button" onClick={() => setModal(false)} className="btn border">Cancel</button>
          </div>
        </form>
      </Modal>

      {/* ── Bulk paste ─────────────────────────────────────────── */}
      <Modal isOpen={bulkOpen} onClose={() => setBulkOpen(false)} title={`Bulk add ${kind} entries`}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">One entry per line — <b>party, date, amount</b>. Date as <b>DD-MM</b> (e.g. 17-06) or YYYY-MM-DD. Added as <b>{kind}</b>; start a line with <code>AR,</code> or <code>AP,</code> to override. Tab- or comma-separated both work (you can paste from Excel).</p>
          <textarea className="input font-mono text-xs" rows="10" value={bulkText} onChange={e => setBulkText(e.target.value)}
            placeholder={`SBJ, 17-06, 15\nsael, 24-06, 8.44\njmh PI, 17-06, 40`} />
          <div className="flex gap-2">
            <button onClick={doBulk} disabled={bulkBusy} className="btn btn-primary flex-1">{bulkBusy ? 'Adding…' : `Add ${kind} rows`}</button>
            <button onClick={() => setBulkOpen(false)} className="btn border">Cancel</button>
          </div>
        </div>
      </Modal>

      {/* ── Import result ──────────────────────────────────────── */}
      <Modal isOpen={!!importResult} onClose={() => setImportResult(null)} title="Import result">
        {importResult && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-emerald-50 rounded p-2 text-center"><div className="text-lg font-bold text-emerald-700">{importResult.imported}</div><div className="text-[11px] text-gray-500">New</div></div>
              <div className="bg-blue-50 rounded p-2 text-center"><div className="text-lg font-bold text-blue-700">{importResult.updated}</div><div className="text-[11px] text-gray-500">Updated</div></div>
              <div className="bg-amber-50 rounded p-2 text-center"><div className="text-lg font-bold text-amber-700">{importResult.matched}/{importResult.total}</div><div className="text-[11px] text-gray-500">Name-matched</div></div>
            </div>
            <div className="text-xs text-gray-500">AR rows: {importResult.byKind?.AR ?? 0} · AP rows: {importResult.byKind?.AP ?? 0}</div>
            {importResult.unmatched?.length > 0 ? (
              <div>
                <div className="font-semibold text-amber-700 mb-1">Not matched to a Business Book client / Vendor ({importResult.unmatched.length}):</div>
                <div className="max-h-48 overflow-y-auto border rounded p-2 bg-amber-50/40 text-xs space-y-0.5">
                  {importResult.unmatched.map((u, i) => <div key={i}>• {u}</div>)}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">Imported under the sheet's own name. Add these to Business Book / Vendors (or rename to match) and re-import to link them.</p>
              </div>
            ) : <div className="text-emerald-700 text-xs">✓ Every party matched a client / vendor.</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
