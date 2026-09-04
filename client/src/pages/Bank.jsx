// BANK module (mam 2026-08-31): "payment received and payment out from bank
// come here — one bank module". Tabs: Transactions (IN green / OUT red with
// match status), Import Statement (PNB / HDFC CSV or Excel), Accounts.
// Phase 2 (Account Aggregator auto-sync) feeds the same table when TSP keys
// arrive — the card on the Import tab explains the status to management.
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';

const fmt = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const MATCH_LABEL = { collection: '✅ Collection', payment: '✅ Payment', cheque: '✅ Cheque', manual: '✅ Manual' };

export default function Bank() {
  const [tab, setTab] = useUrlTab(['txns', 'import', 'accounts'], 'txns');
  const [accounts, setAccounts] = useState([]);
  const [summary, setSummary] = useState(null);
  const loadAccounts = useCallback(() => {
    api.get('/bank/accounts').then(r => setAccounts(r.data)).catch(() => {});
    api.get('/bank/summary').then(r => setSummary(r.data)).catch(() => {});
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">🏦 Bank</h1>
        <span className="text-xs text-gray-500">Money in &amp; money out — PNB / HDFC in one place</span>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="text-xs text-green-700">This month IN</div>
            <div className="text-lg font-bold text-green-700">{fmt(summary.month_in)}</div>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="text-xs text-red-700">This month OUT</div>
            <div className="text-lg font-bold text-red-700">{fmt(summary.month_out)}</div>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="text-xs text-blue-700">Matched</div>
            <div className="text-lg font-bold text-blue-700">{summary.matched}</div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="text-xs text-amber-700">Unmatched</div>
            <div className="text-lg font-bold text-amber-700">{summary.unmatched}</div>
          </div>
        </div>
      )}

      <div className="flex gap-2 border-b overflow-x-auto">
        {[['txns', '📒 Transactions'], ['import', '⬆️ Import Statement'], ['accounts', '🏛️ Accounts']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === k ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-gray-500'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'txns' && <Transactions accounts={accounts} onChanged={loadAccounts} />}
      {tab === 'import' && <ImportTab accounts={accounts} onDone={() => { loadAccounts(); setTab('txns'); }} />}
      {tab === 'accounts' && <AccountsTab accounts={accounts} onChanged={loadAccounts} />}
    </div>
  );
}

function Transactions({ accounts, onChanged }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/bank/transactions', { params: { page, account_id: accountId || undefined, status: status !== 'all' ? status : undefined, q: q || undefined } })
      .then(r => { setRows(r.data.rows); setTotal(r.data.total); }).catch(() => {});
  }, [page, accountId, status, q]);
  useEffect(() => { load(); }, [load]);

  const runAutoMatch = async () => {
    setBusy(true);
    try {
      const r = await api.post('/bank/auto-match');
      alert(`Auto-matched ${r.data.matched} transaction(s)`);
      load(); onChanged();
    } catch (e) { alert(e.response?.data?.error || 'Failed'); }
    setBusy(false);
  };

  const unmatch = async (id) => {
    await api.put(`/bank/transactions/${id}/match`, {});
    load(); onChanged();
  };
  const markManual = async (id) => {
    const note = prompt('Match note (what is this payment for?)');
    if (note == null) return;
    await api.put(`/bank/transactions/${id}/match`, { matched_type: 'manual', note });
    load(); onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={accountId} onChange={e => { setAccountId(e.target.value); setPage(1); }} className="border rounded px-2 py-1.5 text-sm">
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.bank_name}{a.account_last4 ? ` ••${a.account_last4}` : ''}</option>)}
        </select>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="border rounded px-2 py-1.5 text-sm">
          <option value="all">All</option>
          <option value="unmatched">Unmatched only</option>
          <option value="matched">Matched only</option>
        </select>
        <input value={q} onChange={e => { setQ(e.target.value); setPage(1); }} placeholder="Search narration / UTR…"
          className="border rounded px-2 py-1.5 text-sm flex-1 min-w-[160px]" />
        <button onClick={runAutoMatch} disabled={busy}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded disabled:opacity-50">
          {busy ? 'Matching…' : '⚡ Auto-match'}
        </button>
      </div>

      {rows.length === 0 && (
        <div className="text-center text-gray-500 py-10 text-sm">
          No transactions yet — go to <b>Import Statement</b> and upload the bank's CSV/Excel export.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto border rounded-lg">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-2 py-2 text-left">Date</th>
                <th className="px-2 py-2 text-left">Bank</th>
                <th className="px-2 py-2 text-left">Narration</th>
                <th className="px-2 py-2 text-left">Ref / UTR</th>
                <th className="px-2 py-2 text-right">IN</th>
                <th className="px-2 py-2 text-right">OUT</th>
                <th className="px-2 py-2 text-left">Matched to</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id} className="border-t hover:bg-gray-50">
                  <td className="px-2 py-1.5 whitespace-nowrap">{t.txn_date}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{t.bank_name}</td>
                  <td className="px-2 py-1.5 max-w-[320px] truncate" title={t.description}>{t.description}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs text-gray-500">{t.ref_no || '—'}</td>
                  <td className="px-2 py-1.5 text-right text-green-700 font-medium">{+t.credit > 0 ? fmt(t.credit) : ''}</td>
                  <td className="px-2 py-1.5 text-right text-red-700 font-medium">{+t.debit > 0 ? fmt(t.debit) : ''}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {t.matched_type
                      ? <span className="text-xs text-green-700" title={t.matched_note || ''}>{MATCH_LABEL[t.matched_type] || '✅ ' + t.matched_type}</span>
                      : <span className="text-xs text-amber-600">⏳ Unmatched</span>}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-xs">
                    {t.matched_type
                      ? <button onClick={() => unmatch(t.id)} className="text-gray-400 hover:text-red-600">↩ Unmatch</button>
                      : <button onClick={() => markManual(t.id)} className="text-blue-600 hover:underline">Match…</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 50 && (
        <div className="flex items-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">← Prev</button>
          <span>Page {page} of {Math.ceil(total / 50)}</span>
          <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(p => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">Next →</button>
        </div>
      )}
    </div>
  );
}

function ImportTab({ accounts, onDone }) {
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const doImport = async () => {
    if (!accountId) return alert('Pick the bank account first');
    if (!file) return alert('Choose the statement file (CSV, Excel or PDF)');
    setBusy(true); setResult(null);
    try {
      const fd = new FormData();
      fd.append('bank_account_id', accountId);
      fd.append('file', file);
      const r = await api.post('/bank/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(r.data);
    } catch (e) { alert(e.response?.data?.error || 'Import failed'); }
    setBusy(false);
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="font-semibold text-sm">Upload bank statement</div>
        <p className="text-xs text-gray-500">
          Download the statement from PNB One Biz or HDFC NetBanking as <b>CSV / Excel</b> — or drop the PNB
          <b> Transaction History PDF</b> straight in. Columns are detected automatically (Date, Narration,
          Withdrawal, Deposit…). Duplicate lines are skipped, so re-uploading an overlapping period is safe.
        </p>
        <p className="text-[11px] text-gray-400">
          CSV / Excel stays the most exact source. A PDF is read by column position and the account number on it
          must match the account you pick below.
        </p>
        <select value={accountId} onChange={e => setAccountId(e.target.value)} className="border rounded px-2 py-1.5 text-sm w-full">
          <option value="">— Select bank account —</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.bank_name}{a.account_label ? ` — ${a.account_label}` : ''}{a.account_last4 ? ` ••${a.account_last4}` : ''}</option>)}
        </select>
        <input type="file" accept=".csv,.xls,.xlsx,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} className="text-sm" />
        <button onClick={doImport} disabled={busy}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded disabled:opacity-50">
          {busy ? 'Importing…' : '⬆️ Import & auto-match'}
        </button>
        {result && (
          <div className="text-sm bg-green-50 border border-green-200 rounded p-3">
            ✅ Imported <b>{result.added}</b> new transaction(s), skipped <b>{result.skipped_duplicates}</b> duplicate(s),
            auto-matched <b>{result.auto_matched}</b>.{result.bad_dates > 0 && <> ⚠️ {result.bad_dates} row(s) had unreadable dates and were skipped.</>}
            {result.source_format === 'pdf' && (
              <> Read <b>{result.parsed_rows}</b> line(s) from {result.pages} PDF page(s).
                {result.skipped_rows > 0 && <> ⚠️ {result.skipped_rows} line(s) carried no amount and were skipped — worth a look against the PDF.</>}
              </>
            )}
            <button onClick={onDone} className="ml-2 text-blue-600 underline">View transactions →</button>
          </div>
        )}
      </div>

      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-sm">
        <div className="font-semibold text-indigo-800">🔄 Phase 2 — Automatic daily sync (Account Aggregator)</div>
        <p className="text-xs text-indigo-700 mt-1">
          Once the company is onboarded with an RBI-licensed Account Aggregator (Setu / Finvu), both PNB and HDFC
          transactions will land here automatically every morning — no upload needed. Same table, same matching.
          Status: <b>waiting for TSP onboarding</b>. No netbanking password is ever stored in the ERP.
        </p>
      </div>
    </div>
  );
}

function AccountsTab({ accounts, onChanged }) {
  const [bankName, setBankName] = useState('');
  const [label, setLabel] = useState('');
  const [last4, setLast4] = useState('');
  const add = async () => {
    if (!bankName.trim()) return alert('Bank name required');
    await api.post('/bank/accounts', { bank_name: bankName.trim(), account_label: label.trim() || null, account_last4: last4.trim() || null });
    setBankName(''); setLabel(''); setLast4('');
    onChanged();
  };
  return (
    <div className="max-w-xl space-y-4">
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="font-semibold text-sm">Add bank account</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Bank (PNB / HDFC)" className="border rounded px-2 py-1.5 text-sm" />
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (Current A/c)" className="border rounded px-2 py-1.5 text-sm" />
          <input value={last4} onChange={e => setLast4(e.target.value)} placeholder="Last 4 digits" maxLength={4} className="border rounded px-2 py-1.5 text-sm" />
        </div>
        <p className="text-[11px] text-gray-400">Only the last 4 digits are kept — never the full account number or any password.</p>
        <button onClick={add} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded">+ Add account</button>
      </div>
      <div className="border rounded-lg divide-y">
        {accounts.length === 0 && <div className="p-4 text-sm text-gray-500">No accounts yet — add PNB and HDFC above.</div>}
        {accounts.map(a => (
          <div key={a.id} className="p-3 flex items-center justify-between text-sm">
            <div>
              <div className="font-medium">{a.bank_name}{a.account_last4 ? ` ••${a.account_last4}` : ''}</div>
              <div className="text-xs text-gray-500">{a.account_label || '—'}</div>
            </div>
            <div className="text-xs text-gray-500 text-right">
              <div>{a.txn_count} transaction(s)</div>
              <div>Last: {a.last_txn_date || '—'}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
