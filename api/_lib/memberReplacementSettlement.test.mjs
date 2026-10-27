import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectMemberReplacementSettlement} from './memberReplacementSettlement.js';
function fixture(){
 const plan={executionId:'execution',currency:'GBP',choice:'collect',
  targetFullPrice:{netMinor:7500,vatMinor:0,grossMinor:7500},
  transferred:{netMinor:5000,vatMinor:0,grossMinor:5000},surplus:{grossMinor:0},
  additionalPaymentMinor:2500,steps:[{providerTenantId:'books',contactId:'payer',reference:'MR:execution:new'}]};
 const invoice={InvoiceID:'new',Type:'ACCREC',Status:'PAID',Contact:{ContactID:'payer'},CurrencyCode:'GBP',
  Reference:'MR:execution:new',SubTotal:75,TotalTax:0,Total:75,AmountCredited:50,AmountPaid:25,AmountDue:0,
  CreditNotes:[{CreditNoteID:'transfer'}],Payments:[{PaymentID:'payment'}]};
 const payment={PaymentID:'payment',Status:'AUTHORISED',Invoice:{InvoiceID:'new'},Account:{AccountID:'bank'},Amount:25};
 const args={plan,providerTenantId:'books',documents:{new_invoice:{id:'new'},transfer_note:{id:'transfer'},
  transfer_allocation:{id:'allocation'}},request:async path=>path.startsWith('Invoices/')?{Invoices:[invoice]}:
   path.startsWith('Accounts/')?{Accounts:[{AccountID:'bank',Type:'BANK',BankAccountCurrencyCode:'GBP'}]}:{Payments:[payment]}};
 return {args,invoice,payment};
}
test('full new term is settled only by its exact transferred value plus verified additional cash',async()=>{
 const f=fixture(),result=await inspectMemberReplacementSettlement(f.args);
 assert.equal(result.state,'settled');assert.equal(result.evidence.verified,true);
 assert.equal(result.evidence.amount.grossMinor,7500);
 assert.deepEqual(result.evidence.cashPayments,[{paymentId:'payment',amountMinor:2500}]);
});
test('an invoice is not payment, and incomplete collections keep membership unapplied',async()=>{
 const f=fixture();f.invoice.Payments=[];f.invoice.AmountPaid=0;f.invoice.AmountDue=25;f.invoice.Status='AUTHORISED';
 const result=await inspectMemberReplacementSettlement(f.args);
 assert.equal(result.state,'awaiting_payment');assert.equal(result.evidence.amountDueMinor,2500);
});
test('mismatched cash, credit identity and other funding fail closed',async()=>{
 for(const change of [
  f=>f.payment.Invoice.InvoiceID='other',f=>f.payment.Amount=24,
  f=>f.invoice.CreditNotes[0].CreditNoteID='other',f=>f.invoice.AmountCredited=49,
  f=>f.invoice.Prepayments=[{Amount:25}],f=>f.invoice.Payments.push({PaymentID:'payment'}),
 ]){
  const f=fixture();change(f);await assert.rejects(inspectMemberReplacementSettlement(f.args));
 }
});
