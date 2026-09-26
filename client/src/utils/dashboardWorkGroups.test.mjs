import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workGroup } from './dashboardWorkGroups.mjs';
test('today, previous, upcoming and undated follow the real deadline', () => {
  const today='2026-09-26';
  assert.equal(workGroup({status:'open',deadline_date:today},today),'today');
  assert.equal(workGroup({status:'rejected',target_date:'2026-09-25'},today),'previous');
  assert.equal(workGroup({status:'open',target_date:'2026-09-27'},today),'upcoming');
  assert.equal(workGroup({status:'open',created_at:'2020-01-01'},today),'undated');
});
test('submitted and completed records are not counted as pending work', () => {
  assert.equal(workGroup({status:'submitted',target_date:'2020-01-01'}),'approval');
  for (const status of ['approved','closed','resolved']) assert.equal(workGroup({status,deadline_date:'2020-01-01'}),'closed');
});
