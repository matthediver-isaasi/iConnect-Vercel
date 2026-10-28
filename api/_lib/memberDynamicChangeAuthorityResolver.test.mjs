import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDynamicChangeAuthorityResolver } from './memberDynamicChangeAuthorityResolver.js';
import { createMemberChangeAuthorityService } from './memberChangeAuthority.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(authorizeMember=null){
  const source={id:id(3),tenant_id:id(1),member_id:id(2),config_id:id(4),
    commitment_snapshot:{payment_frequency:'monthly'},term_start_date:'2026-01-01',membership_renewal_date:'2027-01-01'};
  const governing={id:id(4),tenant_id:id(1),start_mode:'immediate'};
  const target={id:id(5),tenant_id:id(1),structure_scope_type:'member',start_mode:'immediate',
    pricing_model:'flat',currency:'GBP',dd_enabled:true,is_active:true};
  const context={tenantId:id(1),memberId:id(2),actorId:id(6),actorKind:'admin'};
  const selection={configId:id(5),effectiveDate:'2026-02-01',reason:'Upgrade membership'};
  const data={membership_tier_config:[governing,target]};
  const db={from(table){
    const filters={};return {select(){return this},eq(k,v){filters[k]=v;return this},
      async maybeSingle(){return {data:(data[table]||[]).find(r=>Object.entries(filters).every(([k,v])=>r[k]===v))||null}},
      async limit(){return {data:data[table]||[]}}};
  }};
  const input={purchase:source,amendmentId:'preview',authority:{provider:'gocardless',pricingBasis:'monthly_price',currency:'GBP'},
    agreement:{metadata:{dd:{commitment:{commitment_snapshot:{config:governing}}}}}};
  const providerFunding={settledGrossMinor:1200,pendingGrossMinor:0,payments:[{id:'PM1',amountMinor:1200,settled:true}]};
  const fundingEvidence={sourceRecordId:source.id,currency:'GBP',asOfDate:'2026-02-01',complete:true,
    settledFunding:[{id:'PM1',state:'settled',sourceRecordId:source.id,currency:'GBP',ownerType:'member',
      ownerId:context.memberId,kind:'cash',netMinor:1000,vatMinor:200}],
    pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0},
    variableMonthlyService:{sourceRecordId:source.id,currency:'GBP',throughExclusiveDate:'2026-02-01',complete:true,
      basis:'membership_start_anniversaries',periods:[{ordinal:1,evidenceId:'invoice',verified:true,
        sourceRecordId:source.id,currency:'GBP',serviceStartDate:'2026-01-01',serviceEndExclusiveDate:'2026-02-01',
        netMinor:1000,vatMinor:200}]}};
  const purchases={load:async()=>input,reconcileFunding:async()=>({input,prepared:{funding:providerFunding},fundingEvidence})};
  const price=async()=>({config_id:target.id,band_id:null,monthly_amount_minor:900});
  return {context,selection,source,target,governing,input,data,db,fundingEvidence,
    resolve:createMemberDynamicChangeAuthorityResolver({db,purchases,price,authorizeMember})};
}
test('monthly member quotations require a trusted form gate and exact session ownership',async()=>{
 const ordinary=fixture();
 const member={...ordinary.context,actorKind:'member',actorId:ordinary.context.memberId};
 await assert.rejects(ordinary.resolve(member,ordinary.selection),/finance-admin/);
 let checks=0;
 const allowed=fixture(async context=>{
  checks++;assert.equal(context.actorId,context.memberId);return {formId:id(8),revision:1};
 });
 const quote=await allowed.resolve(member,allowed.selection);
 assert.equal(checks,1);assert.equal(quote.monthlyExecution.providerTarget.amountMinor,900);
 await assert.rejects(allowed.resolve({...member,actorId:id(99)},allowed.selection),/finance-admin/);
 assert.equal(checks,1);
 const denied=fixture(async()=>false);
 await assert.rejects(denied.resolve(member,denied.selection),/finance-admin/);
});
test('production monthly quote preserves term and does not invent an annual total',async()=>{
  const f=fixture(),q=await f.resolve(f.context,{...f.selection,target:{amountMinor:1}});
  assert.equal(q.monthlyExecution.providerTarget.amountMinor,900);
  assert.equal(q.calculation.futureObligationMinor,null);
  assert.equal(q.calculation.finance.original,null);
  assert.equal(q.calculation.newTerm.renewalDate,'2027-01-01');
  assert.equal(q.calculation.finance.available.grossMinor,0);
  assert.equal(q.settlement.requiresApproval,true);
  assert.deepEqual(f.input.agreement.metadata.dd.commitment.commitment_snapshot.config,f.governing);
});
test('foreign target, surplus cash and replacement terms cannot obtain executable monthly authority',async()=>{
  for(const mutate of [
    f=>{f.target.tenant_id=id(99)},
    f=>{f.fundingEvidence.settledFunding[0].netMinor=1100},
    f=>{f.governing.membership_change_behaviour='new_term'},
  ]){
    const f=fixture();mutate(f);
    await assert.rejects(f.resolve(f.context,f.selection));
  }
});
test('shared confirmation rejects a changed monthly price before saving authority',async()=>{
  const f=fixture();let writes=0;
  f.db.rpc=async()=>{writes++;return {data:{}}};
  const service=createMemberChangeAuthorityService({db:f.db,resolve:f.resolve});
  const shown=await service.preview(f.context,f.selection);
  f.target.dd_monthly_amount=12;
  await assert.rejects(service.confirm(f.context,{selection:f.selection,fingerprint:shown.fingerprint,key:'monthly-confirm-test'}),/changed/);
  assert.equal(writes,0);
});
