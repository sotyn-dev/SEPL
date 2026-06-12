import { FiArrowRight } from 'react-icons/fi';
import { STAGES, SIDE_STATES } from '../data/l2dStages';

const tone = {
  red:    'border-red-200 bg-red-50 text-red-700',
  yellow: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  blue:   'border-blue-200 bg-blue-50 text-blue-700',
};

export default function FunnelSummary({ stats, active, onPick }) {
  if (!stats) return null;
  const counts = stats.counts || {};

  return (
    <div className="bg-white rounded-lg border">
      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        {/* Left column */}
        <div className="divide-y divide-gray-100">
          <IndexRow label="All Leads" count={stats.total || 0} myKey="" active={active} onPick={onPick} />
          {STAGES.slice(0, Math.ceil(STAGES.length / 2)).map(s => (
            <IndexRow key={s.key} label={s.label} count={counts[s.key] || 0} myKey={s.key} active={active} onPick={onPick} />
          ))}
        </div>
        {/* Right column */}
        <div className="divide-y divide-gray-100">
          {STAGES.slice(Math.ceil(STAGES.length / 2)).map(s => (
            <IndexRow key={s.key} label={s.label} count={counts[s.key] || 0} myKey={s.key} active={active} onPick={onPick} />
          ))}
        </div>
      </div>

      {/* Side state pills */}
      <div className="flex flex-wrap gap-2 px-3 py-2 border-t border-gray-100">
        {SIDE_STATES.map(s => {
          const isActive = active === s.key;
          const count = counts[s.key] || 0;
          return (
            <button
              key={s.key}
              onClick={() => onPick(isActive ? '' : s.key)}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition
                ${tone[s.tone]} ${isActive ? 'ring-2 ring-offset-1 ring-current font-semibold' : 'opacity-80 hover:opacity-100'}`}
            >
              {s.label}
              <span className="font-bold">{count}</span>
              <FiArrowRight size={10} className={isActive ? 'opacity-100' : 'opacity-40'} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IndexRow({ label, count, myKey, active, onPick }) {
  const isActive = active === myKey;
  const hasLeads = count > 0;
  return (
    <button
      onClick={() => onPick(isActive ? '' : myKey)}
      className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors
        ${isActive
          ? 'bg-blue-50 border-l-[3px] border-blue-500'
          : 'border-l-[3px] border-transparent hover:bg-gray-50'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasLeads ? 'bg-blue-400' : 'bg-gray-200'}`} />
        <span className={`text-xs truncate ${isActive ? 'font-semibold text-blue-700' : hasLeads ? 'text-gray-700' : 'text-gray-400'}`}>
          {label}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-3">
        <span className={`text-sm font-bold tabular-nums ${hasLeads ? (isActive ? 'text-blue-600' : 'text-gray-700') : 'text-gray-300'}`}>
          {count}
        </span>
        <FiArrowRight size={11} className={isActive ? 'text-blue-500' : 'text-gray-300'} />
      </div>
    </button>
  );
}
