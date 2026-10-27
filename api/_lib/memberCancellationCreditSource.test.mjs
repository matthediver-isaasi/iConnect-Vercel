import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCancellationCreditSource as verify} from './memberCancellationCreditSource.js';
import {createMemberAmendmentFinance} from './memberAmendmentFinance.js';
function fixture(){
 const amount={netMinor:1000,vatMinor:0,grossMinor:1000};
 const invoice={InvoiceID:'invoice',Type:'ACCREC',Status:'PAID',Contact:{ContactID:'payer'},
  CurrencyCode:'GBP',SubTotal:10,TotalTax:0,Total:10,AmountPaid:10,AmountDue:0,
  Payments:[{PaymentID:'payment'}],LineItems:[{AccountCode:'200',TaxType:'NONE'}]};
 const payment={PaymentID:'payment',Status:'AUTHORISED',Invoice:{InvoiceID:'invoice'},
  Account:{AccountID:'bank'},Amount:10};
 const source={id:'history',payment_method:'bank',commitment_snapshot:{payment_frequency:'upfront'}};
 const evidence={complete:true,sourceRecordId:'history',currency:'GBP',contactId:'payer',providerTenantId:'xero',
  invoices:[{id:'invoice',currency:'GBP',contactId:'payer',providerTenantId:'xero',amount,paid:amount}],
  providerEvidence:{originalPaymentIds:['payment']}};
 const record={id:'cancel',tenant_id:'tenant',member_id:'member',source_record_id:'history',
  source_snapshot:source,access_ended_at:'2026-01-01'};
 const steps=[{request_id:'cancel',step_key:'original',state:'observed',evidence:{id:'invoice'},
  descriptor:{key:'original',kind:'original_invoice',providerTenantId:'xero',readOnly:true,
   invoiceId:'invoice',currency:'GBP',contactId:'payer',amount,accountCode:'200',taxCode:'NONE'}}];
 let cardChecks=0,bankChecks=0;
 const amendment={id:'cancel',tenant_id:'tenant',member_id:'member',quote:{currency:'GBP',sourceSnapshot:source},
  cancellationProof:{record,sourceEvidence:evidence,steps}};
 const args={amendment,xeroTenantId:'xero',
  request:async(path,options)=>{
   assert.equal(options,undefined);
   if(path==='Invoices/invoice')return {Invoices:[invoice]};
   if(path==='Payments/payment')return {Payments:[payment]};
   throw Error('Unexpected request');
  },verifyCard:async()=>{cardChecks++;},verifyBankAccounts:async()=>{bankChecks++;}};
 return {args,source,evidence,record,invoice,payment,checks:()=>({cardChecks,bankChecks})};
}
test('cancellation credit verifies original owned invoice payments after access has ended',async()=>{
 const f=fixture();assert.deepEqual(await verify(f.args),f.evidence.providerEvidence);
 assert.deepEqual(f.checks(),{cardChecks:1,bankChecks:1});
});
test('changed, duplicated and foreign source payments cannot fund a wallet',async()=>{
 const f=fixture();f.evidence.providerEvidence.originalPaymentIds=['other'];
 await assert.rejects(verify(f.args),/requires reconciliation/);
 f.evidence.providerEvidence.originalPaymentIds=['payment'];f.payment.Invoice.InvoiceID='other';
 await assert.rejects(verify(f.args),/requires reconciliation/);
 f.payment.Invoice.InvoiceID='invoice';f.invoice.Payments.push({PaymentID:'payment'});
 await assert.rejects(verify(f.args),/requires reconciliation/);
});
test('Stripe uses verified card evidence, not a fabricated bank classification for a clearing account',async()=>{
 const f=fixture();f.source.payment_method='stripe';
 await verify(f.args);assert.deepEqual(f.checks(),{cardChecks:1,bankChecks:0});
 f.args.verifyCard=async()=>{throw Error('Disputed charge');};
 await assert.rejects(verify(f.args),/Disputed charge/);
});
test('monthly source receipts retain charge identity and unknown collections block redemption',async()=>{
 const f=fixture();f.source.commitment_snapshot.payment_frequency='monthly';
 const cash={complete:true,provider:'stripe',currency:'GBP',unresolved:[],
  payments:[{id:'invoice',amountMinor:1000,date:'2026-01-01',chargeId:'charge'}]};
 f.evidence.cash=structuredClone(cash);f.args.verifyMonthlyCash=async()=>cash;
 await verify(f.args);
 cash.payments[0].chargeId='replacement-charge';
 await assert.rejects(verify(f.args),/requires reconciliation/);
 cash.payments[0].chargeId='charge';cash.unresolved.push({id:'pending'});
 await assert.rejects(verify(f.args),/requires reconciliation/);
});
test('the shared redemption verifier accepts cancellation VAT amounts and rejects conflicting aliases',async()=>{
 const f=fixture(),binding={version:1,provider:'xero',providerTenantId:'xero',accountId:'liability',
  accountCode:'900',currency:'GBP',kind:'iconnect_member_credit_liability'};
 f.args.amendment.execution_kind='cancellation';
 const note={CreditNoteID:'note',Type:'ACCRECCREDIT',Status:'PAID',Contact:{ContactID:'payer'},
  CurrencyCode:'GBP',Reference:'cancel:surplus',SubTotal:5,TotalTax:0,Total:5,RemainingCredit:0,
  LineItems:[{AccountCode:'200',TaxType:'NONE'}],Allocations:[],Payments:[{PaymentID:'backing'}]};
 const backing={PaymentID:'backing',Status:'AUTHORISED',CreditNote:{CreditNoteID:'note'},
  Account:{AccountID:'liability'},Reference:'cancel:surplus:member-credit',Amount:5};
 const accounts=[{AccountID:'bank',Type:'BANK',Status:'ACTIVE'},
  {AccountID:'liability',Code:'900',Status:'ACTIVE',Type:'CURRENTLIABILITY',EnablePaymentsToAccount:true}];
 const finance=createMemberAmendmentFinance({
  providerForTenant:async()=>({name:'xero',getRawAccessToken:async()=>({accessToken:'fixture',tenantId:'xero'})}),
  fetcher:async(url,options)=>{
   assert.equal(options.method,'GET');
   const path=url.split('/2.0/')[1];let body;
   if(path.startsWith('CreditNotes'))body={CreditNotes:[note]};
   else if(path==='Payments/backing')body={Payments:[backing]};
   else if(path.startsWith('Accounts'))body={Accounts:path.includes('Code')?[accounts[1]]:[accounts[0]]};
   else if(path==='Organisation')body={Organisations:[{BaseCurrency:'GBP'}]};
   else body=await f.args.request(path);
   return {ok:true,json:async()=>body};
  },
 });
 const settlement={choice:'credit',context:{xeroTenantId:'xero',contactId:'payer',currency:'GBP',
  reference:'cancel:surplus',accountCode:'200',taxCode:'NONE',
  amounts:{netMinor:500,vatMinor:0,grossMinor:500},memberCreditLiabilityBinding:binding}};
 const result=await finance.inspect(f.args.amendment,settlement);
 assert.equal(result.state,'settled');assert.equal(result.evidence.paymentId,'backing');
 settlement.context.amounts.taxMinor=1;
 await assert.rejects(finance.inspect(f.args.amendment,settlement),/Conflicting reserved VAT/);
});
