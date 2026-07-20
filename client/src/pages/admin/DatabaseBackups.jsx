// Admin-only: list of nightly DB backups with one-click download + a
// "Backup Now" button for ad-hoc snapshots before risky operations.
//
// The server schedules an automatic backup at 02:00 every day and keeps
// the last 30 on the VPS disk. Mam can download any of them onto her laptop
// as a cold copy — weekly download to laptop is the recommended habit.

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiDownload, FiRefreshCw, FiDatabase, FiClock, FiHardDrive, FiAlertTriangle, FiUploadCloud } from 'react-icons/fi';
import { fmtDateTime } from '../../utils/datetime';
import { getToken } from '../../lib/tokenStore';

const formatSize = (bytes) => {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export default function DatabaseBackups() {
  const [data, setData] = useState({ backup_dir: '', backups: [] });
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/admin/backups');
      setData(r.data || { backup_dir: '', backups: [] });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load backups');
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post('/admin/backups/run');
      toast.success(`Backup created: ${r.data.filename}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Backup failed');
    }
    setRunning(false);
  };

  // Native streaming download: point a temporary <a> at the token-authorized
  // endpoint so the BROWSER streams the (large, 150+ MB) .db straight to disk
  // via its own download manager. The old approach pulled the whole file into
  // an in-memory blob via axios, which failed on big backups (mam 2026-06-29:
  // "not able to download"). The server accepts the token as a ?token= query
  // param for this one endpoint (a plain navigation can't send an auth header).
  const download = (filename) => {
    const token = getToken();
    if (!token) return toast.error('Session expired — please log in again');
    const a = document.createElement('a');
    a.href = `/api/admin/backups/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}`;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // ── Uploads → S3 migration ────────────────────────────────────────────────
  // The whole block below renders ONLY when the server reports the s3 driver, so on the
  // local driver this page is exactly what it has always been.
  const [mig, setMig] = useState(null);        // preview: counts / bytes / stragglers
  const [migJob, setMigJob] = useState(null);  // server-side job status
  const [confirming, setConfirming] = useState(false);

  const loadMigration = async () => {
    try {
      const [p, s] = await Promise.all([
        api.get('/admin/uploads/migrate/preview'),
        api.get('/admin/uploads/migrate/status'),
      ]);
      setMig(p.data);
      setMigJob(s.data);
    } catch { /* non-fatal: the backups page must still render */ }
  };
  useEffect(() => { loadMigration(); }, []);

  // Poll while a job is running. Progress lives on the SERVER, so closing and reopening
  // this page picks a running migration back up instead of losing sight of it.
  useEffect(() => {
    if (!migJob?.running) return undefined;
    const t = setInterval(async () => {
      try {
        const s = await api.get('/admin/uploads/migrate/status');
        setMigJob(s.data);
        if (!s.data.running) {
          const sum = s.data.summary;
          if (sum) {
            toast.success(`Moved ${sum.uploaded + sum.skippedExisting} file(s), freed ${formatSize(sum.freedBytes)}${sum.failed ? ` — ${sum.failed} failed` : ''}`);
          } else if (s.data.error) {
            toast.error(`Migration failed: ${s.data.error}`);
          }
          loadMigration();
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [migJob?.running]);

  const startMigration = async () => {
    setConfirming(false);
    try {
      await api.post('/admin/uploads/migrate', { deleteLocal: true });
      toast.success('Migration started');
      const s = await api.get('/admin/uploads/migrate/status');
      setMigJob(s.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not start migration');
    }
  };

  const latest = data.backups?.[0];
  const latestAge = latest ? Math.round((Date.now() - new Date(latest.created_at)) / 3600000) : null;

  // Offsite backups are opt-in (BACKUP_S3). When off, the API sends no `source` at all
  // and the extra column never renders — the page stays exactly as it is today.
  const s3On = !!data.s3_enabled;

  // LATEST marks the single newest backup overall (the newest consolidated .zip) — see
  // the isLatest check at render. Under the zip model one run = one file, so the old
  // "latest per database" tagging wrongly flagged stale legacy per-file backups too.
  const latestFilename = data.backups?.[0]?.filename;

  // Group rows by backup RUN so an ERP snapshot and the Chat snapshot written right
  // after it read as one unit. ERP→Chat of a single run land seconds apart; separate
  // runs (nightly, or a manual "Backup Now") are minutes/hours apart — so we cluster
  // by time proximity rather than a shared id. This also works for existing on-disk
  // backups, which carry independent per-file timestamps. Consecutive runs get an
  // alternating left color band so each pair is visually distinct without breaking the
  // one-row-per-file layout. GROUP_GAP_MS is the single knob if it ever needs tuning
  // (two manual runs within this window would merge into one band — rare, harmless).
  const GROUP_GAP_MS = 5 * 60 * 1000;
  const groups = [];
  let prevT = null;
  for (const b of (data.backups || [])) {
    const t = new Date(b.created_at).getTime();
    if (prevT === null || prevT - t > GROUP_GAP_MS) groups.push([]);
    prevT = t;
    groups[groups.length - 1].push(b);
  }
  // Within each run order ERP → Chat → SOTYN Flow (ERP is the primary db) — runs
  // themselves stay newest-first. Sort is stable, so any extra same-db files keep
  // their newest-first order. _newGroup flags the first row of each run for the
  // between-runs divider.
  const DB_ORDER = { erp: 0, chat: 1, sotynflow: 2 };
  const rows = [];
  groups.forEach((g, gi) => {
    [...g]
      .sort((a, b) => (DB_ORDER[a.db] ?? 0) - (DB_ORDER[b.db] ?? 0))
      .forEach((b, i) => rows.push({ ...b, _group: gi, _newGroup: gi > 0 && i === 0 }));
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiDatabase className="text-red-600" /> Database Backups
          </h3>
          <p className="text-sm text-gray-500">Automatic nightly snapshots at 2:00 AM. Keeps the last 30 consolidated backups — one .zip per run, bundling every database.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="btn btn-secondary flex items-center gap-2">
            <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={runNow} disabled={running} className="btn btn-primary flex items-center gap-2">
            <FiHardDrive size={14} /> {running ? 'Backing up…' : 'Backup Now'}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Backups</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{data.backups?.length || 0}</p>
          <p className="text-[11px] text-gray-400">Retention: last 30 backups</p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide flex items-center gap-1"><FiClock size={11} /> Latest Backup</p>
          {latest ? (
            <>
              <p className="text-2xl font-bold text-gray-800 mt-1">{latestAge === 0 ? 'Just now' : latestAge < 24 ? `${latestAge}h ago` : `${Math.floor(latestAge / 24)}d ago`}</p>
              <p className="text-[11px] text-gray-400">{fmtDateTime(latest.created_at)}</p>
            </>
          ) : (
            <p className="text-sm text-amber-700 mt-1 flex items-center gap-1"><FiAlertTriangle size={13} /> No backups yet — click "Backup Now"</p>
          )}
        </div>
        <div className="card">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Storage Location</p>
          <p className="text-sm font-mono text-gray-700 mt-1 truncate" title={data.backup_dir}>{data.backup_dir || '—'}</p>
          <p className="text-[11px] text-gray-400">On the VPS disk</p>
        </div>
      </div>

      {/* Recommendation banner — nudges mam to take a laptop copy weekly */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-start gap-2">
        <FiAlertTriangle className="text-blue-600 mt-0.5 flex-shrink-0" size={16} />
        <div>
          <p className="font-semibold text-blue-800">Recommendation</p>
          <p className="text-xs text-blue-700 mt-0.5">
            Click <b>Download</b> on the latest backup once a week and save it to your laptop's cloud-synced folder (Google Drive / OneDrive).
            VPS backups protect against software failures; a laptop copy protects you even if the VPS itself is lost.
          </p>
        </div>
      </div>

      {/* Upload storage — only when the server is actually on the s3 driver */}
      {mig?.s3_enabled && (
        <div className="card">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                <FiUploadCloud size={16} /> Upload storage
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Move uploaded files off the VPS disk into object storage. Runs automatically at 2:30 AM;
                use this to do it now.
              </p>
            </div>
            <button
              onClick={() => setConfirming(true)}
              disabled={migJob?.running || !mig?.stragglers}
              className="btn btn-primary text-xs flex items-center gap-1 disabled:opacity-50"
            >
              <FiUploadCloud size={14} />
              {migJob?.running ? 'Moving…' : 'Move uploads to S3'}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
            <div>
              <p className="text-[11px] text-gray-500 uppercase tracking-wide">On local disk</p>
              <p className="text-lg font-bold text-gray-800">{mig.referenced ?? 0}</p>
              <p className="text-[11px] text-gray-400">{formatSize(mig.bytes || 0)} referenced</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-500 uppercase tracking-wide">Still to move</p>
              <p className={`text-lg font-bold ${mig.stragglers ? 'text-amber-700' : 'text-emerald-700'}`}>
                {mig.stragglers ?? 0}
              </p>
              <p className="text-[11px] text-gray-400">{mig.stragglers ? 'not yet in the bucket' : 'all moved'}</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-500 uppercase tracking-wide">Unreferenced</p>
              <p className="text-lg font-bold text-gray-500">{mig.skippedUnreferenced ?? 0}</p>
              <p className="text-[11px] text-gray-400">left alone, never uploaded</p>
            </div>
          </div>

          {migJob?.running && (
            <div className="mt-3">
              <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                <span>Moving files…</span>
                <span>{migJob.processed} / {migJob.total || '?'}</span>
              </div>
              <div className="h-1.5 bg-gray-200 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: migJob.total ? `${Math.round((migJob.processed / migJob.total) * 100)}%` : '10%' }}
                />
              </div>
            </div>
          )}

          {/* Confirm first — this deletes local copies, so it must not be one click. */}
          {confirming && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-amber-900">Move {mig.stragglers} file(s) to S3?</p>
              <p className="text-xs text-amber-800 mt-1">
                Each file is uploaded and verified in the bucket, then its local copy is deleted —
                in batches, so disk frees as it goes. Files not referenced by any record are left
                untouched. Anything that fails to upload keeps its local copy.
              </p>
              <div className="flex gap-2 mt-2">
                <button onClick={startMigration} className="btn btn-primary text-xs">Yes, move them</button>
                <button onClick={() => setConfirming(false)} className="btn btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Backup list */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th>Filename</th>
              <th>Database</th>
              {s3On && <th>Location</th>}
              <th>Created</th>
              <th>Size</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const isLatest = b.filename === latestFilename;
              const dbKind = b.db || 'erp';
              // "Local only" is the one worth warning about: it means the offsite push
              // failed or hasn't run, so that backup dies with the VPS.
              const loc = b.source === 'both'
                ? { label: 'Local + Offsite', cls: 'bg-emerald-100 text-emerald-800' }
                : b.source === 's3'
                  ? { label: 'Offsite only', cls: 'bg-sky-100 text-sky-800' }
                  : { label: 'Local only', cls: 'bg-amber-100 text-amber-800' };
              const badge = dbKind === 'archive'
                ? { label: 'Full backup', cls: 'bg-amber-100 text-amber-800' }
                : dbKind === 'sotynflow'
                ? { label: 'SOTYN Flow', cls: 'bg-emerald-100 text-emerald-800' }
                : dbKind === 'chat'
                  ? { label: 'SOTYN Chat', cls: 'bg-violet-100 text-violet-800' }
                  : { label: 'ERP', cls: 'bg-blue-100 text-blue-800' };
              const evenGroup = b._group % 2 === 0;
              // Each run reads as one block via a soft shared tint plus a stronger rule
              // between runs. Rows are trimmed to equal top/bottom padding (py-2 instead
              // of the base py-3). LATEST keeps its emerald highlight layered on top.
              const divider = b._newGroup ? 'border-t-2 border-gray-200' : '';
              const fill = isLatest ? 'bg-emerald-50/60' : (evenGroup ? '' : 'bg-indigo-50/50');
              return (
              <tr key={b.filename} className={`[&>td]:py-2 ${divider} ${fill}`}>
                <td className="font-mono text-xs">
                  {b.filename}
                  {isLatest && <span className="ml-2 text-[10px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-bold">LATEST</span>}
                </td>
                <td>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${badge.cls}`}>
                    {badge.label}
                  </span>
                </td>
                {s3On && (
                  <td>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${loc.cls}`}>{loc.label}</span>
                  </td>
                )}
                <td className="whitespace-nowrap text-xs">{fmtDateTime(b.created_at)}</td>
                <td className="whitespace-nowrap text-xs">{formatSize(b.size)}</td>
                <td>
                  <button onClick={() => download(b.filename)} className="btn btn-secondary text-xs flex items-center gap-1">
                    <FiDownload size={12} /> Download
                  </button>
                </td>
              </tr>
              );
            })}
            {(data.backups || []).length === 0 && (
              <tr><td colSpan="5" className="text-center py-8 text-gray-400">
                No backups yet. The first scheduled run happens at 2:00 AM — or click <b>Backup Now</b> to create one immediately.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
