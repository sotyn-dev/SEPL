import { FiCheck } from 'react-icons/fi';
import { STAGES, STAGE_BY_KEY, stageOrder, isSideState } from '../data/l2dStages';

// Vertical stepper for the linear 13-step pipeline. `stage` is the lead's
// current stage key. Side states (REJECTED / NEEDS_REVIEW / CALL_REQUESTED)
// render as a banner above the steps since they sit off the linear track.
export default function FunnelStepper({ stage }) {
  const side = isSideState(stage);
  const currentOrder = side ? 0 : stageOrder(stage);

  const toneBanner = {
    red: 'bg-red-50 text-red-800 border-red-200',
    yellow: 'bg-yellow-50 text-yellow-800 border-yellow-200',
    blue: 'bg-blue-50 text-blue-800 border-blue-200',
  };

  return (
    <div className="space-y-2">
      {side && (
        <div className={`text-xs px-3 py-2 rounded border ${toneBanner[STAGE_BY_KEY[stage]?.tone] || toneBanner.yellow}`}>
          {STAGE_BY_KEY[stage]?.label || stage}
        </div>
      )}
      <ol className="space-y-0">
        {STAGES.map((s, i) => {
          const done = currentOrder > s.order;
          const current = currentOrder === s.order;
          return (
            <li key={s.key} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <span className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold shrink-0
                  ${done ? 'bg-green-600 text-white' : current ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  {done ? <FiCheck size={13} /> : s.order}
                </span>
                {i < STAGES.length - 1 && (
                  <span className={`w-0.5 h-5 ${done ? 'bg-green-500' : 'bg-gray-200'}`} />
                )}
              </div>
              <span className={`text-xs pt-0.5 ${current ? 'font-semibold text-blue-700' : done ? 'text-gray-700' : 'text-gray-400'}`}>
                {s.label}
                {s.whatsapp && <span className="ml-1 text-[9px] text-green-600">WA</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
