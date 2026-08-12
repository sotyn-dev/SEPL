import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import PencilBanner from '../components/PencilBanner.jsx';
import ExportDevConfigDialog from '../components/ExportDevConfigDialog.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { modulesOnDisplay, planLabelForClass } from '../fixtures/packs.js';

function dataPathFor(t) {
  if (t?.dataPath) return t.dataPath;
  return `/var/lib/sotyn/tenants/${t?.slug || '…'}/data`;
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OrgOverviewPage() {
  const { slug } = useParams();
  const [tenant, setTenant] = useState(null);
  const [error, setError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [hostname, setHostname] = useState('');
  const [hostUnlocked, setHostUnlocked] = useState(false);
  const [hostMsg, setHostMsg] = useState('');
  const [hostErr, setHostErr] = useState('');
  const [hostSaving, setHostSaving] = useState(false);
  const [user, setUser] = useState(null);
  const [backups, setBackups] = useState([]);
  const [backupsErr, setBackupsErr] = useState('');
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const [restoreErr, setRestoreErr] = useState('');
  const [restoreJob, setRestoreJob] = useState(null);
  const [backupConfirm, setBackupConfirm] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [logsText, setLogsText] = useState(null);
  const [logsMeta, setLogsMeta] = useState(null);
  const [logsErr, setLogsErr] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);
  const pollRef = useRef(null);

  const isAdmin = user?.role === 'platform_admin';
  const actionBusy = restoreBusy || backupBusy;

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const loadBackups = () => {
    setBackupsErr('');
    setBackupsLoading(true);
    api(`/api/tenants/${slug}/backups`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list backups');
        setBackups(d.backups || []);
      })
      .catch((e) => setBackupsErr(String(e.message || e)))
      .finally(() => setBackupsLoading(false));
  };

  const loadLogs = () => {
    setLogsErr('');
    setLogsLoading(true);
    api(`/api/tenants/${slug}/logs?tail=200`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to load logs');
        const lines = Array.isArray(d.lines) ? d.lines : [];
        setLogsText(lines.length ? lines.join('\n') : '(no log lines)');
        setLogsMeta({
          hostId: d.hostId,
          hostLabel: d.hostLabel,
          containerName: d.containerName,
          containerStatus: d.containerStatus,
          tail: d.tail || 200,
          truncated: !!d.truncated,
          fetchedAt: new Date(),
        });
      })
      .catch((e) => {
        setLogsText(null);
        setLogsMeta(null);
        setLogsErr(String(e.message || e));
      })
      .finally(() => setLogsLoading(false));
  };

  useEffect(() => {
    setError('');
    setHostMsg('');
    setHostErr('');
    setHostUnlocked(false);
    setRestoreMsg('');
    setRestoreErr('');
    setRestoreJob(null);
    setLogsText(null);
    setLogsMeta(null);
    setLogsErr('');
    stopPoll();
    api('/api/auth/me')
      .then(async (r) => {
        if (!r.ok) return;
        const d = await r.json();
        setUser(d.user || null);
      })
      .catch(() => {});
    api(`/api/tenants/${slug}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Not found');
        setTenant(d.tenant);
        setHostname(d.tenant.hostname || '');
      })
      .catch((e) => setError(String(e.message || e)));
    loadBackups();
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const lockHostname = (value) => {
    setHostname(value ?? tenant?.hostname ?? '');
    setHostUnlocked(false);
    setHostErr('');
  };

  const saveHostname = async (e) => {
    e.preventDefault();
    if (!hostUnlocked) return;
    setHostMsg('');
    setHostErr('');
    setHostSaving(true);
    try {
      const r = await api(`/api/tenants/${slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ hostname }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      setTenant(d.tenant);
      lockHostname(d.tenant.hostname || '');
      setHostMsg('Hostname saved in platform.db — DNS / nginx still separate.');
    } catch (err) {
      setHostErr(String(err.message || err));
    } finally {
      setHostSaving(false);
    }
  };

  const pollJob = (jobId, { onOk }) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await api(`/api/tenants/${slug}/jobs/${jobId}`);
        const d = await r.json();
        if (!r.ok) {
          setRestoreErr(d.error || 'Job poll failed');
          stopPoll();
          setRestoreBusy(false);
          setBackupBusy(false);
          return;
        }
        setRestoreJob(d.job);
        if (d.job?.status === 'ok' || d.job?.status === 'error') {
          stopPoll();
          setRestoreBusy(false);
          setBackupBusy(false);
          if (d.job.status === 'error') {
            setRestoreErr(d.job.error || 'Job failed');
          } else {
            onOk?.(d.job);
            loadBackups();
          }
        }
      } catch (e) {
        setRestoreErr(String(e.message || e));
        stopPoll();
        setRestoreBusy(false);
        setBackupBusy(false);
      }
    }, 1200);
  };

  const confirmRestore = async () => {
    if (!restoreTarget || !isAdmin) return;
    setRestoreBusy(true);
    setRestoreErr('');
    setRestoreMsg('');
    setRestoreJob(null);
    try {
      const r = await api(`/api/tenants/${slug}/restore`, {
        method: 'POST',
        body: JSON.stringify({ file: restoreTarget.filename }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Restore failed to start');
      setRestoreTarget(null);
      setRestoreJob({ id: d.jobId, status: d.status || 'queued', file: d.file, type: 'restore' });
      const restoredName = d.file;
      pollJob(d.jobId, {
        onOk: (job) => {
          setRestoreMsg(`Restored ${job.file || restoredName || 'backup'} — undo = restore a newer backup from this list.`);
        },
      });
    } catch (e) {
      setRestoreErr(String(e.message || e));
      setRestoreBusy(false);
      setRestoreTarget(null);
    }
  };

  const confirmTakeBackup = async () => {
    if (!isAdmin) return;
    setBackupBusy(true);
    setBackupConfirm(false);
    setRestoreErr('');
    setRestoreMsg('');
    setRestoreJob(null);
    try {
      const r = await api(`/api/tenants/${slug}/backup`, { method: 'POST', body: '{}' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Backup failed to start');
      setRestoreJob({ id: d.jobId, status: d.status || 'queued', type: 'backup' });
      pollJob(d.jobId, {
        onOk: (job) => {
          setRestoreMsg(
            job.file
              ? `Backup saved: ${job.file} — use Restore on that row to undo a later restore.`
              : 'Backup finished — refresh the list if the new zip is not visible yet.'
          );
        },
      });
    } catch (e) {
      setRestoreErr(String(e.message || e));
      setBackupBusy(false);
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
        <Link to="/" className="text-sm text-teal-700 hover:underline">← Companies</Link>
      </div>
    );
  }

  if (!tenant) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  const plan = planLabelForClass(tenant.tenantClass);
  const modules = modulesOnDisplay(tenant.tenantClass);
  const hostDirty = hostname.trim().toLowerCase() !== (tenant.hostname || '');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link to="/" className="text-xs text-blue-800 hover:underline">← Companies</Link>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink mt-1 break-words">{tenant.displayName}</h1>
          <p className="font-mono text-xs text-slate-500 mt-1 break-all">
            slug <span className="text-ink">{tenant.slug}</span>
            {' · '}
            {tenant.hostname}
            {' · '}
            {tenant.id}
          </p>
        </div>
        <div className="flex flex-col xs:flex-row sm:flex-row gap-2 w-full sm:w-auto">
          <button
            type="button"
            disabled
            title="Not wired — worker agent pause later"
            className="text-sm px-3 py-2.5 rounded-lg border border-slate-200 text-slate-400 cursor-not-allowed"
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="text-sm px-3 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-white"
          >
            Export dev config
          </button>
        </div>
      </div>

      <PencilBanner>
        Overview layout matches the sketch. Pause / provision / agent health are not connected.
      </PencilBanner>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-2">
          <h2 className="text-sm font-semibold text-ink">Status</h2>
          <p className="text-sm">
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-teal-50 text-teal-800 border border-teal-100 mr-2">
              {tenant.status}
            </span>
            Plan: <strong>{plan}</strong>
            <span className="text-slate-400 text-xs ml-2">(display from class — not a saved plan row)</span>
          </p>
          <p className="text-sm text-slate-600 break-all">
            Slug (data key): <code className="text-xs bg-slate-50 px-1 rounded">{tenant.slug}</code>
            <span className="text-slate-400 text-xs ml-2">fixed</span>
          </p>
          <form onSubmit={saveHostname} className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              Hostname (URL)
              <input
                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${
                  hostUnlocked
                    ? 'border-teal-300 bg-white'
                    : 'border-slate-200 bg-slate-50 text-slate-600 cursor-default'
                }`}
                value={hostname}
                readOnly={!hostUnlocked}
                onChange={(e) => {
                  if (!hostUnlocked) return;
                  setHostname(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''));
                }}
                placeholder="secured-erp.sotyn.com"
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {!hostUnlocked ? (
                <button
                  type="button"
                  className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                  onClick={() => { setHostUnlocked(true); setHostMsg(''); setHostErr(''); }}
                >
                  Unlock to edit
                </button>
              ) : (
                <>
                  <button
                    type="submit"
                    disabled={hostSaving || !hostDirty}
                    className="text-sm px-3 py-1.5 rounded-lg bg-teal-700 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-teal-800"
                  >
                    {hostSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    disabled={hostSaving}
                    className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                    onClick={() => { lockHostname(); setHostMsg(''); }}
                  >
                    Lock / cancel
                  </button>
                </>
              )}
            </div>
            {hostMsg && <p className="text-xs text-teal-800">{hostMsg}</p>}
            {hostErr && <p className="text-xs text-red-700">{hostErr}</p>}
          </form>
          <p className="text-sm text-slate-600 break-all">
            Data path: <code className="text-xs bg-slate-50 px-1 rounded">{dataPathFor(tenant)}</code>
          </p>
          <p className="text-sm text-slate-600">
            S3 prefix: <code className="text-xs bg-slate-50 px-1 rounded">{tenant.s3KeyPrefix || tenant.slug}</code>
          </p>
          <p className="text-sm text-slate-600">
            Modules on (fixture estimate): <code className="text-xs">{modules}</code>
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
          <h2 className="text-sm font-semibold text-ink">Quick links</h2>
          <p>
            <Link
              to={`/orgs/${slug}/entitlements`}
              className="btn btn-primary inline-flex text-sm"
            >
              Edit entitlements
            </Link>
          </p>
          <p>
            <Link
              to={`/orgs/${slug}/brand`}
              className="inline-flex text-sm text-slate-700 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50"
            >
              White-label / brand
            </Link>
          </p>
          <p>
            <button
              type="button"
              disabled
              className="text-sm text-slate-400 border border-slate-100 px-3 py-1.5 rounded-lg cursor-not-allowed"
            >
              View audit for this company
            </button>
          </p>
          <p>
            <a
              href={`https://${tenant.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-sm text-slate-700 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50"
            >
              Open tenant app ↗
            </a>
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">Container logs</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Last 200 lines via worker agent (<code className="text-[10px] bg-slate-50 px-1 rounded">docker logs</code>).
              Click to fetch — nothing loads until then.
            </p>
          </div>
          <button
            type="button"
            onClick={loadLogs}
            disabled={logsLoading || actionBusy}
            className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {logsLoading ? 'Loading…' : logsText != null ? 'Refresh' : 'Load logs'}
          </button>
        </div>
        {logsMeta && (
          <p className="text-[11px] font-mono text-slate-500 break-all">
            {logsMeta.containerName}
            {logsMeta.containerStatus ? ` · ${logsMeta.containerStatus}` : ''}
            {logsMeta.hostLabel || logsMeta.hostId
              ? ` · ${logsMeta.hostLabel || logsMeta.hostId}`
              : ''}
            {` · tail ${logsMeta.tail}`}
            {logsMeta.truncated ? ' · truncated' : ''}
            {logsMeta.fetchedAt
              ? ` · ${logsMeta.fetchedAt.toLocaleTimeString()}`
              : ''}
          </p>
        )}
        {logsErr && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{logsErr}</p>
        )}
        {logsText != null ? (
          <pre className="max-h-80 overflow-auto rounded-lg border border-slate-100 bg-slate-950 text-slate-100 text-[11px] leading-relaxed p-3 whitespace-pre-wrap break-all">
            {logsText}
          </pre>
        ) : (
          !logsErr && (
            <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-6 text-center">
              No logs loaded yet.
            </p>
          )
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Backups / restore</h2>
          <button
            type="button"
            onClick={loadBackups}
            disabled={backupsLoading || actionBusy}
            className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {backupsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <fieldset className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
          <legend className="text-xs font-semibold text-slate-700 px-1">Actions</legend>
          <p className="text-xs text-slate-500">
            Take backup first if you may need undo, then Restore an older file from the list.
            Backup runs inside the tenant container (online). Restore stops the container briefly.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setRestoreErr('');
                  setRestoreMsg('');
                  setBackupConfirm(true);
                }}
                className="text-sm px-3 py-1.5 rounded-lg bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-40"
              >
                {backupBusy ? 'Backing up…' : 'Take backup'}
              </button>
            ) : (
              <span className="text-[10px] text-slate-400">Take backup / Restore — admin only</span>
            )}
            <span className="text-[11px] text-slate-400">
              Restore is per row below →
            </span>
          </div>
        </fieldset>

        <p className="text-xs text-slate-500">
          Host backups for this org (tenant folder + optional legacy dir on the agent).
        </p>
        {backupsErr && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{backupsErr}</p>
        )}
        {restoreMsg && <p className="text-xs text-teal-800">{restoreMsg}</p>}
        {restoreErr && <p className="text-xs text-red-700">{restoreErr}</p>}
        {restoreJob && (
          <p className="text-xs font-mono text-slate-500">
            Job {restoreJob.id}
            {restoreJob.type ? ` (${restoreJob.type})` : ''}
            : {restoreJob.status}
            {restoreJob.steps?.length ? ` · ${restoreJob.steps[restoreJob.steps.length - 1]?.message || ''}` : ''}
          </p>
        )}
        <div className="overflow-x-auto border border-slate-100 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">File</th>
                <th className="px-3 py-2 font-semibold">Source</th>
                <th className="px-3 py-2 font-semibold">Size</th>
                <th className="px-3 py-2 font-semibold">Modified</th>
                <th className="px-3 py-2 font-semibold w-28" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={`${b.source}-${b.filename}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs break-all">{b.filename}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] border ${
                      b.source === 'legacy'
                        ? 'bg-amber-50 text-amber-800 border-amber-100'
                        : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}
                    >
                      {b.source}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{formatBytes(b.size)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isAdmin ? (
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => {
                          setRestoreErr('');
                          setRestoreMsg('');
                          setRestoreTarget(b);
                        }}
                        className="text-xs px-2.5 py-1 rounded-lg border border-amber-200 text-amber-900 bg-amber-50 hover:bg-amber-100 disabled:opacity-40"
                      >
                        Restore
                      </button>
                    ) : (
                      <span className="text-[10px] text-slate-400">admin only</span>
                    )}
                  </td>
                </tr>
              ))}
              {!backups.length && !backupsLoading && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-xs text-slate-400 text-center">
                    No backups found — use Take backup above, or wait for nightly ERP backups.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-500 border-l-2 border-slate-200 pl-3">
        Layer 2 (users, roles, preferences) is edited inside the company app — not here.
        This panel only governs allowance and platform ops.
      </p>

      {exportOpen && (
        <ExportDevConfigDialog
          tenant={tenant}
          onClose={() => setExportOpen(false)}
        />
      )}

      <ConfirmDialog
        open={backupConfirm}
        tone="warning"
        title="Take backup now?"
        message={`Creates a new backup-*.zip for “${tenant.displayName}” on the host (same folder as nightly backups).\n\nContainer stays up. Use this before Restore if you want a clean undo from this list.`}
        note="platform_admin only · runs backup-db.js inside the tenant container"
        confirmLabel="Take backup"
        busy={backupBusy}
        onCancel={() => { if (!backupBusy) setBackupConfirm(false); }}
        onConfirm={confirmTakeBackup}
      />

      <ConfirmDialog
        open={!!restoreTarget}
        tone="warning"
        title="Restore will stop this tenant"
        message={
          restoreTarget
            ? `This stops the ERP container for “${tenant.displayName}”, replaces live databases with:\n${restoreTarget.filename}\n\nUsers will see downtime. Tip: Take backup first, then Restore that new zip later to undo. Backups folder is not deleted.`
            : ''
        }
        note="platform_admin only · DNS / nginx unchanged"
        confirmLabel="Stop & restore"
        busy={restoreBusy}
        onCancel={() => { if (!restoreBusy) setRestoreTarget(null); }}
        onConfirm={confirmRestore}
      />
    </div>
  );
}
