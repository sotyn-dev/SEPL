import { useLocation } from 'react-router-dom';
import { getModuleFlow } from '../utils/moduleFlows';

export default function ModuleFlowGuide() {
  const { pathname, search } = useLocation();
  const flow = getModuleFlow(pathname, search);
  if (!flow) return null;
  return (
    <details key={flow.path} open className="mb-4 rounded-lg border border-blue-100 bg-white print:hidden">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-blue-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
        {flow.title} (Flow {flow.number})
        <span className="ml-2 text-xs font-normal text-slate-500">Flow guide · {flow.steps.length} steps</span>
      </summary>
      <ol aria-label={`${flow.title} flow steps`} className="grid gap-x-4 gap-y-2 border-t border-blue-50 px-3 py-3 sm:grid-cols-2 xl:grid-cols-3">
        {flow.steps.map((step, index) => (
          <li key={step} className="flex items-start gap-2 text-xs leading-5 text-slate-700">
            <span className="min-w-9 shrink-0 rounded bg-blue-50 px-1 text-center font-semibold tabular-nums text-blue-800">{flow.number}.{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
