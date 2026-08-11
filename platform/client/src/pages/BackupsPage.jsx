import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken } from '../lib/api.js';

const formatSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function BackupsPage() {
  const [data, setData] = useState({ backup_dir: '', backups: [], keep: 30 });
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api('/api/backups');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load backups');
      setData({
        backup_dir: d.backup_dir || '',
        backups: d.backups || [],
        keep: d.keep ?? 30,
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const r = await api('/api/backups/run', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Backup failed');
      setNotice(`Backup created: ${d.filename}`);
      await load();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRunning(false);
    }
  };

  const download = (filename) => {
    const token = getToken();
    if (!token) {
      setError('Session expired — sign in again');
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/backups/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const latest = data.backups?.[0];
  const latestAge = latest
    ? Math.round((Date.now() - new Date(latest.created_at).getTime()) / 3600000)
    : null;
  const latestFilename = latest?.filename;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Backups</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Control-plane <code className="text-xs bg-white px-1 rounded">platform.db</code> only — one .zip per run.
            Nightly at 2:00 AM; keeps the last {data.keep}. Branding asset files are not inside this zip.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={runNow}
            disabled={running}
            className="btn btn-primary text-sm disabled:opacity-60"
          >
            {running ? 'Backing up…' : 'Backup Now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-sm px-3 py-2">{notice}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Total backups</p>
          <p className="text-2xl font-semibold text-ink mt-1">{data.backups?.length || 0}</p>
          <p className="text-[11px] text-slate-400">Retention: last {data.keep}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Latest backup</p>
          {latest ? (
            <>
              <p className="text-2xl font-semibold text-ink mt-1">
                {latestAge === 0 ? 'Just now' : latestAge < 24 ? `${latestAge}h ago` : `${Math.floor(latestAge / 24)}d ago`}
              </p>
              <p className="text-[11px] text-slate-400">{fmtWhen(latest.created_at)}</p>
            </>
          ) : (
            <p className="text-sm text-amber-700 mt-1">No backups yet — click Backup Now</p>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Storage location</p>
          <p className="text-sm font-mono text-slate-700 mt-1 truncate" title={data.backup_dir}>
            {data.backup_dir || '—'}
          </p>
          <p className="text-[11px] text-slate-400">On this host disk</p>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm flex items-start gap-2">
        <div>
          <p className="font-semibold text-blue-900">Recommendation</p>
          <p className="text-xs text-blue-800 mt-0.5">
            Download the latest zip weekly to a laptop / Drive folder. Host backups protect against app mistakes;
            an offline copy protects you if the VPS is lost. Restore: stop platform → unzip → replace{' '}
            <code className="bg-white/80 px-1 rounded">platform.db</code> → start platform. See{' '}
            <Link to="/docs" className="underline font-medium">Docs</Link>.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[520px]">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Filename</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data.backups || []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No backups yet. Click Backup Now (nightly 2:00 AM also runs automatically).
                  </td>
                </tr>
              ) : (
                data.backups.map((b) => {
                  const isLatest = b.filename === latestFilename;
                  return (
                    <tr
                      key={b.filename}
                      className={isLatest ? 'bg-emerald-50/60' : 'hover:bg-slate-50/80'}
                    >
                      <td className="px-4 py-2 font-mono text-xs text-ink">
                        {b.filename}
                        {isLatest && (
                          <span className="ml-2 text-[10px] font-sans font-semibold uppercase tracking-wide text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded">
                            Latest
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className="text-slate-600">Full backup</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">{fmtWhen(b.created_at)}</td>
                      <td className="px-4 py-2 text-xs text-slate-600">{formatSize(b.size)}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => download(b.filename)}
                          className="text-xs text-blue-800 hover:underline"
                        >
                          Download
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
