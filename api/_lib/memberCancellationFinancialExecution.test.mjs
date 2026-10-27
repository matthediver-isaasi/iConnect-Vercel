import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationFinancialExecution} from './memberCancellationFinancialExecution.js';
function fixture(){
 const context={tenantId:'tenant',memberId:'member',actorId:'actor',isAdmin:true};
 const descriptor={key:'source',kind:'original_invoice',readOnly:true,invoiceId:'invoice',
  providerTenantId:'xero',contactId:'payer',currency:'GBP',accountCode:'200',taxCode:'NONE',
  amount:{netMinor:1000,vatMinor:0,grossMinor:1000}};
 const operation={id:'step',request_id:'request',step_key:'source',descriptor,state:'pending',claim_token:null};
 const record={id:'request',tenant_id:'tenant',member_id:'member',access_ended_at:'2026-01-01'};
 const financial={request_id:'request',tenant_id:'tenant',member_id:'member',
  plan:{steps:[descriptor]},source_evidence:{providerTenantId:'xero'}};
 const invoice={InvoiceID:'invoice',Type:'ACCREC',Status:'PAID',CurrencyCode:'GBP',
  Contact:{ContactID:'payer'},SubTotal:10,TotalTax:0,Total:10,AmountPaid:10,AmountDue:0,
  LineItems:[{AccountCode:'200',TaxType:'NONE'}]};
 let claimed=0,readError;
 const service=createMemberCancellationFinancialExecution({db:{
  from(table){
   const data=table==='member_cancellation_request'?record:
    table==='member_cancellation_finance'?financial:[{...operation}];
   const q={select(){return q},eq(){return q},order(){return q},range(){return q},
    maybeSingle:async()=>({data}),then(resolve,reject){return Promise.resolve({data}).then(resolve,reject)}};
   return q;
  },
  async rpc(name,args){
   if(name==='claim_member_cancellation_finance_step'){
    const winner=operation.state==='pending';
    if(winner){claimed++;operation.state='claimed';operation.claim_token='exclusive';}
    return {data:{claimed:winner,operation:{...operation}}};
   }
   assert.equal(args.p_claim_token,operation.claim_token);
   operation.evidence=args.p_evidence;
   operation.state=args.p_evidence.state==='observed'?'observed':
    args.p_evidence.state==='not_submitted'?'pending':'uncertain';
   return {data:{...operation}};
  },
 },accountingForTenant:async tenant=>{
  assert.equal(tenant,'tenant');
  return {xeroTenantId:'xero',request:async(_path,options)=>{
   assert.equal(options,undefined,'Original invoice must never be written');
   if(readError)throw readError;
   return {Invoices:[invoice]};
  }};
 }});
 return {service,context,operation,record,invoice,get claimed(){return claimed},
  failRead(error){readError=error}};
}
test('approved original invoice is read, observed and never rewritten',async()=>{
 const f=fixture();
 assert.equal((await f.service.run(f.context,'request','source')).state,'observed');
 await f.service.run(f.context,'request','source');
 assert.equal(f.claimed,1);
});
test('a recovery-read outage cannot release an earlier unknown write claim',async()=>{
 const f=fixture();
 Object.assign(f.operation,{state:'uncertain',claim_token:'earlier-claim'});
 f.failRead(Object.assign(new Error('throttled'),{status:429,replacementWriteRejected:true}));
 assert.equal((await f.service.run(f.context,'request','source')).state,'uncertain');
 assert.equal(f.operation.evidence.provenNotSubmitted,undefined);
 assert.equal(f.claimed,0);
});
test('initial read-only outage can defer safely without consuming a monetary attempt',async()=>{
 const f=fixture();f.failRead(Object.assign(new Error('temporary'),{status:503}));
 assert.equal((await f.service.run(f.context,'request','source')).state,'pending');
 assert.equal(f.operation.evidence.provenNotSubmitted,true);
});
test('foreign source scope fails before provider reads or financial claims',async()=>{
 const f=fixture();f.record.member_id='other';
 await assert.rejects(f.service.run(f.context,'request','source'),/Owned applied/);
 assert.equal(f.claimed,0);
});
