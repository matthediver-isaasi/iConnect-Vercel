import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fencedGocardlessRequest } from './gocardlessMutationFence.js';

function fixture() {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name, args]); return { data: name.startsWith('begin') ? 'intent' : null }; } };
  const request = async (method, path) => { calls.push(['http', method, path]); return { payments: { links: { mandate: 'old' } } }; };
  return { calls, db, request, environment: 'sandbox', method: 'POST', path: '/payments',
    opts: { body: { payments: { links: { mandate: 'old' } } }, idempotencyKey: 'stable' } };
}
test('financial mutation persists an intent before HTTP and confirms after HTTP', async () => {
  const f = fixture(); await fencedGocardlessRequest(f);
  assert.deepEqual(f.calls.map(c => c[0]), ['begin_gocardless_mutation', 'http', 'finish_gocardless_mutation']);
  assert.equal(f.calls[2][1].p_confirmed, true);
});
test('busy handover rejects ordinary collections before HTTP', async () => {
  const f = fixture(); f.db.rpc = async () => ({ error: { code: '40001' } });
  await assert.rejects(fencedGocardlessRequest(f), /authority/);
  assert.equal(f.calls.length, 0);
});
test('unknown HTTP outcome is durable, not a successful release', async () => {
  const f = fixture(); f.request = async () => { throw new Error('timeout'); };
  await assert.rejects(fencedGocardlessRequest(f), /timeout/);
  assert.equal(f.calls[1][1].p_confirmed, false);
});
test('payment retries resolve mandate before acquiring its fence', async () => {
  const f = fixture(); f.path = '/payments/old-payment/actions/retry'; f.opts = { idempotencyKey: 'retry' };
  await fencedGocardlessRequest(f);
  assert.deepEqual(f.calls.slice(0, 2).map(c => c[0]), ['http', 'begin_gocardless_mutation']);
  assert.equal(f.calls[1][1].p_mandate_id, 'old');
});
test('missing schema never permits a handover mutation', async () => {
  const f = fixture(); f.operationId = 'op'; f.db.rpc = async () => ({ error: { code: 'PGRST202' } });
  await assert.rejects(fencedGocardlessRequest(f), /authority/);
  assert.equal(f.calls.length, 0);
});
test('idempotent re-entry pins the original request parameters', async () => {
  const f = fixture(); await fencedGocardlessRequest(f); await fencedGocardlessRequest(f);
  const claims = f.calls.filter(c => c[0] === 'begin_gocardless_mutation');
  assert.equal(claims[0][1].p_request_key, claims[1][1].p_request_key);
});
