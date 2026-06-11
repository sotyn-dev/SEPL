import { STAGES, SIDE_STATES } from '../data/l2dStages';

// Funnel summary — count per stage + side states. Stage-config driven so a
// future lead source reuses it unchanged. `stats` is the /stats payload;
// `active` is the currently-filtered stage; clicking a tile filters the table.
export default function FunnelSummary({ stats, active, onPick }) {
  if (!stats) return null;
  const counts = stats.counts || {};

  const tone = {
    red: 'border-red-200 bg-red-50 text-red-700',
    yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Tile label="All Leads" count={stats.total || 0} activeKey={active} myKey="" onPick={onPick} />
        {STAGES.map(s => (
          <Tile key={s.key} label={s.label} count={counts[s.key] || 0} activeKey={active} myKey={s.key} onPick={onPick} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {SIDE_STATES.map(s => (
          <button
            key={s.key}
            onClick={() => onPick(active === s.key ? '' : s.key)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition ${tone[s.tone]} ${active === s.key ? 'ring-2 ring-offset-1 ring-current' : 'opacity-90 hover:opacity-100'}`}
          >
            {s.label}: <span className="font-bold">{counts[s.key] || 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, count, activeKey, myKey, onPick }) {
  const isActive = activeKey === myKey;
  return (
    <button
      onClick={() => onPick(isActive ? '' : myKey)}
      className={`min-w-[92px] text-left px-3 py-2 rounded-lg border transition
        ${isActive ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400' : 'border-gray-200 bg-white hover:border-blue-300'}`}
    >
      <div className="text-[11px] text-gray-500 truncate">{label}</div>
      <div className="text-lg font-bold text-gray-800">{count}</div>
    </button>
  );
}
