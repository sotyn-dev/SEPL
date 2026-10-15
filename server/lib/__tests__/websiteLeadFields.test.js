const { test } = require('node:test');
const assert = require('node:assert/strict');
const { websiteCategory, explicitLocation, proposedWebsiteCorrections, CONSULTANCY_SERVICE } = require('../websiteLeadFields');

test('consultancy maps to MEP while other/unknown labels remain unchanged', () => {
  assert.equal(websiteCategory(CONSULTANCY_SERVICE), 'MEP');
  for (const label of ['SOLAR', 'Fire NOC', 'MEPF Project', 'Special review']) assert.equal(websiteCategory(label), label);
  assert.equal(websiteCategory(''), null);
});
test('locations come from explicit inputs, never a city or a guessed state', () => {
  assert.equal(explicitLocation({ state: ' Punjab ' }, 'project_state', 'state'), 'Punjab');
  assert.equal(explicitLocation({ city: 'Noida' }, 'project_state', 'state'), null);
  assert.equal(explicitLocation({ state: 'Delhi NCR' }, 'state'), 'Delhi NCR');
  assert.equal(explicitLocation({ state: { bad: 1 } }, 'state'), null);
});
test('historical corrections preserve populated fields and manual categories', () => {
  assert.deepEqual(proposedWebsiteCorrections({ state: '', district: null, category: CONSULTANCY_SERVICE }, { state: 'Punjab', district: 'Ludhiana' }), { state: 'Punjab', district: 'Ludhiana', category: 'MEP' });
  assert.deepEqual(proposedWebsiteCorrections({ state: 'Haryana', district: 'Ambala', category: 'Electrical' }, { state: 'Punjab', district: 'Ludhiana', service: CONSULTANCY_SERVICE }), {});
});
