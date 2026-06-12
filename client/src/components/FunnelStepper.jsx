import { FiCheck, FiArrowRight, FiZap } from 'react-icons/fi';
import { STAGES, SIDE_STATES, STAGE_BY_KEY, stageOrder, isSideState } from '../data/l2dStages';

const toneBanner = {
  red:    'bg-red-50 text-red-800 border-red-200',
  yellow: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  blue:   'bg-blue-50 text-blue-800 border-blue-200',
};

// Responsive grid stepper — 12 stages as cards (3 cols md+, 2 cols sm, 1 col xs).
// Each card shows order, label, status. Arrow button = quick-move shortcut.
export default function FunnelStepper({ stage, onStageClick, busy }) {
  const side = isSideState(stage);
  const currentOrder = side ? 0 : stageOrder(stage);

  return (
    <div className="space-y-3">
      {side && (
        <div className={`text-xs px-3 py-2 rounded-lg border font-medium ${toneBanner[STAGE_BY_KEY[stage]?.tone] || toneBanner.yellow}`}>
          {STAGE_BY_KEY[stage]?.label || stage}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {STAGES.map(s => {
          const done    = currentOrder > s.order;
          const current = currentOrder === s.order;
          const future  = currentOrder < s.order;

          return (
            <div
              key={s.key}
              className={`relative rounded-lg border p-2 flex flex-col gap-1 transition-all
                ${current ? 'border-blue-400 bg-blue-50 shadow-sm ring-1 ring-blue-300'
                  : done  ? 'border-green-200 bg-green-50'
                  : 'border-gray-200 bg-white'}
              `}
            >
              {/* Order badge + status icon */}
              <div className="flex items-center justify-between">
                <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0
                  ${done ? 'bg-green-500 text-white' : current ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  {done ? <FiCheck size={10} /> : s.order}
                </span>
                <div className="flex items-center gap-1">
                  {s.whatsapp && <span className="text-[9px] font-semibold text-green-600">WA</span>}
                  {s.auto && <FiZap size={9} className={done ? 'text-green-400' : current ? 'text-blue-400' : 'text-gray-300'} />}
                </div>
              </div>

              {/* Label */}
              <span className={`text-[11px] leading-tight font-medium
                ${current ? 'text-blue-700' : done ? 'text-green-700' : 'text-gray-400'}`}>
                {s.label}
              </span>

              {/* Arrow shortcut — only shown when onStageClick is provided and not current/done */}
              {onStageClick && !current && (
                <button
                  onClick={() => onStageClick(s.key)}
                  disabled={busy}
                  title={`Move to ${s.label}`}
                  className={`self-end mt-auto flex items-center gap-0.5 text-[10px] font-medium rounded px-1.5 py-0.5 transition-colors
                    ${done
                      ? 'text-green-600 hover:bg-green-100'
                      : 'text-blue-500 hover:bg-blue-100'
                    } disabled:opacity-40`}
                >
                  <FiArrowRight size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Side state quick-set buttons */}
      {onStageClick && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {SIDE_STATES.map(s => {
            const isCurrent = stage === s.key;
            return (
              <button
                key={s.key}
                onClick={() => onStageClick(s.key)}
                disabled={busy || isCurrent}
                className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors
                  ${isCurrent
                    ? toneBanner[s.tone] + ' cursor-default'
                    : 'border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700'}
                  disabled:opacity-50`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
