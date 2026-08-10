import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import PencilBanner from '../components/PencilBanner.jsx';
import {
  PACK_CATALOG,
  PLAN_TEMPLATES,
  defaultPackState,
} from '../fixtures/packs.js';

export default function EntitlementsPage() {
  const { slug } = useParams();
  const [tenant, setTenant] = useState(null);
  const [error, setError] = useState('');
  const [templateId, setTemplateId] = useState('full_erp');
  const [packs, setPacks] = useState(() => defaultPackState('mepf_erp'));
  const [toast, setToast] = useState('');

  useEffect(() => {
    api(`/api/tenants/${slug}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Not found');
        setTenant(d.tenant);
        const next = defaultPackState(d.tenant.tenantClass);
        setPacks(next);
        if (d.tenant.tenantClass === 'feature_only') setTemplateId('feature_apps');
        else if (d.tenant.tenantClass === 'exclusive_app') setTemplateId('chat_only');
        else setTemplateId('full_erp');
      })
      .catch((e) => setError(String(e.message || e)));
  }, [slug]);

  const applyTemplate = (id) => {
    setTemplateId(id);
    const tpl = PLAN_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const next = {};
    for (const p of PACK_CATALOG) {
      next[p.key] = p.locked || tpl.packs.includes(p.key);
    }
    setPacks(next);
  };

  const toggle = (key) => {
    const pack = PACK_CATALOG.find((p) => p.key === key);
    if (pack?.locked) return;
    setPacks((s) => ({ ...s, [key]: !s[key] }));
  };

  const groups = useMemo(() => {
    const order = ['always', 'erp', 'apps', 'optional'];
    return order
      .map((g) => ({
        id: g,
        items: PACK_CATALOG.filter((p) => p.group === g),
      }))
      .filter((g) => g.items.length);
  }, []);

  const savePencil = (e) => {
    e.preventDefault();
    setToast('Not saved — entitlements persistence lands in the next build plan.');
  };

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
        <Link to="/" className="text-sm text-teal-700 hover:underline">← Companies</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link to={`/orgs/${slug}`} className="text-xs text-blue-800 hover:underline">← Overview</Link>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink mt-1 break-words">
            Entitlements{tenant ? ` · ${tenant.displayName}` : ''}
          </h1>
          <p className="text-xs text-slate-500 mt-1 font-mono break-all">
            effective = entitled × (role permission inside tenant)
          </p>
        </div>
        <button
          type="button"
          onClick={savePencil}
          className="btn btn-primary w-full sm:w-auto opacity-80"
        >
          Save
        </button>
      </div>

      <PencilBanner>
        Pack toggles are fixture-only. Nothing is written to <code className="text-xs">platform.db</code> or pushed to a tenant container.
      </PencilBanner>

      {toast && (
        <p className="text-sm text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{toast}</p>
      )}

      <label className="block text-xs font-semibold text-slate-600 space-y-1 max-w-xs">
        Plan template
        <select
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-normal"
          value={templateId}
          onChange={(e) => applyTemplate(e.target.value)}
        >
          {PLAN_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>

      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g.id} className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {g.id}
            </div>
            <ul className="divide-y divide-slate-100">
              {g.items.map((p) => (
                <li key={p.key} className="flex items-start sm:items-center justify-between gap-3 sm:gap-4 px-3 sm:px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.desc}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!packs[p.key]}
                    disabled={p.locked}
                    onClick={() => toggle(p.key)}
                    className={`relative w-11 h-6 rounded-full transition shrink-0 mt-0.5 sm:mt-0 ${
                      packs[p.key] ? 'bg-blue-800' : 'bg-slate-300'
                    } ${p.locked ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition ${
                        packs[p.key] ? 'translate-x-5' : ''
                      }`}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        Trap avoided later: these toggles must not live as source-of-truth inside the company’s erp.db.
      </p>
    </div>
  );
}
