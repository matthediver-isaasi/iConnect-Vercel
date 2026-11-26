import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberAmendmentsHandler } from './member-amendments.js';
const memberId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
function fixture({ admin = true, finance = true, authenticated = true, mismatch = false } = {}) {
  const calls = [];
  const service = Object.fromEntries(['status', 'preview', 'confirm', 'resume'].map(method => [
    method, async (...args) => { calls.push({ method, args }); return { state: 'released' }; },
  ]));
  const handler = createMemberAmendmentsHandler({ db: {}, unpaidCancellationService: service,
    getContext: async () => ({ isAuthenticated: authenticated, tenantMismatch: mismatch,
      tenantId: 'owned-tenant', tenantUserId: 'real-actor', roleId: 'finance-role' }),
    isAdmin: async () => admin, hasFinance: async () => finance });
  return { calls, async call(action, body = {}, method = 'POST') {
    const res = { code: 200, setHeader() {}, status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method, query: { action, memberId, ...body }, body: { action, memberId, ...body } }, res);
    return res;
  } };
}
test('unpaid membership actions require authenticated tenant finance administration', async () => {
  for (const [settings, code] of [[{ admin: false }, 403], [{ finance: false }, 403],
    [{ authenticated: false }, 401], [{ mismatch: true }, 409]]) {
    const f = fixture(settings);
    assert.equal((await f.call('confirm_unpaid_cancellation')).code, code);
    assert.equal(f.calls.length, 0);
  }
});
test('all unpaid cancellation actions bind the server actor and enforce HTTP methods', async () => {
  for (const [action, method, http] of [
    ['unpaid_cancellation_status', 'status', 'GET'], ['preview_unpaid_cancellation', 'preview', 'POST'],
    ['confirm_unpaid_cancellation', 'confirm', 'POST'], ['recover_unpaid_cancellation', 'resume', 'POST'],
  ]) {
    const f = fixture();
    assert.equal((await f.call(action, { operationId, actorId: 'forged', tenantId: 'foreign' }, http)).code, 200);
    assert.equal(f.calls[0].method, method);
    assert.deepEqual(f.calls[0].args[0], { tenantId: 'owned-tenant', memberId, actorId: 'real-actor', actorKind: 'admin' });
    assert.equal((await f.call(action, {}, http === 'GET' ? 'POST' : 'GET')).code, 405);
  }
});
test('invalid member and recovery identifiers never reach the service', async () => {
  const f = fixture();
  assert.equal((await f.call('preview_unpaid_cancellation', { memberId: 'invalid' })).code, 400);
  assert.equal((await f.call('recover_unpaid_cancellation', { operationId: 'invalid' })).code, 400);
  assert.equal(f.calls.length, 0);
});
