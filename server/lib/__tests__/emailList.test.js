const assert = require('node:assert/strict');
const { cleanEmailList } = require('../emailList');

assert.deepEqual(cleanEmailList('gourav.lamba@luminousindia.com'),
  { list: ['gourav.lamba@luminousindia.com'], value: 'gourav.lamba@luminousindia.com', invalid: [] });

// Several, messy spacing, semicolon / new line separators, repeats in any case.
const many = cleanEmailList(' a@x.com ,b@y.co.in;  A@X.COM\nc.d@z.org , ');
assert.deepEqual(many.list, ['a@x.com', 'b@y.co.in', 'c.d@z.org']);
assert.equal(many.value, 'a@x.com, b@y.co.in, c.d@z.org');
assert.deepEqual(many.invalid, []);

// Invalid entries are reported but kept in value (imports never lose text).
const bad = cleanEmailList('ok@x.com, not-an-email, two words@x.com, @x.com, a@b');
assert.deepEqual(bad.invalid, ['not-an-email', 'two words@x.com', '@x.com', 'a@b']);
assert.equal(bad.value, 'ok@x.com, not-an-email, two words@x.com, @x.com, a@b');

// Empty / missing.
for (const v of ['', '  ', ' , ; ', null, undefined]) {
  assert.deepEqual(cleanEmailList(v), { list: [], value: '', invalid: [] });
}
console.log('Email list checks passed: single, multiple with , ; and new lines, repeats, invalid entries, empty');
