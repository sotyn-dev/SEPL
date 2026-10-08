import { useCallback, useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import Modal from './Modal';
import NumberedTable from './NumberedTable';

// All four screens read the same company-wide endpoint, independent of their
// own date/search/employee filters. Never display a failed request as zero.
export default function ActiveProjectsMetric({ className = '' }) {
  const { isAdmin } = useAuth();
  const [metric, setMetric] = useState(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [detailsError, setDetailsError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh(n => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    api.get('/dashboard/active-projects', { signal: controller.signal })
      .then(({ data }) => { setMetric(data); setError(false); })
      .catch(() => { if (!controller.signal.aborted) { setMetric(null); setError(true); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const visibleRefresh = () => { if (!document.hidden) reload(); };
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 60000);
    return () => {
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
      window.clearInterval(timer);
    };
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDetails(null); setDetailsError(false);
    api.get('/dashboard/active-projects?details=1', { signal: controller.signal })
      .then(({ data }) => { setDetails(data); setMetric(data); setError(false); })
      .catch(() => { if (!controller.signal.aborted) setDetailsError(true); });
    return () => controller.abort();
  }, [open, refresh]);

  return (
    <section aria-label="Active Projects" className={`rounded-xl border border-blue-100 bg-white p-3 text-gray-800 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-gray-600">Active Projects</div>
          <div className="text-2xl font-bold text-blue-700" aria-live="polite">{metric?.count ?? '—'}</div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {isAdmin() && <button type="button" onClick={() => setOpen(true)} className="text-blue-700 underline">View projects</button>}
          <button type="button" onClick={reload} disabled={busy} className="rounded border px-2 py-1 disabled:opacity-50" aria-label="Refresh active projects">{busy ? 'Updating…' : 'Refresh'}</button>
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-500" title={metric?.definition}>Company-wide · at least one Active site · duplicates counted once</p>
      <p className={`mt-1 text-[11px] ${error ? 'text-red-600' : 'text-gray-400'}`}>
        {error ? 'Count unavailable. Please retry.' : metric ? `Updated ${new Date(metric.as_of).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Loading count…'}
      </p>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Active Projects — counted records" wide>
        {detailsError ? <p className="text-red-600">Could not load projects. <button onClick={reload} className="underline">Retry</button></p> : !details ? <p>Loading projects…</p> : <>
          <p className="text-sm text-gray-600">{details.definition}</p>
          <p className="my-3 text-sm font-semibold">{details.count} projects from {details.active_site_rows} active site records</p>
          {details.unlinked_site_rows > 0 && <p className="mb-3 text-xs text-amber-700">{details.unlinked_site_rows} site records have no valid Business Book link. They use an unambiguous matching site name, or their own site name, until linked.</p>}
          <div className="overflow-x-auto"><NumberedTable className="w-full text-left text-sm">
            <thead><tr><th className="p-2">Project</th><th className="p-2 text-right">Active site records</th></tr></thead>
            <tbody>{details.projects.map(project => <tr key={project.project_key} className="border-t"><td className="p-2">{project.name}</td><td className="p-2 text-right">{project.active_site_rows}</td></tr>)}</tbody>
          </NumberedTable></div>
          {!details.projects.length && <p className="py-4 text-gray-500">No projects currently have an Active site.</p>}
        </>}
      </Modal>
    </section>
  );
}
