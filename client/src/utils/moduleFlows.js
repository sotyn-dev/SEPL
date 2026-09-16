import flows from '../../../shared/moduleFlows.json' with { type: 'json' };

export const MODULE_FLOWS = flows;

// Match a tab label to a flow step loosely: drop a leading emoji or symbol
// ("⚙ Responsible", "🚨 Payment"), collapse spaces, ignore case. The first cut
// used an exact indexOf, so a tab labelled with its gear icon never matched its
// own step and silently rendered with no number.
const normStep = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().toLowerCase();

// "Raise Indent" on /procurement -> "Raise Indent (4.1)". Mam (2026-09-10): sub-
// numbers follow a module's WORKFLOW TABS in order — never its form fields.
// A label that is not one of the flow's steps (a status filter, say) is returned
// unchanged, so it can never pick up a misleading number.
export function flowStepLabel(path, label) {
  const number = flowStepNumber(path, label);
  return number ? `${label} (${number})` : label;
}

// Just the "4.1" part, or null. For tabs whose visible label an admin can rename
// (Tool Rentals stages), look the number up by the default label instead.
export function flowStepNumber(path, label) {
  const [pathname, search = ''] = String(path || '').split('?');
  const flow = getModuleFlow(pathname, search);
  if (!flow) return null;
  const want = normStep(label);
  if (!want) return null;              // a blank tab never gets a number
  const index = flow.steps.findIndex(step => normStep(step) === want);
  return index >= 0 ? `${flow.number}.${index + 1}` : null;
}

// Text for a flow number already saved on a PMS task. Numbers saved before the
// 2026-09-10 renumbering can point at a step that no longer exists — show the
// module's name rather than nothing.
export function describeFlowNumber(value) {
  const step = getFlowStep(value);
  if (step) return step;
  const moduleNumber = Number(String(value || '').split('.')[0]);
  return MODULE_FLOWS.find(item => item.number === moduleNumber)?.title || '';
}

export function getFlowStep(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*\.[1-9]\d*$/.test(value.trim())) return null;
  const [moduleNumber, stepNumber] = value.trim().split('.').map(Number);
  const flow = MODULE_FLOWS.find(item => item.number === moduleNumber);
  const step = flow?.steps[stepNumber - 1];
  if (!step) return null;
  // A module with one number has one step, and that step is the module itself —
  // show "Dispatch Receiving", not "Dispatch Receiving — Dispatch Receiving".
  return normStep(step) === normStep(flow.title) ? flow.title : `${flow.title} — ${step}`;
}

export function getModuleFlow(pathname, search = '') {
  const exactQuery = MODULE_FLOWS.find(flow => flow.path.includes('?')
    && flow.path.split('?')[0] === pathname
    && [...new URLSearchParams(flow.path.split('?')[1])].every(([key, value]) => new URLSearchParams(search).get(key) === value));
  return exactQuery || MODULE_FLOWS.find(flow => flow.path === pathname)
    || MODULE_FLOWS.filter(flow => flow.path !== '/' && !flow.path.includes('?') && pathname.startsWith(`${flow.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
}

// Sidebar name. A module whose tabs carry their own numbers shows "(Flow 4)";
// a module with a single number shows it directly — "Dispatch Receiving (88.1)",
// the number a PMS task is raised against (mam 2026-09-10).
export function flowLabel(path, label) {
  const [pathname, search] = path.split('?');
  const flow = getModuleFlow(pathname, search);
  if (!flow) return label;
  return flow.steps.length > 1 ? `${label} (Flow ${flow.number})` : `${label} (${flow.number}.1)`;
}
