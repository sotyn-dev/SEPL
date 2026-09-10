import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_FLOWS, getModuleFlow, flowLabel, flowStepLabel } from './moduleFlows.js';

assert.equal(new Set(MODULE_FLOWS.map(f => f.path)).size, MODULE_FLOWS.length);
assert.equal(new Set(MODULE_FLOWS.map(f => f.number)).size, MODULE_FLOWS.length);
assert.equal(getModuleFlow('/orders').number, 1);
assert.equal(getModuleFlow('/dpr').number, 2);
assert.equal(getModuleFlow('/installation').number, 3);
assert.equal(getModuleFlow('/drawing-tracker', '?other=1&tab=reports').title, 'Drawing Reports');
assert.equal(getModuleFlow('/system-requirements/123').path, '/system-requirements');
assert.equal(getModuleFlow('/orders-other'), undefined);
assert.equal(flowLabel('/orders', 'Order to Planning'), 'Order to Planning (Flow 1)');
assert.equal(flowLabel('/dispatch-receiving', 'Dispatch Receiving'), 'Dispatch Receiving (88.1)');
assert.equal(flowStepLabel('/procurement', 'Raise Indent'), 'Raise Indent (4.1)');
assert.equal(flowStepLabel('/procurement', '⚙ Responsible'), '⚙ Responsible (4.9)');
assert.equal(flowStepLabel('/procurement', 'Select project'), 'Select project');
const layout = readFileSync(new URL('../components/Layout.jsx', import.meta.url), 'utf8');
const nav = layout.slice(layout.indexOf('const SIDEBAR_DASHBOARD'), layout.indexOf('export default function Layout'));
for (const [, path] of nav.matchAll(/path:\s*'([^']+)'/g)) {
  const [pathname, search] = path.split('?');
  assert.ok(getModuleFlow(pathname, search), `Missing menu flow: ${path}`);
}
for (const flow of MODULE_FLOWS) {
  // Steps are a module's workflow tabs, or just the module itself — never form fields.
  assert.ok(flow.steps.length >= 1 && flow.steps.every(step => step.trim()), flow.path);
}
console.log(`Flow checks passed: ${MODULE_FLOWS.length} modules; all sidebar destinations covered.`);
