import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

function suggestTag() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}-v1`;
}

export default function DeployPage() {
  const [tag, setTag] = useState(suggestTag);
  const [build, setBuild] = useState(true);
  const [images, setImages] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const loadImages = useCallback(() => {
    api('/api/deploy/images')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to list images');
        setImages(d.images || []);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    loadImages();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
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
        const r = await api(`/api/deploy/jobs/${id}`);
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
    setJob(null);
    setBusy(true);
    try {
      const r = await api('/api/deploy', {
        method: 'POST',
        body: JSON.stringify({ tag: tag.trim(), build }),
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Deploy</h1>
        <p className="text-slate-600 mt-1 text-sm max-w-2xl">
          Pull <code className="text-xs bg-white px-1 rounded">main</code> on the host first.
          This builds (optional) and recreates all tenant containers on the local agent.
          Host <code className="text-xs bg-white px-1 rounded">data/</code> is never deleted.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">
          {error}
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
            disabled={busy}
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
            disabled={busy}
          />
          <span>
            <span className="font-medium">Build from current checkout</span>
            <span className="block text-xs text-slate-500">
              Off = rollback to an existing local image tag (no docker build)
            </span>
          </span>
        </label>

        <button type="submit" disabled={busy || !tag.trim()} className="btn btn-primary w-full sm:w-auto">
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
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Local sotyn-erp images</h2>
          <button
            type="button"
            onClick={loadImages}
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
        {images.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No sotyn-erp images yet. Build once or deploy with build on.</p>
        ) : (
          <>
            <div className="md:hidden divide-y divide-slate-100">
              {images.map((img) => (
                <button
                  key={img.ref}
                  type="button"
                  onClick={() => pickRollback(img.tag)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50"
                >
                  <p className="font-mono text-sm text-ink">{img.tag}</p>
                  <p className="text-xs text-slate-500">{img.created} · {img.size}</p>
                </button>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Tag</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 font-medium">Size</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {images.map((img) => (
                    <tr key={img.ref} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{img.tag}</td>
                      <td className="px-4 py-2 text-slate-600 text-xs">{img.created}</td>
                      <td className="px-4 py-2 text-slate-600 text-xs">{img.size}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => pickRollback(img.tag)}
                          className="text-xs text-blue-800 hover:underline"
                          disabled={busy}
                        >
                          Use for rollback
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
