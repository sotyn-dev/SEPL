import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const empty = {
  displayName: '',
  shortName: '',
  legalName: '',
  productMark: '',
  showPoweredBy: true,
  themeColor: '#0d9488',
  accentColor: '#0f766e',
  loginTagline: '',
};

export default function BrandPage() {
  const { slug } = useParams();
  const [branding, setBranding] = useState(null);
  const [form, setForm] = useState(empty);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setMsg('');
    setError('');
    api(`/api/branding/${slug}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Load failed');
        setBranding(d.branding);
        setForm({
          displayName: d.branding.displayName || '',
          shortName: d.branding.shortName || '',
          legalName: d.branding.legalName || '',
          productMark: d.branding.productMark || '',
          showPoweredBy: !!d.branding.showPoweredBy,
          themeColor: d.branding.themeColor || '#0d9488',
          accentColor: d.branding.accentColor || '#0f766e',
          loginTagline: d.branding.loginTagline || '',
        });
      })
      .catch((e) => setError(String(e.message || e)));
  }, [slug]);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    setError('');
    const r = await api(`/api/branding/${slug}`, {
      method: 'PUT',
      body: JSON.stringify(form),
    });
    const d = await r.json();
    if (!r.ok) {
      setError(d.error || 'Save failed');
      return;
    }
    setBranding(d.branding);
    setMsg('Saved in platform.db — not pushed to ERP yet.');
  };

  const logoUrl = branding?.assets?.logo
    ? `/api/branding/${slug}/assets/${String(branding.assets.logo).split('/').pop()}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-teal-700 font-semibold mb-1">White-label pencil</p>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink break-all">{slug}</h1>
          <p className="text-sm text-slate-600 mt-1">
            Platform SoT for name + logo. ERP still hardcodes Secured until materialize lands.
          </p>
        </div>
        <Link to={`/orgs/${slug}`} className="text-sm text-blue-800 hover:underline">← Overview</Link>
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
      {msg && <p className="text-sm text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-3 py-2">{msg}</p>}

      <div className="grid lg:grid-cols-2 gap-6">
        <form onSubmit={save} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-3">
          {[
            ['displayName', 'Display name'],
            ['shortName', 'Short name'],
            ['legalName', 'Legal name'],
            ['productMark', 'Product mark (optional)'],
            ['loginTagline', 'Login tagline'],
            ['themeColor', 'Theme color'],
            ['accentColor', 'Accent color'],
          ].map(([key, label]) => (
            <label key={key} className="block text-xs font-semibold text-slate-600 space-y-1">
              {label}
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-normal"
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.showPoweredBy}
              onChange={(e) => setForm((f) => ({ ...f, showPoweredBy: e.target.checked }))}
            />
            Show “Powered by Sotyn”
          </label>
          <button type="submit" className="btn btn-primary">
            Save branding
          </button>
        </form>

        <div className="space-y-4">
          <div
            className="rounded-xl overflow-hidden shadow-lg border border-slate-200"
            style={{ background: `linear-gradient(135deg, ${form.themeColor}, ${form.accentColor})` }}
          >
            <div className="bg-white m-4 rounded-lg p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center overflow-hidden">
                  {logoUrl ? (
                    <img src={logoUrl} alt="" className="w-full h-full object-contain p-1" />
                  ) : (
                    <span className="text-[10px] text-slate-400">Sotyn</span>
                  )}
                </div>
                <div>
                  <p className="font-bold text-ink leading-tight">{form.productMark || form.displayName || 'Org'}</p>
                  <p className="text-xs text-slate-500">{form.legalName || form.displayName}</p>
                </div>
              </div>
              <div>
                <p className="text-xl font-semibold text-ink">Welcome back</p>
                <p className="text-sm text-slate-500 mt-1">{form.loginTagline || 'Sign in'}</p>
              </div>
              <div className="h-9 rounded-lg bg-slate-100" />
              <div className="h-9 rounded-lg bg-slate-100" />
              <div className="h-10 rounded-lg text-white text-sm font-medium flex items-center justify-center" style={{ background: form.themeColor }}>
                Sign in
              </div>
              {form.showPoweredBy && (
                <p className="text-[10px] text-center text-slate-400 uppercase tracking-widest">Powered by Sotyn</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 space-y-2">
            <p className="font-semibold text-ink text-sm">Seed assets ({slug})</p>
            {branding?.assets ? (
              <ul className="font-mono space-y-1">
                {Object.entries(branding.assets).map(([k, v]) => (
                  <li key={k}>{k}: {v}</li>
                ))}
              </ul>
            ) : (
              <p>No assets yet — upload / seed later.</p>
            )}
            <p className="text-slate-500 pt-1">
              Secured logos live under <code>platform/seed/tenants/secured/assets/</code> — tenant-scoped, not global default.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
