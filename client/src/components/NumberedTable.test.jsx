import test from 'node:test';
import assert from 'node:assert/strict';
import { Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NumberedTable from './NumberedTable';

const head = <thead><tr><th>Record ID</th><th>Name</th></tr></thead>;
const row = (id, name = 'Example') => <tr key={id}><td>{id}</td><td>{name}</td></tr>;
const numbers = html => [...html.matchAll(/<td class="serial-number-cell">(.*?)<\/td>/g)].map(match => match[1]);
const render = (children, props = {}) => renderToStaticMarkup(<NumberedTable {...props}>{head}{children}</NumberedTable>);

test('separate display sequence preserves business identifiers and order', () => {
  const html = render(<tbody>{[row('CRM-0108'), row('CRM-0042')]}</tbody>);
  assert.deepEqual(numbers(html), ['1', '2']);
  assert.match(html, /S.No./);
  assert.match(html, /<td>CRM-0108<\/td>/);
  assert.match(html, /<td>CRM-0042<\/td>/);
});

test('page two continues at 16; filtered/All results restart at 1', () => {
  const rows = <tbody>{[row('a'), row('b')]}</tbody>;
  assert.deepEqual(numbers(render(rows, { start: 16 })), ['16', '17']);
  assert.deepEqual(numbers(render(rows, { start: 1 })), ['1', '2']);
});

test('fragments and expanded details do not consume a number', () => {
  const html = render(<tbody><Fragment>{row('a')}<tr><td colSpan="2">Details</td></tr></Fragment>{row('b')}</tbody>);
  assert.deepEqual(numbers(html), ['1', '2']);
  assert.match(html, /colSpan="3">Details/);
});

test('loading and empty messages span the actual new column count', () => {
  const html = render(<tbody><tr><td colSpan="99">No rows</td></tr></tbody>);
  assert.deepEqual(numbers(html), []);
  assert.match(html, /colSpan="3">No rows/);
});

test('expanded grouped children and total rows leave subsequent numbers stable', () => {
  const html = render(<tbody>{row('Group 1')}<tr data-serial-skip><td>Child</td><td>Value</td></tr>{row('Group 2')}<tr data-serial-skip><td>Total</td><td>500</td></tr></tbody>);
  assert.deepEqual(numbers(html), ['1', '', '2', '']);
});

test('group-specific numbers can be supplied explicitly', () => {
  const html = render(<tbody><tr data-serial-number="16.1"><td>Child</td><td>Value</td></tr></tbody>);
  assert.deepEqual(numbers(html), ['16.1']);
});

test('footer totals receive space, not a sequence number', () => {
  const html = render(<><tbody>{row('a')}</tbody><tfoot><tr><td>Total</td><td>20</td></tr></tfoot></>);
  assert.deepEqual(numbers(html), ['1', '']);
});

test('multi-row headers get one serial header spanning both rows', () => {
  const html = renderToStaticMarkup(<NumberedTable><thead><tr><th rowSpan={2}>Record</th><th colSpan={2}>Amounts</th></tr><tr><th>Plan</th><th>Actual</th></tr></thead><tbody><tr><td colSpan={3}>Empty</td></tr></tbody></NumberedTable>);
  assert.equal((html.match(/S.No./g) || []).length, 1);
  assert.match(html, /rowSpan="2" class="serial-number-cell"/);
  assert.match(html, /colSpan="4">Empty/);
});

test('existing S.No. and hash columns never get duplicated', () => {
  for (const label of ['S.No.', 'Sr No', '#']) {
    const html = renderToStaticMarkup(<NumberedTable><thead><tr><th>{label}</th><th>Name</th></tr></thead><tbody>{row('1')}</tbody></NumberedTable>);
    assert.deepEqual(numbers(html), []);
    assert.equal((html.match(/<th>/g) || []).length, 2);
  }
});

test('asset serial numbers do not suppress the display sequence', () => {
  const html = renderToStaticMarkup(<NumberedTable><thead><tr><th>Serial No.</th><th>Asset</th></tr></thead><tbody>{row('SN-929')}</tbody></NumberedTable>);
  assert.deepEqual(numbers(html), ['1']);
  assert.match(html, /SN-929/);
});

test('fixed column layouts receive a matching narrow col element', () => {
  const html = render(<><colgroup><col /><col /></colgroup><tbody>{row('a')}</tbody></>);
  assert.equal((html.match(/<col(?:\s|\/|>)/g) || []).length, 3);
  assert.match(html, /width:2.75rem/);
});

test('inputs and original row elements are not mutated on repeat render', () => {
  const original = <tr data-testid="original"><td>CRM-1</td><td><input defaultValue="123" /></td></tr>;
  const body = <tbody>{original}</tbody>;
  const first = render(body);
  assert.equal(render(body), first);
  assert.equal(original.props.children.length, 2);
  assert.match(first, /value="123"/);
  assert.deepEqual(numbers(first), ['1']);
});
