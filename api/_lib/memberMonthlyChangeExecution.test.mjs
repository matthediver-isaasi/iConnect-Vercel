import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberMonthlyChangeExecution } from './memberMonthlyChangeExecution.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const context = { tenantId: id(1), memberId: id(2), actorId: id(3), actorKind: 'admin' };
  const purchase = { id: id(5), commitment_snapshot: { payment_frequency: 'monthly' } };
  const target = { id: id(6), tenant_id: id(1) };
  const providerAuthority = { original: 'immutable' };
  const saved = { id: id(4), tenant_id: id(1), member_id: id(2), actor_kind: 'admin', source_record_id: id(5),
    authority: { action: 'change', sourceSnapshot: purchase, targetSnapshot: target,
      calculation: { behaviour: 'retain_term', effectiveDate: '2027-01-01' },
      monthlyExecution: { version: 1, providerTarget: { amountMinor: 1500 }, providerAuthority } } };
  const tables = { member_change_authority: [saved], membership_tier_config: [target],
    member_amendment_provider_operation: [], member_monthly_finalization_approval: [] };
  const calls = [];
  const db = { from(table) {
    const filters = {};
    return { select() { return this; }, eq(k,v) { filters[k]=v;return this; },
      async maybeSingle() { return { data: tables[table]?.find(r => Object.entries(filters).every(([k,v])=>r[k]===v)) || null }; } };
  } };
  const purchases = { async load(args) { calls.push(['load',args]);return { ...args, purchase, authority: providerAuthority }; } };
  const operations = {
    async execute(args) {
      calls.push(['execute',args]);
      tables.member_amendment_provider_operation.push({
        id: id(7), tenant_id: context.tenantId, member_id: context.memberId,
        source_record_id: purchase.id, operation_key: args.input.amendmentId,
        state: 'provider_applied', prepared: { input: args.input },
      });
    },
    async resume(args) { calls.push(['resume',args]);return { state:'uncertain' }; },
    async finalize(args) { calls.push(['finalize',args]);return { operationId:id(7) }; },
  };
  return { context, saved, tables, calls, purchases, operations,
    request: { authorityId:id(4), approve:true, reason:'Approved' },
    service:createMemberMonthlyChangeExecution({db,purchases,operations}) };
}
test('execution uses confirmed pricing, never posted payment amounts; replay never starts a second provider write', async () => {
  const f=fixture();
  await f.service.execute(f.context,{...f.request,target:{amountMinor:1}});
  assert.equal(f.calls.find(c=>c[0]==='load')[1].target.amountMinor,1500);
  assert.equal(f.calls.find(c=>c[0]==='execute')[1].input.changeAuthorityId,id(4));
  await f.service.execute(f.context,f.request);
  assert.equal(f.calls.filter(c=>c[0]==='execute').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='load').length,1);
});
test('missing production envelope, foreign tenant, and changed purchase are refused before provider work', async () => {
  let f=fixture();delete f.saved.authority.monthlyExecution;
  await assert.rejects(f.service.execute(f.context,f.request),/confirmed executable/);
  assert.equal(f.calls.length,0);
  f=fixture();
  await assert.rejects(f.service.execute({...f.context,tenantId:id(99)},f.request),/confirmed executable/);
  assert.equal(f.calls.length,0);
  f=fixture();
  f.purchases.load=async()=>({purchase:{id:'changed'},authority:{original:'immutable'}});
  await assert.rejects(f.service.execute(f.context,f.request),/evidence changed/);
  assert.equal(f.calls.length,0);
});
test('recovery does not execute without an operation or invent finalization approval', async () => {
  const f=fixture();
  assert.equal((await f.service.resume(f.context,f.request)).state,'not_started');
  await f.service.execute(f.context,f.request);
  f.calls.length=0;
  assert.equal((await f.service.resume(f.context,f.request)).nextAction,'approve_finalization');
  assert.deepEqual(f.calls.map(c=>c[0]),['resume']);
  f.tables.member_monthly_finalization_approval.push({
    operation_id:id(7),tenant_id:id(1),actor_id:id(8),reason:'Original approval',
  });
  f.calls.length=0;
  await f.service.resume(f.context,f.request);
  assert.equal(f.calls[0][0],'finalize');
  assert.equal(f.calls[0][1].actorId,id(8));
  assert.equal(f.calls[0][1].reason,'Original approval');
});
