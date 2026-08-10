import PencilBanner from '../components/PencilBanner.jsx';

const ROWS = [
  { plan: 'Chat only', modules: 'site_chat (+ optional AI pack)' },
  { plan: 'Feature apps', modules: 'chassis + Chat + Flow' },
  { plan: 'Full ERP', modules: '~ERP baseline + sold packs' },
];

export default function PlansPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink">Plans</h1>
        <p className="text-sm text-slate-600 mt-1">
          Pricing / packaging placeholder — shape TBD (matches sketch §6).
        </p>
      </div>

      <PencilBanner>
        Later stub only. No prices, no Stripe, no plan rows in the database.
      </PencilBanner>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Feature packages</h2>
          <button
            type="button"
            disabled
            className="text-sm px-3 py-1.5 rounded-lg bg-slate-100 text-slate-400 cursor-not-allowed self-start sm:self-auto"
          >
            + New plan
          </button>
        </div>
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Modules</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Used by</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.plan} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium">{r.plan}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.modules}</td>
                <td className="px-4 py-3 text-slate-400" colSpan={2}>
                  Shape TBD — pricing screens not designed
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
