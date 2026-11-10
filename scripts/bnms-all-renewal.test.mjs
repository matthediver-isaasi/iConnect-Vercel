import test from 'node:test';
import assert from 'node:assert/strict';
import {offlineDatabase} from './lib/renewal-audit-snapshot.mjs';
import {classifyMember,historicalInvoiceLinkMatches} from './lib/bnms-renewal-classification.mjs';
const base=()=>({member:{id:'m',tenant_id:'t'},tenantId:'t',histories:[],agreements:[],plans:[],payments:[],
  invoices:[],today:'2026-11-10',memberClass:'Full',membershipStatus:'Active'});
test('import invoice references provider history, not membership history',()=>{
  const payment={id:'provider-history',member_id:'m',tenant_id:'t',provider_payment_id:'pay'};
  const link={...payment,history_id:'provider-history'};
  assert(historicalInvoiceLinkMatches(payment,link));
  assert(!historicalInvoiceLinkMatches(payment,{...link,history_id:'membership-history'}));
  assert(!historicalInvoiceLinkMatches(payment,{...link,member_id:'other'}));
});
test('repeat paging does not slice the underlying query cumulatively',async()=>{
  const db=offlineDatabase({x:Array.from({length:1100},(_,id)=>({id}))});
  const q=db.from('x').select('*'); let n=0;
  for(let i=0;i<1100;i+=500)n+=(await q.range(i,i+499)).data.length;
  assert.equal(n,1100);
});
test('forbids side effects and unavailable tables/capabilities',async()=>{
  const db=offlineDatabase({x:[]});
  assert.throws(()=>db.from('missing'));assert.throws(()=>db.from('x').insert({}));
  await assert.rejects(db.rpc('reserve_membership_successor'));
});
test('date OR and nested filters match application query semantics',async()=>{
  const db=offlineDatabase({x:[{end:null,a:{id:'x'}},{end:'2026-01-01',a:{id:'x'}}]});
  assert.equal((await db.from('x').eq('a->>id','x').or('end.is.null,end.gte.2026-11-10')).data.length,1);
});
test('all-member classification distinguishes no evidence from guest exemption',()=>{
  assert.equal(classifyMember(base()).classification,'unresolved');
  const b=base();b.memberClass='CPD Guest';assert.equal(classifyMember(b).classification,'expected');
});
test('tenant and member isolation fail closed',()=>{
  const b=base();b.histories=[{tenant_id:'other',member_id:'m'}];
  assert.throws(()=>classifyMember(b),/scope/);
  b.histories=[{tenant_id:'t',member_id:'other'}];assert.throws(()=>classifyMember(b),/scope/);
});
test('organisation card unavailable is display-only, not debt',()=>{
  const b=base();b.orgHistories=[{id:'org'}];b.selected={record:{id:'org',membership_source:'organisation'}};
  b.summary={payment:{state:'unavailable'}};assert.equal(classifyMember(b).classification,'display_only');
});
test('future deferred collection and explicit hold are expected',()=>{
  const b=base(); b.agreements=[{id:'a',tenant_id:'t',member_id:'m',status:'first_payment_pending',
    metadata:{card:{deferred_billing:{first_charge_date:'2027-01-01'}}}}];
  b.renewal={state:'renewal_pending'};assert(classifyMember(b).issues.some(i=>i.code==='future_deferred_card'&&i.category==='expected'));
});
test('single settled instalment never establishes fully paid membership',()=>{
  const b=base();b.histories=[{id:'h',tenant_id:'t',member_id:'m',billing_agreement_id:'a',status:'active',payment_status:'partial'}];
  b.agreements=[{id:'a',tenant_id:'t',member_id:'m',provider:'gocardless',environment:'live',metadata:{dd:{invoicing_mode:'per_instalment'}}}];
  b.plans=[{id:'p',tenant_id:'t',member_id:'m',billing_agreement_id:'a',provider:'gocardless',environment:'live'}];
  b.payments=[{id:'pay',plan_id:'p',environment:'live',status:'paid_out'}];
  const r=classifyMember(b);assert(r.issues.some(i=>i.code==='settled_instalment_invoice_missing'));
  assert.equal(b.histories[0].payment_status,'partial');
});
