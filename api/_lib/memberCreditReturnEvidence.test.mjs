import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMemberCreditReturnPayments as verify,readMemberCreditReturnPayments as read} from './memberCreditReturnEvidence.js';
const entries=[{reference:'funding:a',invoiceId:'invoice',paymentId:'original',amountMinor:1000}];
const payment={Reference:'funding:a',PaymentID:'original',Invoice:{InvoiceID:'invoice'},
 Account:{AccountID:'liability'},Amount:10,Status:'AUTHORISED'};
const check=(payments,expectedActiveMinor=500,extra={})=>verify({entries,payments,expectedActiveMinor,accountId:'liability',...extra});
test('cash refund without liability reversal cannot restore member credit',()=>{
 assert.throws(()=>check([payment]),/reconciliation/);
 assert.deepEqual(check([{...payment,Status:'DELETED'},{...payment,PaymentID:'replacement',Amount:5}]),
  {verified:true,activeMinor:500});
 assert.deepEqual(check([],0),{verified:true,activeMinor:0});
});
test('foreign accounts, invoices, currencies and ambiguous payments are rejected',()=>{
 for(const change of [
  {Account:{AccountID:'bank'}},{Invoice:{InvoiceID:'other'}},{CurrencyRate:2},
  {Reference:'other'},{Status:'PENDING'},{Amount:null},{Amount:'5.001'},
  {Amount:true},{Amount:[5]},{Amount:'0x5'},
  {CreditNote:{CreditNoteID:'note'}},{PaymentID:''},
 ])assert.throws(()=>check([{...payment,Amount:5,...change}]),/reconciliation/);
 assert.throws(()=>check([{...payment,Amount:2.5},{...payment,Amount:2.5}]),/reconciliation/);
 assert.throws(()=>check([],0,{entries:[]}),/reconciliation/);
 assert.throws(()=>check([],0,{entries:[...entries,...entries]}),/reconciliation/);
});
test('query omission cannot pretend the original payment was deleted',async()=>{
 const rows=await read({entries,request:async path=>path.includes('?')?{Payments:[]}:{Payments:[payment]}});
 assert.throws(()=>check(rows,0),/reconciliation/);
});
test('read-only recovery includes replacement payments and rejects incomplete responses',async()=>{
 const requests=[];
 const rows=await read({entries,request:async path=>{
  requests.push(path);
  return {Payments:path.includes('?')?[{...payment,PaymentID:'replacement',Amount:5}]:[{...payment,Status:'DELETED'}]};
 }});
 assert.equal(check(rows).activeMinor,500);assert.equal(requests.length,2);
 await assert.rejects(read({entries,request:async path=>path.includes('?')?{}:{Payments:[payment]}}),/Complete accounting/);
 await assert.rejects(read({entries,request:async path=>({Payments:path.includes('?')
  ?[{...payment,Status:'DELETED'}]:[payment]})}),/changed during verification/);
});
test('excessive or never-ending pagination fails closed',async()=>{
 await assert.rejects(read({entries:Array(51).fill(entries[0]),request(){assert.fail();}}),/bounded set/);
 await assert.rejects(read({entries,request:async path=>({Payments:path.includes('?')?Array(100).fill(payment):[payment]})}),/verification limit/);
});
