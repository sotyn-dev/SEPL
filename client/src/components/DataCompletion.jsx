// Data Completion bar — "how much of the required data is actually filled".
//
// MD 2026-09-03: "count this full kitting on above like data completion and
// want to take in data entry score" — the bar that was only on Item Master is
// now wanted on Business Book, Employees and Users too, and the same numbers
// feed the Data Entry KPI on the scorecard.
//
// One component, one endpoint shape. The server owns WHICH fields are required
// per module (server/lib/dataCompletion.js) so the bar, the missing-field chips
// and the scorecard can never drift apart by measuring different things.
//
// Usage:  <DataCompletion module="business_book" />
import { useEffect, useState } from 'react';
import api from '../api';

export default function DataCompletion({ module, onFieldClick = null, className = '' }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/data-completion/${module}`)
      .then(r => { if (alive) setData(r.data); })
      .catch(() => { if (alive) setData(null); });   // never break the page it sits on
    return () => { alive = false; };
  }, [module]);

  if (!data || !data.total_items) return null;

  const pct = data.required_total ? Math.round((data.filled_total / data.required_total) * 100) : 0;
  const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500';
  const missing = (data.per_field || []).filter(f => f.missing > 0).sort((a, b) => b.missing - a.missing);
  const n = (v) => Number(v || 0).toLocaleString('en-IN');

  return (
    <div className={`bg-white border rounded-lg p-3 space-y-2 ${className}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="font-semibold text-sm text-gray-700">📊 Data Completion</div>
        <div className="text-xs text-gray-500">
          <b className="text-gray-800">{n(data.filled_total)}</b> / {n(data.required_total)} fields filled
          {' · '}<b className="text-emerald-700">{n(data.complete_items)}</b> of {n(data.total_items)} {data.noun || 'records'} fully complete
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="text-sm font-bold w-12 text-right">{pct}%</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {missing.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFieldClick && onFieldClick(f)}
            className={`text-[10px] px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 ${onFieldClick ? 'hover:bg-red-50 hover:border-red-300 cursor-pointer' : 'cursor-default'}`}
          >
            {f.label || f.key}: <b className="text-red-600">{n(f.missing)}</b> missing
          </button>
        ))}
        {!missing.length && (
          <span className="text-[11px] text-emerald-700 font-semibold">✓ Every required field is filled</span>
        )}
      </div>
    </div>
  );
}
