import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRenewalJourney, readRenewalJourney } from './membershipRenewalJourney.js';
import { createRenewalJourneyHandler } from '../admin/membership-renewal-journey.js';
const id='090be663-5429-4e46-b6ee-d824d37d6d3b';
function fixture(setting=null, form={id,tenant_id:'tenant',slug:'renewing-with-bnms',is_active:true,require_authentication:true}) {
  const calls=[];
  return {calls,from(table) {
    const q={select(){return q;},eq(k,v){calls.push([table,k,v]);return q;},order(){return q;},
      range(){return Promise.resolve({data:form?[form]:[]});},
      maybeSingle(){return Promise.resolve({data:table==='form'?form:setting});}};
    return q;
  }};
}
test('unconfigured tenants retain the existing route and no eligible state is invented',async()=>{
  const db=fixture();const renewal={eligible:true,state:'post_grace_renewal'};
  assert.deepEqual(await applyRenewalJourney(db,'tenant',renewal),renewal);
  const blocked=fixture({mode:'questionnaire',form_id:id});
  assert.deepEqual(await applyRenewalJourney(blocked,'tenant',{eligible:false}),{eligible:false});
  assert.equal(blocked.calls.length,0);
});
test('questionnaire overrides the destination, not the period, and removes same-schedule prices',async()=>{
  const db=fixture({mode:'questionnaire',form_id:id,revision:1});
  const result=await applyRenewalJourney(db,'tenant',{eligible:true,state:'post_grace_renewal',paidThroughDate:'2026-01-01',price:{amount:71},priceState:'ready'});
  assert.equal(result.entryHref,'/FormView?slug=renewing-with-bnms');
  assert.equal(result.paidThroughDate,'2026-01-01');assert.equal(result.state,'post_grace_renewal');
  assert.equal(result.price,undefined);assert.equal(result.priceState,undefined);
  assert.ok(db.calls.some(c=>c[0]==='form'&&c[1]==='tenant_id'&&c[2]==='tenant'));
});
test('invalid, inaccessible or failed settings never use the previous schedule link',async()=>{
  for(const form of [null,{id,tenant_id:'other',slug:'x',is_active:true,require_authentication:true},
    {id,tenant_id:'tenant',slug:'x',is_active:false,require_authentication:true},
    {id,tenant_id:'tenant',slug:'x',is_active:true,require_authentication:false}]) {
    const result=await applyRenewalJourney(fixture({mode:'questionnaire',form_id:id},form),'tenant',{eligible:true});
    assert.equal(result.eligible,false);assert.equal(result.journeyUnavailable,true);assert.equal(result.entryHref,undefined);
  }
  const db={from(){throw new Error('database down');}};
  assert.equal((await applyRenewalJourney(db,'tenant',{eligible:true})).eligible,false);
  await assert.rejects(readRenewalJourney(db,'tenant'));
});
test('settings API enforces admin/tenant scope and revision conflicts',async()=>{
  const context={isAuthenticated:true,tenantId:'tenant',memberId:'admin'};
  const db=fixture();let saved;
  db.rpc=async(name,args)=>{saved=args;return {error:{code:'40001'}};};
  const res=()=>({setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
  for(const [ctx,admin,expected] of [[{},true,401],[context,false,403],[{...context,tenantMismatch:true},true,409]]) {
    const r=res();await createRenewalJourneyHandler({db,getContext:async()=>ctx,isAdmin:async()=>admin})({method:'GET'},r);
    assert.equal(r.code,expected);
  }
  const handler=createRenewalJourneyHandler({db,getContext:async()=>context,isAdmin:async()=>true});
  const r=res();await handler({method:'PUT',body:{mode:'questionnaire',formId:id,expectedRevision:1,tenantId:'forged'}},r);
  assert.equal(r.code,409);assert.equal(saved.p_tenant_id,'tenant');assert.equal(saved.p_actor,'member:admin');
});
