// Material Issue — storekeeper's phone-first screen (director ask,
// 2026-07-26). Morning: pick site + engineer, add items from live site-
// store stock, Issue → stock OUT + engineer push-notified to Accept.
// Evening: Returns tab lists reconciled slips (engineer filed DPR with
// used quantities) — storekeeper confirms the physical return, stock
// comes back IN, and any declared-vs-confirmed gap is flagged.

import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { FiPlus, FiMinus, FiTrash2, FiPackage, FiRotateCcw } from 'react-icons/fi';

export default function MaterialIssue() {
  const [tab, setTab] = useState('issue');
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [engineers, setEngineers] = useState([]);
  const [engineerId, setEngineerId] = useState('');
  const [stock, setStock] = useState([]);        // site store stock rows
  const [lines, setLines] = useState([]);        // [{item_master_id, item_name, uom, available, qty}]
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [slips, setSlips] = useState([]);        // returns tab

  useEffect(() => {
    api.get('/dpr/sites', { params: { all: 1 } }).then(r => setSites((r.data || []).filter(s => s.status === 'active'))).catch(() => {});
    api.get('/auth/users').then(r => setEngineers((r.data || []).filter(u => u.active !== 0))).catch(() => {
      // fallback: employees list if users endpoint shape differs
      setEngineers([]);
    });
  }, []);

  // Live stock for the picked site's store — what CAN be issued. Resolve
  // the site → its site_store warehouse via /inventory/summary (each
  // warehouse row carries site_id), then filter /inventory/stock by it.
  useEffect(() => {
    if (!siteId) { setStock([]); return; }
    api.get('/inventory/summary').then(r => {
      const wh = (r.data || []).find(w => w.type === 'site_store' && String(w.site_id) === String(siteId));
      if (!wh) { setStock([]); toast.error('This site has no site-store warehouse'); return; }
      api.get('/inventory/stock', { params: { warehouse_id: wh.id } })
        .then(rs => setStock((rs.data || []).filter(row => row.quantity > 0)))
        .catch(() => setStock([]));
    }).catch(() => setStock([]));
    setLines([]);
  }, [siteId]);

  const loadSlips = () => {
    api.get('/material-issues', { params: { status: 'reconciled' } }).then(r => setSlips(r.data || [])).catch(() => setSlips([]));
  };
  useEffect(() => { if (tab === 'returns') loadSlips(); }, [tab]);

  const addLine = (row) => {
    if (lines.some(l => l.item_master_id === row.item_master_id)) return;
    setLines(ls => [...ls, { item_master_id: row.item_master_id, item_name: row.item_name, uom: row.uom, available: row.quantity, qty: 1 }]);
    setSearch('');
  };
  const bump = (i, d) => setLines(ls => ls.map((l, x) => x === i
    ? { ...l, qty: Math.min(l.available, Math.max(1, l.qty + d)) } : l));

  const issue = async () => {
    if (!siteId || !engineerId) { toast.error('Pick site and engineer'); return; }
    if (!lines.length) { toast.error('Add at least one item'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/material-issues', {
        site_id: +siteId, issued_to: +engineerId,
        items: lines.map(l => ({ item_master_id: l.item_master_id, qty: l.qty })),
      });
      toast.success(`Issued — slip #${data.id}. Engineer notified.`);
      (data.low_stock_alerts || []).forEach(a => toast(`⚠ ${a.item_name} now at ${a.quantity} (ROL ${a.reorder_level})`, { icon: '📉', duration: 6000 }));
      setLines([]);
    } catch (e) { toast.error(e.response?.data?.error || 'Issue failed'); }
    finally { setBusy(false); }
  };

  const confirmReturn = async (slip) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/material-issues/${slip.id}/confirm-return`, {});
      if (data.variances?.length) {
        data.variances.forEach(v => toast.error(`Variance: ${v.item_name} declared ${v.declared}, received ${v.confirmed}`, { duration: 8000 }));
      } else {
        toast.success(`Slip #${slip.id} closed — returns back in stock`);
      }
      loadSlips();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusy(false); }
  };

  const filteredStock = stock.filter(r => !search || (r.item_name || '').toLowerCase().includes(search.toLowerCase()) || (r.item_code || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="max-w-lg mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-bold text-gray-800 flex items-center gap-1.5"><FiPackage className="text-indigo-500" /> Material Issue</h3>
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setTab('issue')} className={`btn text-sm ${tab === 'issue' ? 'btn-primary' : 'btn-secondary'}`}>Morning Issue</button>
          <button onClick={() => setTab('returns')} className={`btn text-sm ${tab === 'returns' ? 'btn-primary' : 'btn-secondary'}`}>Returns</button>
        </div>
      </div>

      {tab === 'issue' && (
        <>
          <div className="card p-3 space-y-2">
            <select className="select w-full" value={siteId} onChange={e => setSiteId(e.target.value)}>
              <option value="">-- Site --</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="select w-full" value={engineerId} onChange={e => setEngineerId(e.target.value)}>
              <option value="">-- Issue to (engineer) --</option>
              {engineers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>

          {siteId && (
            <div className="card p-3 space-y-2">
              <input className="input w-full text-sm" placeholder="Search site-store stock…" value={search} onChange={e => setSearch(e.target.value)} />
              {search && (
                <div className="max-h-44 overflow-y-auto divide-y divide-gray-50">
                  {filteredStock.slice(0, 12).map(r => (
                    <button key={r.id} type="button" onClick={() => addLine(r)} className="w-full text-left p-2 text-sm hover:bg-gray-50">
                      {r.item_name}
                      <span className="block text-[10px] text-gray-400">{r.item_code} · in stock: {r.quantity} {r.uom}</span>
                    </button>
                  ))}
                  {filteredStock.length === 0 && <p className="text-xs text-gray-400 p-2">No matching stock in this site's store.</p>}
                </div>
              )}
              {lines.map((l, i) => (
                <div key={l.item_master_id} className="border border-gray-100 rounded-xl p-2.5 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{l.item_name}</div>
                    <div className="text-[10px] text-gray-400">available: {l.available} {l.uom}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => bump(i, -1)} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center"><FiMinus size={15} /></button>
                    <span className="w-10 text-center font-bold">{l.qty}</span>
                    <button type="button" onClick={() => bump(i, +1)} className="w-9 h-9 rounded-full bg-indigo-600 text-white flex items-center justify-center"><FiPlus size={15} /></button>
                    <button type="button" onClick={() => setLines(ls => ls.filter((_, x) => x !== i))} className="p-1.5 text-gray-300 hover:text-red-500"><FiTrash2 size={14} /></button>
                  </div>
                </div>
              ))}
              {lines.length === 0 && <p className="text-xs text-gray-400 text-center py-2">Search and tap items to add them to the slip.</p>}
            </div>
          )}

          <button onClick={issue} disabled={busy || !lines.length} className="btn btn-primary w-full h-12 text-base font-bold">
            {busy ? 'Issuing…' : `Issue ${lines.length} item(s) →`}
          </button>
        </>
      )}

      {tab === 'returns' && (
        <div className="space-y-2">
          {slips.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No slips waiting for return confirmation.</div>}
          {slips.map(slip => (
            <div key={slip.id} className="card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Slip #{slip.id} — {slip.site_name}</div>
                <span className="text-[10px] text-gray-400">{slip.issue_date} · {slip.issued_to_name}</span>
              </div>
              {(slip.items || []).map(it => (
                <div key={it.id} className="flex items-center justify-between text-xs border-b border-gray-50 pb-1">
                  <span>{it.item_name}</span>
                  <span className="text-gray-500">issued {it.qty_issued} · used {it.qty_used ?? '—'} · <b className="text-emerald-700">return {it.qty_returned ?? '—'}</b></span>
                </div>
              ))}
              <button onClick={() => confirmReturn(slip)} disabled={busy}
                className="btn btn-secondary w-full flex items-center justify-center gap-1.5 text-sm">
                <FiRotateCcw size={14} /> Confirm return received (back to stock)
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
