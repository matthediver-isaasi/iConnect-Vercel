import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemberAmendmentProviderRecovery } from './memberAmendmentProviderRecovery.js';

function fixture() {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const calls = [];
  const rows = ['one', 'two'].map(key => ({
    tenant_id: 'tenant', member_id: 'member', actor_id: 'actor',
    operation_key: key, state: 'uncertain', claim_token: 'claim',
  }));
  const response = { data: rows };
  const query = Object.fromEntries(['select', 'in', 'not', 'lt', 'order', 'limit']
    .map(method => [method, (...args) => { calls.push([method, ...args]); return query; }]));
  query.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  const db = { from: name => { calls.push(['from', name]); return query; } };
  const service = {
    resume: async args => { calls.push(['resume', args]); return { state: 'provider_applied' }; },
    execute: () => { throw new Error('Recovery must never execute'); },
  };
  return { db, service, rows, response, calls, now: () => clock, advance: ms => { clock += ms; } };
}
test('queue selects only stale claimed writes and recovery is read-only at the provider', async () => {
  const f = fixture();
  const result = await runMemberAmendmentProviderRecovery(f);
  assert.equal(result.outcomes.length, 2);
  assert.ok(result.outcomes.every(row => row.requiresFinalization));
  assert.deepEqual(f.calls.find(c => c[0] === 'in'), ['in', 'state', ['executing', 'uncertain']]);
  assert.deepEqual(f.calls.find(c => c[0] === 'not'), ['not', 'claim_token', 'is', null]);
  assert.deepEqual(f.calls.find(c => c[0] === 'lt'), ['lt', 'updated_at', '2026-10-26T11:58:00.000Z']);
  assert.deepEqual(f.calls.find(c => c[0] === 'resume')[1],
    { tenantId: 'tenant', memberId: 'member', actorId: 'actor', key: 'one' });
});
test('absent migration is explicit; permission and malformed-response failures are not empty success', async () => {
  const f = fixture();
  f.response.error = { code: 'PGRST205' };
  assert.equal((await runMemberAmendmentProviderRecovery(f)).reason, 'migration_required');
  f.response.error = { code: '42501' };
  await assert.rejects(runMemberAmendmentProviderRecovery(f), { code: 'monthly_recovery_queue_failed' });
  delete f.response.error;
  f.response.data = null;
  await assert.rejects(runMemberAmendmentProviderRecovery(f), /invalid/);
});
test('one failed operation does not prevent later recovery or leak provider messages', async () => {
  const f = fixture();
  f.service.resume = async args => {
    if (args.key === 'one') throw new Error('provider secret');
    return { state: 'uncertain' };
  };
  const result = await runMemberAmendmentProviderRecovery(f);
  assert.deepEqual(result.outcomes, [
    { key: 'one', code: 'monthly_recovery_failed' },
    { key: 'two', state: 'uncertain', requiresFinalization: false },
  ]);
});
test('unclaimed or misbound rows cannot reach provider reconciliation', async () => {
  const f = fixture();
  f.rows[0].claim_token = null;
  f.rows[1].actor_id = null;
  const result = await runMemberAmendmentProviderRecovery(f);
  assert.ok(result.outcomes.every(o => o.code === 'monthly_recovery_binding_invalid'));
  assert.equal(f.calls.filter(c => c[0] === 'resume').length, 0);
});
test('invocation budget stops before starting another provider read', async () => {
  const f = fixture();
  f.service.resume = async () => { f.advance(8000); return { state: 'uncertain' }; };
  const result = await runMemberAmendmentProviderRecovery(f);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.timedOut, true);
  const zero = fixture();
  assert.equal((await runMemberAmendmentProviderRecovery({ ...zero, budgetMs: 0 })).timedOut, true);
  assert.equal(zero.calls.length, 0);
});
