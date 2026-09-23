import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticSupplementalGuard } from './bnms-dd-alpha-supplement.mjs';
import { TENANT_ID } from './bnms-dd-pilot.mjs';
import { XERO_TENANT_ID,hash } from './bnms-dd-beta-invoices.mjs';

const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope=()=>({complete:true,memberIds:[],mandateIds:[],customerIds:[],paymentIds:[],invoiceIds:[]});
function fixture(){
  const grid=Array.from({length:21},(_,i)=>[uuid(i+1),`person${i+1}@example.test`,`MDTEST${i+1}`]);
  const exceptions=grid.map(([memberId,,mandateId])=>({identity:{memberId},mandateId,
    reasons:['INVOICE_RECONCILIATION: Invoice financial/period evidence conflict']}));
  const originalMembers=Array.from({length:249},(_,memberIndex)=>{
    const count=memberIndex<145?9:8;
    const memberId=uuid(1000+memberIndex);
    const history=Array.from({length:count},(_,offset)=>{
      const n=memberIndex*10+offset;
      return {id:uuid(10000+n),tenant_id:TENANT_ID,member_id:memberId,provider_payment_id:`PMOLD${n}`};
    });
    return {identity:{memberId,mandateId:`MDOLD${memberIndex}`,customerId:`CUOLD${memberIndex}`},history,
      links:history.map((row,offset)=>({history_id:row.id,tenant_id:TENANT_ID,member_id:memberId,
        provider_payment_id:row.provider_payment_id,xero_invoice_id:uuid(40000+memberIndex*10+offset),
        xero_payment_id:uuid(50000+memberIndex*10+offset)}))};
  });
  const originalManifest={members:originalMembers,exceptions};
  assert.equal(originalMembers.flatMap(member=>member.links).length,2137);
  const members=[],mandates=[],customers=[],payments=[],subscriptions=[],invoices=[],contacts=[];
  grid.forEach(([memberId,email,mandateId],index)=>{
    const customerId=`CUNEW${index}`,paymentId=`PMNEW${index}`,contactId=uuid(60000+index);
    members.push({id:memberId,tenant_id:TENANT_ID,email,status:'active',membership_paused:false,
      classification:'Trainee',pricing:{complete:true,mode:'dynamic',effectiveOn:'2026-10-01'}});
    mandates.push({id:mandateId,status:'active',links:{customer:customerId,creditor:'CR0000B50W1Y2R'}});
    customers.push({id:customerId,email});
    payments.push({id:paymentId,status:'paid_out',amount:1300,amount_refunded:0,currency:'GBP',
      charge_date:'2026-09-01',links:{mandate:mandateId,creditor:'CR0000B50W1Y2R'},
      metadata:{'Invoice number':`INV-${index}`}});
    contacts.push({ContactID:contactId,ContactStatus:'ACTIVE',EmailAddress:email});
    invoices.push({InvoiceID:uuid(70000+index),InvoiceNumber:`INV-${index}`,Type:'ACCREC',Status:'PAID',
      CurrencyCode:'GBP',Total:13,AmountPaid:13,AmountDue:0,AmountCredited:0,
      DateString:'2026-09-01T00:00:00',Contact:{ContactID:contactId},
      Payments:[{PaymentID:uuid(80000+index),Reference:paymentId,Amount:13}],
      CreditNotes:[],Prepayments:[],Overpayments:[],LineItems:[{AccountCode:index%2?'201':'200'}]});
  });
  const input={now:'2026-09-22T12:10:00Z',grid,originalManifest,scopes:{pilot:scope(),beta:scope()},
    evidence:{tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,observedAt:'2026-09-22T12:00:00Z',
      completeAccountDiscovery:true,rateLimited:false,members,
      provider:{complete:true,observedAt:'2026-09-22T12:01:00Z',mandates,customers,payments,subscriptions},
      accounting:{complete:true,observedAt:'2026-09-22T12:02:00Z',invoices,contacts}}};
  const guard=createSyntheticSupplementalGuard({gridSha256:hash(grid),originalManifestSha256:hash(originalManifest)});
  return {input,guard};
}

test('synthetic private-grid contract reconstructs full financial reconciliation only',()=>{
  const {input,guard}=fixture(),manifest=guard.build(input);
  assert.deepEqual(manifest.counts,{workbook:21,financiallyReconciled:21,blocked:0});
  assert.equal(manifest.members.every(row=>row.financiallyReconciled&&!row.adoptionReady),true);
  assert.deepEqual(manifest.term,{start:'2026-10-01',end:'2027-09-30',collectionDay:1,
    pricing:'dynamic',endPolicy:'continue',activation:'first_payment',priorEntitlementUnchanged:true});
  assert.equal(manifest.sourceSha256,hash({grid:input.grid,originalManifest:input.originalManifest,
    scopes:input.scopes,evidence:input.evidence}));
});

test('requires actual original hash, complete 2137-link coverage and exact exception mapping',()=>{
  for(const mutate of [
    input=>{input.originalManifest.members[0].links[0].xero_invoice_id=uuid(999999);},
    input=>{input.originalManifest.members[0].links.pop();},
    input=>{input.originalManifest.exceptions[0].reasons=['OTHER'];},
    input=>{input.grid[0][1]='changed@example.test';},
  ]){
    const {input,guard}=fixture();mutate(input);
    assert.throws(()=>guard.build(input),/original|2137|exceptions|grid hash/i);
  }
});

test('rejects duplicate identities, stale/rate-limited evidence and cross-scope collisions',()=>{
  for(const mutate of [
    input=>{input.evidence.provider.payments[1].id=input.evidence.provider.payments[0].id;},
    input=>{input.evidence.accounting.invoices[1].InvoiceID=input.evidence.accounting.invoices[0].InvoiceID;},
    input=>{input.evidence.observedAt='2026-09-22T11:54:59Z';},
    input=>{input.evidence.provider.observedAt='2026-09-22T12:10:01Z';},
    input=>{input.evidence.rateLimited=true;},
    input=>{input.scopes.beta.paymentIds.push(input.evidence.provider.payments[0].id);},
  ]){
    const {input,guard}=fixture();mutate(input);
    assert.throws(()=>guard.build(input),/Duplicate|Fresh|Incomplete|collision/);
  }
});

test('blocks subscriptions, pending/future payments, and missing state/classification/pricing',()=>{
  const {input,guard}=fixture();
  input.evidence.provider.subscriptions.push({id:'SB1',links:{mandate:input.grid[0][2]}});
  input.evidence.provider.payments.push({...input.evidence.provider.payments[1],id:'PMPENDING',
    status:'pending_submission',links:{...input.evidence.provider.payments[1].links,mandate:input.grid[1][2]}});
  input.evidence.provider.payments.push({...input.evidence.provider.payments[2],id:'PMFUTURE',
    charge_date:'2026-10-01',links:{...input.evidence.provider.payments[2].links,mandate:input.grid[2][2]}});
  delete input.evidence.members[3].pricing;
  input.evidence.members[4].status='paused';
  const manifest=guard.build(input);
  assert.equal(manifest.blocked.length,5);
  assert.equal(manifest.members.length,16);
});

test('rejects incomplete reconciliation and cross-member contact reuse',()=>{
  const missing=fixture();
  missing.input.evidence.provider.payments[0].metadata['Invoice number']='missing';
  assert.match(missing.guard.build(missing.input).blocked[0].reasons[0],/HISTORICAL_RECONCILIATION/);
  const shared=fixture();
  shared.input.evidence.accounting.invoices[1].Contact=shared.input.evidence.accounting.invoices[0].Contact;
  shared.input.evidence.accounting.contacts[0].EmailAddress=shared.input.grid[1][1];
  // Reconciliation itself fails closed because contact ownership no longer matches.
  assert.equal(shared.guard.build(shared.input).blocked.length,1);
});

test('synthetic deterministic preparation has no apply or eligibility path',()=>{
  const {input,guard}=fixture(),manifest=guard.build(input);
  const first=guard.prepare(manifest,input),second=guard.prepare(manifest,input);
  assert.deepEqual(first,second);
  assert.equal(first.writes,0);assert.equal(first.providerWrites,0);
  assert.equal(first.eligible,false);assert.equal(first.adoptionReady,false);
  assert.throws(()=>guard.prepare(manifest,input,{apply:true}),/no apply capability/);
  const changed=structuredClone(manifest);changed.policy.releaseApproved=true;
  assert.throws(()=>guard.prepare(changed,input),/reconstruction mismatch/);
});