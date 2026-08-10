import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, uploadFile } from '../lib/api.js';

const empty = {
  displayName: '',
  shortName: '',
  legalName: '',
  productMark: '',
  showPoweredBy: true,
  loginTagline: '',
};

const UPLOAD_SLOTS = [
  { kind: 'logo', label: 'Logo', accept: '.webp,.png,.jpg,.jpeg,.svg', hint: 'Login + sidebar mark' },
  { kind: 'logoPng', label: 'Logo (PNG)', accept: '.png', hint: 'Print / fallback' },
  { kind: 'icon', label: 'App icon', accept: '.svg,.png,.webp', hint: 'PWA / home screen' },
  { kind: 'favicon', label: 'Favicon', accept: '.svg,.png,.ico', hint: 'Browser tab' },
];

function assetUrl(slug, assets, kind, bust) {
  const ref = assets?.[kind];
  if (!ref) return null;
  const file = String(ref).split('/').pop();
  const q = bust ? `?t=${encodeURIComponent(bust)}` : '';
  return `/api/branding/${slug}/assets/${file}${q}`;
}

export default function BrandPage() {
  const { slug } = useParams();
  const [branding, setBranding] = useState(null);
  const [form, setForm] = useState(empty);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(null);

  const applyBranding = (b) => {
    setBranding(b);
    setForm({
      displayName: b.displayName || '',
      shortName: b.shortName || '',
      legalName: b.legalName || '',
      productMark: b.productMark || '',
      showPoweredBy: !!b.showPoweredBy,
      loginTagline: b.loginTagline || '',
    });
  };

  useEffect(() => {
    setMsg('');
    setError('');
    api(`/api/branding/${slug}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Load failed');
        applyBranding(d.branding);
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
    applyBranding(d.branding);
    setMsg('Saved in platform.db — not pushed to ERP yet.');
  };

  const onUpload = async (kind, file) => {
    if (!file) return;
    setUploading(kind);
    setMsg('');
    setError('');
    try {
      const r = await uploadFile(`/api/branding/${slug}/assets/${kind}`, file);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      applyBranding(d.branding);
      setMsg(`Uploaded ${kind} → durable store (platform/data/tenants/${slug}/assets/).`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setUploading(null);
    }
  };

  const bust = branding?.updatedAt || '';
  const logoUrl = assetUrl(slug, branding?.assets, 'logo', bust)
    || assetUrl(slug, branding?.assets, 'logoPng', bust);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-teal-700 font-semibold mb-1">White-label</p>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink break-all">{slug}</h1>
          <p className="text-sm text-slate-600 mt-1">
            Platform SoT for name + logo. Uploads land in durable store; seed is fallback only.
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
          <div className="rounded-xl overflow-hidden shadow-lg border border-slate-200 bg-gradient-to-br from-blue-800 to-blue-950">
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
              <div className="h-10 rounded-lg btn-primary flex items-center justify-center shadow-none">
                Sign in
              </div>
              {form.showPoweredBy && (
                <p className="text-[10px] text-center text-slate-400 uppercase tracking-widest">Powered by Sotyn</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Brand assets</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Writes to <code className="bg-slate-50 px-1 rounded">platform/data/tenants/{slug}/assets/</code>
                {' '}(gitignored). Seed used only if no durable file.
              </p>
            </div>
            <ul className="space-y-3">
              {UPLOAD_SLOTS.map((slot) => {
                const preview = assetUrl(slug, branding?.assets, slot.kind, bust);
                const busy = uploading === slot.kind;
                return (
                  <li
                    key={slot.kind}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 border border-slate-100 rounded-lg p-3"
                  >
                    <div className="w-14 h-14 shrink-0 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center overflow-hidden">
                      {preview ? (
                        <img src={preview} alt="" className="w-full h-full object-contain p-1" />
                      ) : (
                        <span className="text-[10px] text-slate-400">—</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{slot.label}</p>
                      <p className="text-xs text-slate-500">{slot.hint}</p>
                      {branding?.assets?.[slot.kind] && (
                        <p className="text-[11px] font-mono text-slate-400 mt-0.5 truncate">
                          {branding.assets[slot.kind]}
                        </p>
                      )}
                    </div>
                    <label className="btn btn-secondary text-xs cursor-pointer shrink-0 self-start sm:self-auto">
                      {busy ? 'Uploading…' : 'Upload'}
                      <input
                        type="file"
                        className="hidden"
                        accept={slot.accept}
                        disabled={!!uploading}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          onUpload(slot.kind, f);
                        }}
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
