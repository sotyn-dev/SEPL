import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import PencilBanner from '../components/PencilBanner.jsx';
import ExportDevConfigDialog from '../components/ExportDevConfigDialog.jsx';
import { modulesOnDisplay, planLabelForClass } from '../fixtures/packs.js';

function dataPathFor(t) {
  if (t?.dataPath) return t.dataPath;
  return `/var/lib/sotyn/tenants/${t?.slug || '…'}/data`;
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

  useEffect(() => {
    setError('');
    setHostMsg('');
    setHostErr('');
    setHostUnlocked(false);
    api(`/api/tenants/${slug}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Not found');
        setTenant(d.tenant);
        setHostname(d.tenant.hostname || '');
      })
      .catch((e) => setError(String(e.message || e)));
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
    </div>
  );
}
