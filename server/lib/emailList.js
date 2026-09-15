// A field that holds one OR several email addresses, separated by commas
// (mam 2026-09-11, Customers: "can enter in both multiple emails with ,").
//
// cleanEmailList(" a@x.com; b@y.com ,a@x.com ") →
//   { list: ['a@x.com', 'b@y.com'], value: 'a@x.com, b@y.com', invalid: [] }
// Commas, semicolons and new lines all separate; blanks and repeats (any case)
// are dropped. `value` keeps every entry, valid or not, so an import never
// silently loses what was typed; forms refuse to save when `invalid` is non-empty.

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function cleanEmailList(input) {
  const seen = new Set();
  const list = [];
  for (const part of String(input == null ? '' : input).split(/[,;\n]+/)) {
    const email = part.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(email);
  }
  return { list, value: list.join(', '), invalid: list.filter((e) => !EMAIL.test(e)) };
}

module.exports = { cleanEmailList };
