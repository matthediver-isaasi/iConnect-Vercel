import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMemberCancellationBalance as inspect} from './memberCancellationBalance.js';
function fixture(choice='collect'){
 const original={key:'original',kind:'original_invoice',contactId:'payer',
  amount:{netMinor:1000,vatMinor:0,grossMinor:1000}};
 const plan={requestId:'request',currency:'GBP',choice,surplusMinor:500,steps:[original]};
 const invoice={InvoiceID:'invoice',Contact:{ContactID:'payer'},CurrencyCode:'GBP',
  Status:'PAID',Total:10,AmountPaid:10,AmountCredited:0,AmountDue:0,Payments:[{PaymentID:'payment'}]};
 const payment={PaymentID:'payment',Status:'AUTHORISED',Invoice:{InvoiceID:'invoice'},Amount:10,Account:{AccountID:'bank'}};
 const note={CreditNoteID:'note',Payments:[],Allocations:[],RemainingCredit:5};
 const refund={PaymentID:'refund',Status:'AUTHORISED',IsReconciled:true,
  CreditNote:{CreditNoteID:'note'},Amount:5,Account:{AccountID:'bank'},Reference:'cancel:surplus:refund'};
 const accounts=[{AccountID:'bank',Type:'BANK'}];
 const steps=[{step_key:'original',state:'observed',evidence:{id:'invoice'}}];
 const observed={original:{state:'observed',id:'invoice'}};
 if(choice==='refund'||choice==='credit'){
  plan.steps.push({key:'surplus_note',kind:'credit_note',reference:'cancel:surplus'});
  steps.push({step_key:'surplus_note',state:'observed',evidence:{id:'note'}});
  observed.surplus_note={state:'observed',id:'note',document:note};
 }
 const args={plan,steps,adapter:{inspect:async step=>observed[step.key]},
  request:async(path,options)=>{
   assert.equal(options,undefined,'Settlement checks must never send money');
   if(path==='Invoices/invoice')return {Invoices:[invoice]};
   if(path==='Payments/payment')return {Payments:[payment]};
   if(path==='Payments/refund')return {Payments:[refund]};
   if(path==='Accounts')return {Accounts:accounts};
   throw Error(`Unexpected read: ${path}`);
  }};
 return {args,invoice,payment,note,refund,accounts,observed};
}
test('settlement requires actual invoice payments rather than the existence of a document',async()=>{
 const f=fixture();const result=await inspect(f.args);
 assert.equal(result.state,'settled');assert.equal(result.evidence.kind,'debt_paid');
 Object.assign(f.invoice,{Status:'AUTHORISED',AmountPaid:0,AmountDue:10,Payments:[]});
 const pending=await inspect(f.args);
 assert.equal(pending.state,'awaiting_payment');assert.equal(pending.evidence.dueMinor,1000);
});
test('missing and foreign payment evidence cannot settle a cancellation',async()=>{
 const f=fixture();f.payment.Invoice.InvoiceID='other';
 await assert.rejects(inspect(f.args),/verified, owned/);
 f.payment.Invoice.InvoiceID='invoice';f.invoice.Payments=[];
 await assert.rejects(inspect(f.args),/coverage is incomplete/);
});
test('a credit note does not prove that money was refunded',async()=>{
 const f=fixture('refund');
 const pending=await inspect(f.args);
 assert.equal(pending.state,'awaiting_refund');
 assert.equal(pending.evidence.requiredPaymentReference,'cancel:surplus:refund');
 f.note.Payments=[{PaymentID:'refund'}];f.note.RemainingCredit=0;
 const paid=await inspect(f.args);
 assert.equal(paid.state,'settled');assert.equal(paid.evidence.refundedMinor,500);
 f.refund.IsReconciled=false;
 await assert.rejects(inspect(f.args),/bank-reconciled/);
});
test('refunds must use bank accounts and cannot leave spendable credit',async()=>{
 const f=fixture('refund');f.note.Payments=[{PaymentID:'refund'}];f.note.RemainingCredit=1;
 await assert.rejects(inspect(f.args),/Full cash refund/);
 f.note.RemainingCredit=0;f.accounts[0].Type='CURRENTLIABILITY';
 await assert.rejects(inspect(f.args),/original-owner reconciliation/);
});
test('pending journal steps and changed document identities do not finalize',async()=>{
 const f=fixture();f.args.steps[0].state='uncertain';
 assert.equal((await inspect(f.args)).state,'awaiting_reconciliation');
 f.args.steps[0].state='observed';f.observed.original.id='other';
 await assert.rejects(inspect(f.args),/evidence changed/);
});
test('partial invoice payments retain only the remaining earned balance',async()=>{
 const f=fixture();Object.assign(f.invoice,{AmountPaid:4,AmountDue:6,Status:'AUTHORISED'});
 f.payment.Amount=4;
 const result=await inspect(f.args);
 assert.equal(result.state,'awaiting_payment');assert.equal(result.evidence.dueMinor,600);
});
test('a verified partial refund remains outstanding rather than failing or settling early',async()=>{
 const f=fixture('refund');f.note.Payments=[{PaymentID:'refund'}];
 f.refund.Amount=2.5;f.note.RemainingCredit=2.5;
 const result=await inspect(f.args);
 assert.equal(result.state,'awaiting_refund');
 assert.equal(result.evidence.refundedMinor,250);assert.equal(result.evidence.remainingMinor,250);
});
