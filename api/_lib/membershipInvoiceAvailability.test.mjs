import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMembershipInvoiceAvailability, membershipInvoiceAvailability as availability } from './membershipInvoiceAvailability.js';

test('distinguishes missing, queued, blocked, unknown and zero-cost invoice states', () => {
  const record = { id: 'record', final_cost: 3799.75 };
  assert.equal(availability(record).status, 'missing');
  for (const state of ['pending', 'running', 'retry']) assert.equal(availability(record, { state }).status, 'pending');
  for (const state of ['review', 'unknown', 'complete']) assert.equal(availability(record, { state }).status, 'blocked');
  assert.equal(availability(record, null, true).status, 'unavailable');
  assert.equal(availability({ final_cost: 0 }).status, 'not_required');
  assert.equal(availability({ final_cost: null }).status, 'missing');
  assert.equal(availability({ ...record, accounting_sync_status: 'failed' }).status, 'blocked');
});
test('existing invoice links are preserved even if queue lookup fails', () => {
  for (const key of ['accounting_invoice_id', 'xero_invoice_id']) {
    assert.equal(availability({ [key]: 'invoice' }, null, true).status, 'linked');
  }
});
test('queue lookup is tenant/source/operation scoped and never exposes its payload', async () => {
  const calls = [];
  const query = {
    select(value) { calls.push(['select', value]); return this; },
    eq(...args) { calls.push(args); return this; },
    in(...args) { calls.push(args); return this; },
    async order() { return { data: [{
      source_id: 'current', state: 'review', snapshot: { secret: 'must not escape' },
    }] }; },
  };
  const records = [{ id: 'current', final_cost: 3799.75 }, { id: 'old', final_cost: 3206 }];
  await attachMembershipInvoiceAvailability({ from(table) {
    assert.equal(table, 'accounting_request_queue'); return query;
  } }, 'tenant-a', records);
  assert.ok(calls.some(([key, value]) => key === 'tenant_id' && value === 'tenant-a'));
  assert.ok(calls.some(([key, value]) => key === 'source_type' && value === 'organisation_membership_history'));
  assert.ok(calls.some(([key, value]) => key === 'operation' && value === 'invoice'));
  assert.equal(records[0].invoice_availability.status, 'blocked');
  assert.equal(records[1].invoice_availability.status, 'missing');
  assert.equal(JSON.stringify(records).includes('secret'), false);
});
test('a failed lookup cannot falsely report that no invoice request exists', async () => {
  const records = [{ id: 'current' }];
  await attachMembershipInvoiceAvailability({ from() { throw new Error('offline'); } }, 'tenant-a', records);
  assert.equal(records[0].invoice_availability.status, 'unavailable');
});
test('no query is made for an empty or fully linked history', async () => {
  const db = { from() { assert.fail('unexpected query'); } };
  await attachMembershipInvoiceAvailability(db, 'tenant-a', []);
  await attachMembershipInvoiceAvailability(db, 'tenant-a', [{ accounting_invoice_id: 'linked' }]);
});
