import flows from '../../../shared/moduleFlows.json' with { type: 'json' };

export const MODULE_FLOWS = flows;

export function getFlowStep(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*\.[1-9]\d*$/.test(value.trim())) return null;
  const [moduleNumber, stepNumber] = value.trim().split('.').map(Number);
  const flow = MODULE_FLOWS.find(item => item.number === moduleNumber);
  return flow?.steps[stepNumber - 1] ? `${flow.title} — ${flow.steps[stepNumber - 1]}` : null;
}

export function getModuleFlow(pathname, search = '') {
  const exactQuery = MODULE_FLOWS.find(flow => flow.path.includes('?')
    && flow.path.split('?')[0] === pathname
    && [...new URLSearchParams(flow.path.split('?')[1])].every(([key, value]) => new URLSearchParams(search).get(key) === value));
  return exactQuery || MODULE_FLOWS.find(flow => flow.path === pathname)
    || MODULE_FLOWS.filter(flow => flow.path !== '/' && !flow.path.includes('?') && pathname.startsWith(`${flow.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
}

export function flowLabel(path, label) {
  const [pathname, search] = path.split('?');
  const flow = getModuleFlow(pathname, search);
  return flow ? `${flow.number} · ${label}` : label;
}
