import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMemberDateSchedule, resolveMemberDateTerm } from './memberDateTermPolicy.js';
import { simulateMemberDateTerm } from './memberDateTermSimulation.js';
import { snapshotFormMembershipPayment, historyFromFormPaymentSnapshot } from './formMembershipPaymentQuote.js';
import { deriveAnnualTerm } from './annualRenewalPolicy.js';
import { buildStartQuote } from './memberStartQuote.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = { id:id(4),tenant_id:id(1),is_active:true,structure_scope_type:'member',pricing_model:'flat',
  flat_cost:0,term_end_mode:'member_date_field',term_end_field_id:id(3),start_mode:'immediate',
  billing_period:'annual',currency:'GBP',effective_from:'2026-01-01',name:'Student',renewal_grace_days:30 };
function dbFixture(overrides = {}) {
  const tables = { preference_field:[{id:id(3),tenant_id:id(1),field_type:'date',entity_scope:'member',is_active:true}],
    member_preference_value:[{member_id:id(2),field_id:id(3),value:'2028-06-30'}],
    member:[{id:id(2),tenant_id:id(1),membership_paused:false}],member_membership_history:[],
    membership_billing_agreements:[],...overrides };
  return { from(table) {
    let rows=tables[table]||[];
    const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},
      in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q},
      maybeSingle:async()=>({data:rows[0]||null,error:null}),
      then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject)}};
    return q;
  }};
}
const args = {tenantId:id(1),member:{id:id(2)},config,today:'2026-11-08',
  options:{source:'form-payment',memberDateAuthorized:true}};
test('server policy rejects paid, recurring and non-member schedules',()=>{
  assert.doesNotThrow(()=>assertMemberDateSchedule(config));
  for(const patch of [{flat_cost:null},{flat_cost:1},{structure_scope_type:'organization'},{dd_enabled:true},{term_end_field_id:'bad'}]) {
    assert.throws(()=>assertMemberDateSchedule({...config,...patch}));
  }
});
test('saved member dates flow through quote, history and expiry without an annual conversion',async()=>{
  const sim=await simulateMemberDateTerm(dbFixture(),args);
  assert.equal(sim.success,true);
  const snapshot=snapshotFormMembershipPayment(sim,[],'none');
  const history=historyFromFormPaymentSnapshot(snapshot);
  assert.equal(history.term_end_date,'2028-06-30');
  assert.equal(history.term_key,undefined);
  assert.equal(history.total_with_vat,0);
  const term=deriveAnnualTerm(history,config);
  assert.equal(term.end.toISOString().slice(0,10),'2028-06-30');
});
test('explicit mapped answers take precedence but invalid or cross-tenant field data fails closed',async()=>{
  const common={tenantId:id(1),memberId:id(2),config,startDate:'2026-11-08'};
  assert.equal((await resolveMemberDateTerm(dbFixture(),{...common,fieldOverrides:{[id(3)]:'2029-05-31'}})).term_end_date,'2029-05-31');
  await assert.rejects(resolveMemberDateTerm(dbFixture(),{...common,fieldOverrides:{[id(3)]:''}}));
  await assert.rejects(resolveMemberDateTerm(dbFixture({preference_field:[]}),common));
});
test('automation, unapproved selection, paused accounts and open collection plans cannot create a term',async()=>{
  for(const options of [{source:'workflow'},{source:'form-payment'}]) assert.equal((await simulateMemberDateTerm(dbFixture(),{...args,options})).success,false);
  assert.equal((await simulateMemberDateTerm(dbFixture({member:[{id:id(2),tenant_id:id(1),membership_paused:true}]}),args)).success,false);
  assert.equal((await simulateMemberDateTerm(dbFixture({membership_billing_agreements:[{tenant_id:id(1),member_id:id(2),status:'active'}]}),args)).success,false);
});
test('existing terms retain their original start and require manual extension for changed dates',async()=>{
  const initial=await simulateMemberDateTerm(dbFixture(),args);
  const history={...initial.paymentSchedule,id:id(8),tenant_id:id(1),member_id:id(2),config_id:config.id,payment_status:'paid',status:'active',membership_year:initial.membershipYear.label};
  const db=dbFixture({member_membership_history:[history]});
  const retry=await simulateMemberDateTerm(db,{...args,today:'2026-11-09'});
  assert.equal(retry.success,true);
  assert.equal(retry.membershipYear.start,'2026-11-08');
  const changed=await simulateMemberDateTerm(db,{...args,options:{...args.options,fieldOverrides:{[id(3)]:'2029-06-30'}}});
  assert.equal(changed.success,false);
  assert.match(changed.error,/manual extension/);
});
test('admin No charge quote uses the actual date; other methods cannot use date terms',async()=>{
  const term=await resolveMemberDateTerm(dbFixture(),{tenantId:id(1),memberId:id(2),config,startDate:'2026-11-08'});
  const request={memberId:id(2),configId:id(4),startDate:'2026-11-08',paymentMode:'free',reason:'No-charge course membership'};
  const quote=buildStartQuote({request,config,today:'2026-11-08',memberDateTerm:term});
  assert.equal(quote.termEnd,'2028-06-30');
  assert.equal(quote.totalWithVat,0);
  assert.equal(quote.commitment.term_source_snapshot.field_id,id(3));
  assert.throws(()=>buildStartQuote({request:{...request,paymentMode:'invoice'},config,today:'2026-11-08',memberDateTerm:term}));
});
