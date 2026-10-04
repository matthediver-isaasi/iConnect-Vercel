import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipSuccessorElectionsEnabled } from './membershipSuccessorElection.js';

test('tenant gate never uses the legacy global RPC', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: args.p_tenant_id === 'bnms', error: null };
  } };
  assert.equal(await membershipSuccessorElectionsEnabled(db), false);
  assert.equal(calls.length, 0);
  assert.equal(await membershipSuccessorElectionsEnabled(db, 'bnms'), true);
  assert.equal(await membershipSuccessorElectionsEnabled(db, 'other'), false);
  assert.deepEqual(calls.map(c => c.args), [{ p_tenant_id: 'bnms' }, { p_tenant_id: 'other' }]);
});

test('missing scoped schema stays off; unexpected failures are not hidden', async () => {
  assert.equal(await membershipSuccessorElectionsEnabled({
    rpc: async () => ({ error: { code: 'PGRST202' } }),
  }, 'bnms'), false);
  await assert.rejects(membershipSuccessorElectionsEnabled({
    rpc: async () => ({ error: { code: 'XX000', message: 'unavailable' } }),
  }, 'bnms'), /unavailable/);
});