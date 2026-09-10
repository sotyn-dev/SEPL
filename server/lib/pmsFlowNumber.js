const flows = require('../../shared/moduleFlows.json');

function validatePmsFlowNumber(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*\.[1-9]\d*$/.test(value.trim())) return null;
  const number = value.trim();
  const [moduleNumber, stepNumber] = number.split('.').map(Number);
  const flow = flows.find(item => item.number === moduleNumber);
  return flow?.steps[stepNumber - 1] ? number : null;
}

module.exports = { validatePmsFlowNumber };
