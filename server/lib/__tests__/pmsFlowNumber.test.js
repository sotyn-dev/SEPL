const assert = require('node:assert/strict');
const { validatePmsFlowNumber } = require('../pmsFlowNumber');
const flows = require('../../../shared/moduleFlows.json');
for (const value of [null, undefined, '', ' ', 1.1, '1', '1.0', '0.1', '01.1', '1.01', '1.999', '999.1', 'abc', '1.1.1']) {
  assert.equal(validatePmsFlowNumber(value), null, String(value));
}
assert.equal(validatePmsFlowNumber(' 1.1 '), '1.1');
for (const flow of flows) {
  flow.steps.forEach((_, index) => {
    const value = `${flow.number}.${index + 1}`;
    assert.equal(validatePmsFlowNumber(value), value);
  });
  assert.equal(validatePmsFlowNumber(`${flow.number}.${flow.steps.length + 1}`), null);
}
console.log('PMS flow validation checks passed');
