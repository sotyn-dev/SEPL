import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

const ACTION_COLORS = {
  CREATE: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  UPDATE: 'bg-blue-50 text-blue-800 border-blue-200',
  DELETE: 'bg-red-50 text-red-800 border-red-200',
  LOGIN: 'bg-violet-50 text-violet-800 border-violet-200',
  LOGIN_FAIL: 'bg-red-50 text-red-800 border-red-200',
  ACCEPT_INVITE: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  RESET_PASSWORD: 'bg-amber-50 text-amber-900 border-amber-200',
  CHANGE_PASSWORD: 'bg-amber-50 text-amber-900 border-amber-200',
  CHANGE_PASSWORD_FAIL: 'bg-red-50 text-red-800 border-red-200',
};

const actionClass = (a) => ACTION_COLORS[a] || 'bg-slate-50 text-slate-700 border-slate-200';
const statusClass = (s) =>
  s >= 200 && s < 300 ? 'text-emerald-700' : s >= 400 ? 'text-red-700' : 'text-slate-500';

function fmtWhen(iso) {
  try {
    return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString(
      'en-IN',
      { timeZone: 'Asia/Kolkata' }
    );
  } catch {
    return iso;
  }
}

const emptyFilters = {
  user_id: '',
  entity_type: '',
  action: '',
  date_from: '',
  date_to: '',
  q: '',
};

export default function AuditPage() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ users: [], entityTypes: [], actions: [] });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [filters, setFilters] = useState(emptyFilters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      Object.entries(filters).forEach(([k, v]) => {
        if (v) params.set(k, v);
      });
      const r = await api(`/api/audit?${params}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load');
      setRows(d.rows || []);
      setTotal(d.total || 0);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api('/api/audit/meta')
      .then(async (r) => {
        if (!r.ok) return;
        setMeta(await r.json());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filters]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const setFilter = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Audit</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Operator actions on the control plane (login, orgs, deploy, hosts, backups). Not tenant ERP activity.
            {' '}
            <Link to="/docs?tab=audit" className="text-blue-800 hover:underline">Docs</Link>
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-sm font-medium px-3 py-2 rounded-md border border-slate-200 bg-white hover:border-slate-300 text-slate-700 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">{error}</div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['Total entries', total.toLocaleString()],
          ['Operators', meta.users?.length || 0],
          ['Modules', meta.entityTypes?.length || 0],
          ['Actions', meta.actions?.length || 0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-center">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="text-xl font-semibold text-ink mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Filters</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
          <input
            className="rounded-md border border-slate-200 px-3 py-2 text-sm"
            placeholder="Search path / body / user / id"
            value={filters.q}
            onChange={(e) => setFilter({ q: e.target.value })}
          />
          <select
            className="rounded-md border border-slate-200 px-3 py-2 text-sm bg-white"
            value={filters.user_id}
            onChange={(e) => setFilter({ user_id: e.target.value })}
          >
            <option value="">All operators</option>
            {(meta.users || []).map((u) => (
              <option key={u.user_id} value={u.user_id}>{u.user_name || u.user_id}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-200 px-3 py-2 text-sm bg-white"
            value={filters.entity_type}
            onChange={(e) => setFilter({ entity_type: e.target.value })}
          >
            <option value="">All modules</option>
            {(meta.entityTypes || []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-200 px-3 py-2 text-sm bg-white"
            value={filters.action}
            onChange={(e) => setFilter({ action: e.target.value })}
          >
            <option value="">All actions</option>
            {(meta.actions || []).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            From
            <input
              type="date"
              className="flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
              value={filters.date_from}
              onChange={(e) => setFilter({ date_from: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            To
            <input
              type="date"
              className="flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
              value={filters.date_to}
              onChange={(e) => setFilter({ date_to: e.target.value })}
            />
          </label>
        </div>
        {Object.values(filters).some(Boolean) && (
          <button
            type="button"
            className="text-xs text-red-700 hover:underline"
            onClick={() => { setFilters(emptyFilters); setPage(1); }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100 text-left text-slate-500">
              <th className="px-3 py-2 font-medium">When (IST)</th>
              <th className="px-3 py-2 font-medium">Operator</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">Path</th>
              <th className="px-3 py-2 font-medium text-center">Status</th>
              <th className="px-3 py-2 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer"
                onClick={() => setSelected(r)}
              >
                <td className="px-3 py-2 whitespace-nowrap text-slate-700">{fmtWhen(r.at)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.user_name || <span className="text-slate-300">anon</span>}
                  {r.user_role && <span className="text-[10px] text-slate-400 ml-1">[{r.user_role}]</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${actionClass(r.action)}`}>
                    {r.action}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.entity_type || '—'}
                  {r.entity_id ? <span className="text-slate-400 ml-1">#{r.entity_id}</span> : null}
                </td>
                <td className="px-3 py-2 font-mono text-[10px] max-w-[240px] truncate" title={r.path}>{r.path}</td>
                <td className={`px-3 py-2 text-center font-semibold ${statusClass(r.status_code)}`}>
                  {r.status_code || '—'}
                </td>
                <td className="px-3 py-2 text-slate-500">{r.ip || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-10">
                  No audit entries match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-between items-center text-xs text-slate-500">
          <span>
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total.toLocaleString()}
          </span>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40"
            >
              Prev
            </button>
            <span>Page {page} / {totalPages}</span>
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {selected && (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4"
          onClick={() => setSelected(null)}
          role="presentation"
        >
          <div
            className="bg-white rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-lg"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex justify-between items-center p-4 border-b border-slate-100 sticky top-0 bg-white">
              <div>
                <h2 className="font-semibold text-ink">Audit #{selected.id}</h2>
                <p className="text-xs text-slate-500 mt-0.5">{fmtWhen(selected.at)} IST</p>
              </div>
              <button
                type="button"
                className="text-sm text-slate-500 hover:text-ink px-2 py-1"
                onClick={() => setSelected(null)}
              >
                Close
              </button>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-slate-400">Operator:</span> <b>{selected.user_name || 'anon'}</b>{selected.user_role ? ` [${selected.user_role}]` : ''}</div>
                <div>
                  <span className="text-slate-400">Action:</span>{' '}
                  <span className={`px-1.5 py-0.5 rounded border font-semibold ${actionClass(selected.action)}`}>{selected.action}</span>
                </div>
                <div><span className="text-slate-400">Module:</span> <b>{selected.entity_type || '—'}</b></div>
                <div><span className="text-slate-400">Entity:</span> {selected.entity_id || '—'}</div>
                <div>
                  <span className="text-slate-400">HTTP:</span>{' '}
                  <b>{selected.method}</b> → <span className={statusClass(selected.status_code)}>{selected.status_code}</span>
                </div>
                <div><span className="text-slate-400">IP:</span> {selected.ip || '—'}</div>
              </div>
              <div>
                <span className="text-slate-400">Path:</span>{' '}
                <code className="bg-slate-50 px-1 py-0.5 rounded font-mono text-[11px]">{selected.path}</code>
              </div>
              {selected.entity_label && (
                <div><span className="text-slate-400">Label:</span> <b>{selected.entity_label}</b></div>
              )}
              {selected.query && (
                <div>
                  <span className="text-slate-400">Query:</span>{' '}
                  <code className="bg-slate-50 px-1 py-0.5 rounded font-mono text-[10px] break-all">{selected.query}</code>
                </div>
              )}
              {selected.body_summary && (
                <div>
                  <div className="text-slate-400 mb-1">Request body (secrets redacted):</div>
                  <pre className="bg-slate-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.body_summary}</pre>
                </div>
              )}
              {selected.before_json && (
                <div>
                  <div className="text-slate-400 mb-1">Before:</div>
                  <pre className="bg-amber-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.before_json}</pre>
                </div>
              )}
              {selected.after_json && (
                <div>
                  <div className="text-slate-400 mb-1">After:</div>
                  <pre className="bg-emerald-50 p-2 rounded text-[10px] whitespace-pre-wrap break-all font-mono">{selected.after_json}</pre>
                </div>
              )}
              {selected.user_agent && (
                <div className="text-slate-500 text-[10px]">UA: {selected.user_agent}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
