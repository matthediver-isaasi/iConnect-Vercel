import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemberMonthlyFinalizationRecovery, runMemberMonthlyRecovery } from './memberMonthlyFinalizationRecovery.js';

test('recovery uses saved approval and isolates unfinished applications without starting money', async () => {
  const seen = [];
  const rows = ['one', 'two'].map(key => ({
    tenant_id: 'tenant', member_id: 'member', actor_id: 'approver', operation_key: key, reason: 'Approved change',
  }));
  const result = await runMemberMonthlyFinalizationRecovery({
    db: { rpc: async name => { assert.equal(name, 'pending_member_monthly_finalizations'); return { data: rows }; } },
    service: {
      execute() { assert.fail('Recovery must never execute'); },
      async finalize(args) {
        seen.push(args);
        if (args.key === 'one') throw Object.assign(new Error(), { code: 'provider_outcome_unresolved' });
        return { operationId: 'operation' };
      },
    },
  });
  assert.deepEqual(result.outcomes, [
    { key: 'one', code: 'provider_outcome_unresolved' },
    { key: 'two', state: 'finalized', operationId: 'operation' },
  ]);
  assert.equal(seen[0].actorId, 'approver');
  assert.equal(seen[0].reason, 'Approved change');
});
test('absent finalization migration is disabled, not failed or silently successful', async () => {
  const result = await runMemberMonthlyFinalizationRecovery({
    db: { rpc: async () => ({ error: { code: 'PGRST202' } }) },
  });
  assert.deepEqual(result, { enabled: false, reason: 'migration_required', outcomes: [] });
});
test('budget and invalid saved approval cannot reach financial execution', async () => {
  let called = false;
  const db = { rpc: async () => ({ data: [{ operation_key: 'invalid' }] }) };
  const service = { finalize: async () => { called = true; } };
  assert.equal((await runMemberMonthlyFinalizationRecovery({ db, service })).outcomes[0].code, 'monthly_approval_invalid');
  assert.equal(called, false);
  assert.equal((await runMemberMonthlyFinalizationRecovery({ db, service, budgetMs: 0 })).timedOut, true);
});
test('each recovery queue reports failure independently without hiding completed work', async () => {
  const complete = { enabled: true, outcomes: [{ state: 'finalized' }] };
  const failed = async () => { throw Object.assign(Error('private'), { code: 'queue_unavailable' }); };
  let result = await runMemberMonthlyRecovery({
    db: {}, runFinalization: async () => complete, runProvider: failed,
  });
  assert.deepEqual(result.finalization, complete);
  assert.equal(result.provider.error, 'queue_unavailable');
  result = await runMemberMonthlyRecovery({
    db: {}, runFinalization: failed, runProvider: async () => complete,
  });
  assert.deepEqual(result.provider, complete);
  assert.equal(result.finalization.error, 'queue_unavailable');
  assert.ok(!JSON.stringify(result).includes('private'));
});
