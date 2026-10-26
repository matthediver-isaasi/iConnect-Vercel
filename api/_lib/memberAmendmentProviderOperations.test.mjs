import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberAmendmentProviderOperations } from './memberAmendmentProviderOperations.js';
import { monthlyAmendmentFingerprint } from './memberAmendmentMonthly.js';

function fixture() {
  const input = { tenantId: 'tenant', memberId: 'member', amendmentId: 'operation-key',
    target: { amountMinor: 100 }, effectiveDate: '2027-02-01', authority: { version: 1 } };
  let row = null, failPersist = false;
  const calls = [];
  const monthly = {
    async prepare(value) {
      calls.push('prepare');
      const base = { version: 1, input: value, mutation: { kind: 'stripe_schedule' } };
      return { ...base, fingerprint: monthlyAmendmentFingerprint(base) };
    },
    async apply() { calls.push('apply'); return { status: 'provider_applied' }; },
    async reconcile() { calls.push('reconcile'); return { status: 'provider_applied' }; },
  };
  const db = {
    from() {
      const filters = {};
      return {
        select() { return this; }, eq(k,v) { filters[k]=v; return this; },
        async maybeSingle() { return { data: row && Object.entries(filters).every(([k,v])=>row[k]===v) ? structuredClone(row) : null }; },
      };
    },
    async rpc(name,args) {
      calls.push(name);
      if (name === 'reserve_member_amendment_provider_operation') {
        row ||= { id: 'operation', tenant_id: input.tenantId, member_id: input.memberId,
          operation_key: input.amendmentId, prepared: args.p_prepared,
          fingerprint: args.p_prepared.fingerprint, state: 'reserved' };
        return { data: { operation: structuredClone(row) } };
      }
      if (name === 'claim_member_amendment_provider_operation') {
        const claimed = row.state === 'reserved';
        if (claimed) { row.state = 'executing'; row.claim_token = 'durable-claim'; }
        return { data: { claimed, operation: structuredClone(row) } };
      }
      if (name === 'record_member_amendment_provider_result') {
        if (failPersist) return { error: { code: 'XX000' } };
        assert.equal(args.p_claim_token, 'durable-claim');
        row.state = args.p_result.status === 'provider_applied' ? 'provider_applied' : 'uncertain';
        row.evidence = args.p_result;
        return { data: structuredClone(row) };
      }
      throw Error(name);
    },
  };
  const service = createMemberAmendmentProviderOperations({ db, monthly });
  return { input, monthly, service, calls, row:()=>row, failPersistence:()=>{ failPersist=true; },
    recoverPersistence:()=>{ failPersist=false; } };
}
test('monthly provider operation is persisted and claimed before its only write', async () => {
  const f = fixture();
  const row = await f.service.execute({ input: f.input, actorId: 'actor' });
  assert.equal(row.state,'provider_applied');
  assert.ok(f.calls.indexOf('reserve_member_amendment_provider_operation') < f.calls.indexOf('apply'));
  assert.ok(f.calls.indexOf('claim_member_amendment_provider_operation') < f.calls.indexOf('apply'));
  await f.service.execute({ input: f.input, actorId: 'actor' });
  assert.equal(f.calls.filter(c=>c==='apply').length,1);
  assert.ok(f.calls.includes('reconcile'));
});
test('concurrent confirmations do not both write to the provider', async () => {
  const f=fixture();
  await Promise.all([1,2].map(()=>f.service.execute({ input:f.input,actorId:'actor' })));
  assert.equal(f.calls.filter(c=>c==='apply').length,1);
});
test('provider success followed by storage failure is recovered read-only', async () => {
  const f=fixture();f.failPersistence();
  await assert.rejects(f.service.execute({ input:f.input,actorId:'actor' }), /persisted/);
  assert.equal(f.row().state,'executing');
  f.recoverPersistence();
  const row=await f.service.resume({ tenantId:'tenant',memberId:'member',actorId:'actor',key:'operation-key' });
  assert.equal(row.state,'provider_applied');
  assert.equal(f.calls.filter(c=>c==='apply').length,1);
});
test('unknown write and later not-applied reads keep the operation held, never retry', async () => {
  const f=fixture();
  f.monthly.apply=async()=>{ f.calls.push('apply');throw Error('lost reply'); };
  assert.equal((await f.service.execute({input:f.input,actorId:'actor'})).state,'uncertain');
  f.monthly.reconcile=async()=>({status:'not_applied'});
  assert.equal((await f.service.execute({input:f.input,actorId:'actor'})).state,'uncertain');
  assert.equal(f.calls.filter(c=>c==='apply').length,1);
});
test('changed intent, corrupted durable evidence and foreign owners cannot resume provider work', async () => {
  const f=fixture();await f.service.execute({input:f.input,actorId:'actor'});
  await assert.rejects(f.service.execute({input:{...f.input,target:{amountMinor:200}},actorId:'actor'}),
    {code:'operation_key_conflict'});
  await assert.rejects(f.service.resume({tenantId:'foreign',memberId:'member',actorId:'actor',key:'operation-key'}),
    {code:'operation_ownership_mismatch'});
  f.row().prepared.input.target.amountMinor=900;
  await assert.rejects(f.service.resume({tenantId:'tenant',memberId:'member',actorId:'actor',key:'operation-key'}),
    {code:'operation_evidence_changed'});
});
test('dynamic revisions remain blocked before reservation; absent actor cannot read or write provider', async () => {
  const f=fixture();
  await assert.rejects(f.service.execute({input:f.input}), {code:'actor_required'});
  assert.equal(f.calls.length,0);
  f.monthly.prepare=async()=>({mutation:{kind:'dynamic_revision_required'}});
  await assert.rejects(f.service.execute({input:f.input,actorId:'actor'}),{code:'dynamic_revision_required'});
  assert.equal(f.row(),null);
});
