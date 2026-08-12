import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { modulesOnDisplay, planLabelForClass } from '../fixtures/packs.js';

export default function OrgsPage() {
  const [tenants, setTenants] = useState([]);
  const [hosts, setHosts] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [provisionBusy, setProvisionBusy] = useState('');
  const [form, setForm] = useState({
    slug: '',
    displayName: '',
    hostname: '',
    tenantClass: 'mepf_erp',
    hostId: 'host_local',
    provision: false,
  });
  const [hostnameTouched, setHostnameTouched] = useState(false);

  const load = () => {
    api('/api/tenants')
      .then((r) => r.json())
      .then((d) => setTenants(d.tenants || []))
      .catch((e) => setError(String(e.message || e)));
    api('/api/hosts')
      .then((r) => r.json())
      .then((d) => {
        const list = d.hosts || [];
        setHosts(list);
        setForm((f) => {
          if (list.some((h) => h.id === f.hostId)) return f;
          return { ...f, hostId: list[0]?.id || 'host_local' };
        });
      })
      .catch(() => {});
  };

  useEffect(load, []);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const r = await api('/api/tenants', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (!r.ok && !d.tenant) {
        setError(d.error || 'Create failed');
        return;
      }
      if (!r.ok && d.tenant) {
        setError(d.error || 'Provision failed — draft saved');
        setNotice(d.note || '');
      } else if (form.provision) {
        setNotice(`Created and provisioned ${d.tenant.slug} on ${d.tenant.hostId}.`);
      } else {
        setNotice(`Draft ${d.tenant.slug} on ${d.tenant.hostId}.`);
      }
      setForm((f) => ({
        slug: '',
        displayName: '',
        hostname: '',
        tenantClass: 'mepf_erp',
        hostId: f.hostId,
        provision: false,
      }));
      setHostnameTouched(false);
      setShowCreate(false);
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const provision = async (t) => {
    setError('');
    setNotice('');
    setProvisionBusy(t.slug);
    try {
      const r = await api(`/api/tenants/${encodeURIComponent(t.slug)}/provision`, {
        method: 'POST',
        body: JSON.stringify({ hostId: t.hostId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Provision failed');
      setNotice(`Provisioned ${d.tenant.slug} on ${d.tenant.hostId}.`);
      load();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setProvisionBusy('');
    }
  };

  const hostLabel = (id) => hosts.find((h) => h.id === id)?.label || id;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Companies</h1>
          <p className="text-slate-600 mt-1 text-sm max-w-2xl">
            Home of the control room. Slug is the fixed data key; hostname is the public URL (editable).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="btn btn-primary w-full sm:w-auto shrink-0"
        >
          + New company
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 break-words">{error}</p>
      )}
      {notice && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 break-words">{notice}</p>
      )}

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {tenants.map((t) => (
          <Link
            key={t.id}
            to={`/orgs/${t.slug}`}
            className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm active:bg-slate-50"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink truncate">{t.displayName}</p>
                <p className="font-mono text-[11px] text-slate-500 truncate mt-0.5">{t.hostname}</p>
              </div>
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-teal-50 text-teal-800 border border-teal-100 shrink-0">
                {t.status}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>{planLabelForClass(t.tenantClass)}</span>
              <span className="font-mono">{hostLabel(t.hostId)}</span>
              <span className="font-mono">{modulesOnDisplay(t.tenantClass)}</span>
            </div>
            {t.status === 'draft' && (
              <button
                type="button"
                className="mt-3 text-xs font-medium text-blue-800 hover:underline"
                disabled={!!provisionBusy}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); provision(t); }}
              >
                {provisionBusy === t.slug ? 'Provisioning…' : 'Provision on host'}
              </button>
            )}
          </Link>
        ))}
        {!tenants.length && (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-slate-500 text-sm">
            No tenants yet — start the platform API so sepl can seed.
          </p>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-semibold">Company</th>
              <th className="px-4 py-3 font-semibold">Host</th>
              <th className="px-4 py-3 font-semibold">Plan</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Modules on</th>
              <th className="px-4 py-3 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="px-4 py-3">
                  <p className="font-medium text-ink">{t.displayName}</p>
                  <p className="font-mono text-[11px] text-slate-500">{t.hostname}</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">
                  {hostLabel(t.hostId)}
                  <span className="block text-[10px] text-slate-400">{t.hostId}</span>
                </td>
                <td className="px-4 py-3 text-slate-600">{planLabelForClass(t.tenantClass)}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-teal-50 text-teal-800 border border-teal-100">
                    {t.status}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">
                  {modulesOnDisplay(t.tenantClass)}
                  <span className="block text-[10px] text-slate-400 normal-case">fixture estimate</span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                  {t.status === 'draft' && (
                    <button
                      type="button"
                      className="text-xs text-blue-800 font-medium hover:underline"
                      disabled={!!provisionBusy}
                      onClick={() => provision(t)}
                    >
                      {provisionBusy === t.slug ? 'Provisioning…' : 'Provision'}
                    </button>
                  )}
                  <Link
                    className="text-blue-800 font-medium hover:underline text-sm"
                    to={`/orgs/${t.slug}`}
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {!tenants.length && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No tenants yet — start the platform API so sepl can seed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <form onSubmit={create} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-4 max-w-xl w-full">
          <h2 className="font-semibold text-ink">Create company</h2>
          <p className="text-xs text-slate-500">
            Assign a worker host now. Optionally provision Docker immediately (needs agent + image on that host).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              Slug
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm"
                value={form.slug}
                onChange={(e) => {
                  const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                  setForm((f) => ({
                    ...f,
                    slug,
                    hostname: hostnameTouched ? f.hostname : (slug ? `${slug}-erp.sotyn.com` : ''),
                  }));
                }}
                placeholder="pharma"
                required
                autoCapitalize="none"
                autoCorrect="off"
              />
              <span className="font-normal text-slate-400">Fixed disk / TENANT_ID key — do not rename later</span>
            </label>
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              Display name
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm"
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="Concern Pharma"
                required
              />
            </label>
          </div>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Hostname
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono"
              value={form.hostname}
              onChange={(e) => {
                setHostnameTouched(true);
                setForm((f) => ({
                  ...f,
                  hostname: e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''),
                }));
              }}
              placeholder="pharma-erp.sotyn.com"
              required
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="font-normal text-slate-400">Public URL — can differ from slug (e.g. concern-pharma.sotyn.com)</span>
          </label>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Worker host
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm"
              value={form.hostId}
              onChange={(e) => setForm((f) => ({ ...f, hostId: e.target.value }))}
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>{h.label} ({h.id})</option>
              ))}
              {!hosts.length && <option value="host_local">host_local</option>}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            Tenant class
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm"
              value={form.tenantClass}
              onChange={(e) => setForm((f) => ({ ...f, tenantClass: e.target.value }))}
            >
              <option value="mepf_erp">MEPF / ERP</option>
              <option value="feature_only">Feature-only</option>
              <option value="exclusive_app">Exclusive-app</option>
            </select>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.provision}
              onChange={(e) => setForm((f) => ({ ...f, provision: e.target.checked }))}
            />
            <span>
              Provision on host now
              <span className="block text-xs text-slate-500">
                Calls the agent to create data/backups mounts + container. Requires Docker image on that host.
              </span>
            </span>
          </label>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="btn btn-secondary"
            >
              Cancel
            </button>
            <button type="submit" disabled={busy} className="btn btn-primary">
              {busy ? 'Working…' : (form.provision ? 'Create & provision' : 'Create draft')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
