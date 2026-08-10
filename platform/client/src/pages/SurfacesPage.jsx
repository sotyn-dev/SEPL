const ROWS = [
  { p: 'P0', surface: 'Login', erp: 'Login.jsx — logo, legal line, tagline', field: 'logo, displayName, productMark, loginTagline' },
  { p: 'P0', surface: 'Sidebar / header', erp: 'Layout.jsx', field: 'logo, displayName, shortName' },
  { p: 'P0', surface: 'Title + favicon + PWA', erp: 'index.html, manifest.json', field: 'pwa.*, favicon/icon (ERP shared theme colors)' },
  { p: 'P1', surface: 'Email from / footer', erp: 'mailer templates', field: 'displayName, legalName' },
  { p: 'P2', surface: 'Print / PDF letterhead', erp: 'VendorPOPrint, OfferLetter, NDA, Indent…', field: 'legalName, logo (+ address later)' },
];

export default function SurfacesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">ERP surfaces</h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl break-words">
          Checklist for later integration. Full notes:{' '}
          <code className="text-xs bg-white px-1 rounded break-all">platform/contracts/white-label-surfaces.md</code>
        </p>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {ROWS.map((r) => (
          <div key={r.surface} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-teal-800">{r.p}</span>
              <span className="font-medium text-sm text-ink">{r.surface}</span>
            </div>
            <p className="text-xs text-slate-600">{r.erp}</p>
            <p className="text-[11px] font-mono text-slate-500 break-all">{r.field}</p>
          </div>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Pri</th>
              <th className="px-4 py-3">Surface</th>
              <th className="px-4 py-3">Current ERP</th>
              <th className="px-4 py-3">Branding fields</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.surface} className="border-t border-slate-100 align-top">
                <td className="px-4 py-3 font-mono text-xs text-teal-800">{r.p}</td>
                <td className="px-4 py-3 font-medium">{r.surface}</td>
                <td className="px-4 py-3 text-slate-600">{r.erp}</td>
                <td className="px-4 py-3 text-slate-600 font-mono text-xs">{r.field}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Do not use Secured artwork as the missing-logo fallback for other tenants — use a generic Sotyn mark.
      </p>
    </div>
  );
}
