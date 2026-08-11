import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { api } from '../lib/api.js';

function suggestTag() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}-v1`;
}

export default function DeployPage() {
  const [hosts, setHosts] = useState([]);
  const [hostId, setHostId] = useState('');
  const [tag, setTag] = useState(suggestTag);
  const [build, setBuild] = useState(true);
  const [images, setImages] = useState([]);
  const [keepLatest, setKeepLatest] = useState(4);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [deletingTag, setDeletingTag] = useState('');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const pollRef = useRef(null);

  const hostQs = hostId ? `?hostId=${encodeURIComponent(hostId)}` : '';

  const loadHosts = useCallback(() => {
    api('/api/deploy/hosts')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list hosts');
        const list = d.hosts || [];
        setHosts(list);
        setHostId((prev) => {
          if (prev && list.some((h) => h.id === prev)) return prev;
          return list[0]?.id || '';
        });
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  const loadImages = useCallback(() => {
    if (!hostId) return;
    api(`/api/deploy/images?hostId=${encodeURIComponent(hostId)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list images');
        setImages(d.images || []);
      })
      .catch((e) => setError(String(e.message || e)));
  }, [hostId]);

  useEffect(() => {
    loadHosts();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadHosts]);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollJob = (id) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await api(`/api/deploy/jobs/${id}${hostQs}`);
        const d = await r.json();
        if (!r.ok) {
          setError(d.error || 'Job poll failed');
          stopPoll();
          setBusy(false);
          return;
        }
        setJob(d.job);
        if (d.job?.status === 'ok' || d.job?.status === 'error') {
          stopPoll();
          setBusy(false);
          loadImages();
          if (d.job.status === 'error') {
            setError(d.job.error || 'Deploy failed');
          }
        }
      } catch (e) {
        setError(String(e.message || e));
        stopPoll();
        setBusy(false);
      }
    }, 1500);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setJob(null);
    setBusy(true);
    try {
      const r = await api('/api/deploy', {
        method: 'POST',
        body: JSON.stringify({
          tag: tag.trim(),
          build,
          hostId,
          keepLatest: Number(keepLatest),
          pruneAfter: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Deploy failed');
        setBusy(false);
        return;
      }
      setJobId(d.jobId);
      setJob({ id: d.jobId, status: d.status || 'queued', steps: [], tag: d.tag, build: d.build });
      pollJob(d.jobId);
    } catch (err) {
      setError(String(err.message || err));
      setBusy(false);
    }
  };

  const pickRollback = (t) => {
    setTag(t);
    setBuild(false);
  };

  const runDeleteTag = async (t) => {
    setError('');
    setNotice('');
    setDeletingTag(t);
    try {
      const r = await api(`/api/deploy/images/${encodeURIComponent(t)}?hostId=${encodeURIComponent(hostId)}`, {
        method: 'DELETE',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setNotice(`Deleted sotyn-erp:${t}`);
      loadImages();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setDeletingTag('');
    }
  };

  const deleteTag = (t) => {
    setConfirm({
      title: `Delete sotyn-erp:${t}?`,
      message: 'Remove this unused image tag from this host.',
      note: 'Tenant data/ and backups/ are never touched.',
      confirmLabel: 'Delete image',
      tone: 'danger',
      onConfirm: () => runDeleteTag(t),
    });
  };

  const runPruneUnused = async () => {
    const n = Number(keepLatest);
    setError('');
    setNotice('');
    setPruneBusy(true);
    try {
      const r = await api('/api/deploy/images/prune', {
        method: 'POST',
        body: JSON.stringify({ hostId, keepLatest: n }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Prune failed');
      const removed = (d.deleted || []).length;
      setNotice(
        removed
          ? `Pruned ${removed} image(s): ${(d.deleted || []).join(', ')}`
          : 'Nothing to prune — unused tags already within keep limit.'
      );
      if (d.errors?.length) {
        setError(d.errors.map((e) => `${e.tag}: ${e.error}`).join('; '));
      }
      loadImages();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setPruneBusy(false);
    }
  };

  const pruneUnused = () => {
    const n = Number(keepLatest);
    setConfirm({
      title: 'Prune unused images?',
      message: `Remove unused sotyn-erp tags on this host.\nKeeps in-use tags, :latest, and ${n} newest unused tag(s) for rollback.`,
      note: 'Tenant data/ and backups/ are never touched.',
      confirmLabel: 'Prune unused',
      tone: 'warning',
      onConfirm: () => runPruneUnused(),
    });
  };

  const selectedHost = hosts.find((h) => h.id === hostId);
  const unusedBeyondKeep = images.filter((i) => !i.inUse && i.tag !== 'latest').length - Number(keepLatest || 0);
  const locked = busy || pruneBusy || !!deletingTag;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Deploy</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Pull <code className="text-xs bg-white px-1 rounded">main</code> on the selected host first.
            Deploy builds (optional) and recreates tenant containers on that host&apos;s agent.
            Host <code className="text-xs bg-white px-1 rounded">data/</code> is never deleted.
          </p>
        </div>
        <Link
          to="/docs"
          className="text-xs font-medium text-blue-800 hover:underline shrink-0 sm:mt-2"
        >
          Deploy how‑to →
        </Link>
      </div>

      {hosts.length > 0 && (
        <div className="max-w-xl">
          <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="deploy-host">
            Worker host
          </label>
          <select
            id="deploy-host"
            value={hostId}
            onChange={(e) => {
              setHostId(e.target.value);
              setJob(null);
              setNotice('');
              setError('');
            }}
            disabled={locked}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.id})
              </option>
            ))}
          </select>
          {selectedHost && (
            <p className="text-xs text-slate-500 mt-1 font-mono truncate">{selectedHost.agentUrl}</p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-sm px-3 py-2">
          {notice}
        </div>
      )}

      <form
        onSubmit={submit}
        className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-4 max-w-xl"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="deploy-tag">
            Image tag
          </label>
          <input
            id="deploy-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            placeholder="DD-MM-YYYY-v1"
            required
            disabled={locked}
          />
          <p className="text-xs text-slate-500 mt-1">
            Becomes <code>sotyn-erp:{tag || '…'}</code>
            {build ? ' and also tags :latest' : ''}
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={build}
            onChange={(e) => setBuild(e.target.checked)}
            disabled={locked}
          />
          <span>
            <span className="font-medium">Build from current checkout</span>
            <span className="block text-xs text-slate-500">
              Off = rollback to an existing local image tag (no docker build)
            </span>
          </span>
        </label>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1" htmlFor="deploy-keep">
            Keep unused images after deploy
          </label>
          <input
            id="deploy-keep"
            type="number"
            min={0}
            max={50}
            value={keepLatest}
            onChange={(e) => setKeepLatest(e.target.value)}
            disabled={locked}
            className="w-24 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-slate-500 mt-1">
            Auto-prunes this host after success: keeps in-use, <code>:latest</code>, and this many newest unused tags (default 4).
            Manual <strong className="font-medium text-ink">Delete</strong> still available below.
          </p>
        </div>

        <button type="submit" disabled={locked || !tag.trim() || !hostId} className="btn btn-primary w-full sm:w-auto">
          {busy ? 'Deploying…' : build ? 'Build & deploy' : 'Rollback / redeploy'}
        </button>
      </form>

      {job && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden max-w-2xl">
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2 justify-between">
            <h2 className="text-sm font-semibold text-ink">Job {jobId}</h2>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                job.status === 'ok'
                  ? 'bg-emerald-50 text-emerald-800'
                  : job.status === 'error'
                    ? 'bg-red-50 text-red-800'
                    : 'bg-blue-50 text-blue-800'
              }`}
            >
              {job.status}
            </span>
          </div>
          <ul className="max-h-64 overflow-y-auto divide-y divide-slate-100 text-xs font-mono">
            {(job.steps || []).map((s, i) => (
              <li key={i} className="px-4 py-2 text-slate-700">
                <span className="text-slate-400">{s.at?.slice(11, 19) || ''} </span>
                {s.op}
                {s.slug ? ` · ${s.slug}` : ''}
                {s.message ? ` — ${s.message}` : ''}
                {s.ok ? ' ✓' : ''}
              </li>
            ))}
            {(!job.steps || job.steps.length === 0) && (
              <li className="px-4 py-3 text-slate-400">Waiting for steps…</li>
            )}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink">Images on this host</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              After deploy, unused tags auto-prune to keep‑N. Manual Delete for one-offs. Never touches data/.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              Keep
              <input
                type="number"
                min={0}
                max={50}
                value={keepLatest}
                onChange={(e) => setKeepLatest(e.target.value)}
                disabled={locked}
                className="w-14 border border-slate-200 rounded-md px-1.5 py-1 text-xs font-mono"
              />
              unused
            </label>
            <button
              type="button"
              onClick={pruneUnused}
              disabled={locked || unusedBeyondKeep <= 0}
              className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {pruneBusy ? 'Pruning…' : 'Prune unused'}
            </button>
            <button
              type="button"
              onClick={loadImages}
              disabled={locked}
              className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              Refresh
            </button>
          </div>
        </div>
        {images.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No sotyn-erp images yet. Build once or deploy with build on.</p>
        ) : (
          <>
            <div className="md:hidden divide-y divide-slate-100">
              {images.map((img) => (
                <div key={img.ref} className="px-4 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-mono text-sm text-ink">{img.tag}</p>
                      <p className="text-xs text-slate-500">{img.created} · {img.size}</p>
                      {img.inUse ? (
                        <p className="text-xs text-emerald-700 mt-0.5">In use · {(img.usedBy || []).join(', ')}</p>
                      ) : (
                        <p className="text-xs text-slate-400 mt-0.5">Unused</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => pickRollback(img.tag)}
                      className="text-xs text-blue-800 hover:underline"
                      disabled={locked}
                    >
                      Use for rollback
                    </button>
                    {!img.inUse && (
                      <button
                        type="button"
                        onClick={() => deleteTag(img.tag)}
                        className="text-xs text-red-700 hover:underline"
                        disabled={locked}
                      >
                        {deletingTag === img.tag ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Tag</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Size</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {images.map((img) => (
                    <tr key={img.ref} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{img.tag}</td>
                      <td className="px-4 py-2 text-xs">
                        {img.inUse ? (
                          <span className="text-emerald-700">In use · {(img.usedBy || []).join(', ')}</span>
                        ) : (
                          <span className="text-slate-400">Unused</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600 text-xs">{img.created}</td>
                      <td className="px-4 py-2 text-slate-600 text-xs">{img.size}</td>
                      <td className="px-4 py-2 text-right space-x-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => pickRollback(img.tag)}
                          className="text-xs text-blue-800 hover:underline"
                          disabled={locked}
                        >
                          Use for rollback
                        </button>
                        {!img.inUse && (
                          <button
                            type="button"
                            onClick={() => deleteTag(img.tag)}
                            className="text-xs text-red-700 hover:underline"
                            disabled={locked}
                          >
                            {deletingTag === img.tag ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        note={confirm?.note}
        confirmLabel={confirm?.confirmLabel}
        tone={confirm?.tone || 'danger'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.onConfirm;
          setConfirm(null);
          action?.();
        }}
      />
    </div>
  );
}
