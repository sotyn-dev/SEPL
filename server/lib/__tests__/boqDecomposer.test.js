const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../../db/schema');
const { decomposeBoqLine } = require('../boqDecomposer');

test('boqDecomposer module loads and exports decomposeBoqLine', () => {
  assert.equal(typeof decomposeBoqLine, 'function');
});

test('boqDecomposer rejects invalid/too-short input with 400', async () => {
  await assert.rejects(
    async () => {
      await decomposeBoqLine(getDb(), { description: 'ab' });
    },
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});
