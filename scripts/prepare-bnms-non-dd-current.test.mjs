import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceCandidate, invoiceProof, digest, recordId } from './prepare-bnms-non-dd-current.mjs';
import { deterministicId } from './bnms-non-dd-apply.mjs';

const invoice=()=>({
  InvoiceID:'invoice-1',Type:'ACCREC',Status:'PAID',DateString:'2025-09-22T00:00:00',
  Contact:{ContactID:'contact-1'},CurrencyCode:'GBP',Total:109,TotalTax:0,
  AmountPaid:109,AmountDue:0,AmountCredited:0,CreditNotes:[],Prepayments:[],Overpayments:[],
  LineItems:[{Description:'Full Membership Overseas',LineAmount:109,TaxAmount:0,
    Tracking:[{Name:'Projects',Option:'MEMBERSHIPS'}]}],
  Payments:[{PaymentID:'payment-1',Amount:109,Date:'/Date(1759104000000+0000)/'}],
});
test('unpaid newer renewal never replaces latest paid membership invoice',()=>{
  const newer={...invoice(),InvoiceID:'newer',DateString:'2026-09-22T00:00:00',Status:'AUTHORISED',AmountPaid:0,AmountDue:109};
  assert.equal(invoiceCandidate([newer,invoice()]).invoice.InvoiceID,'invoice-1');
});
test('equal-date paid membership invoices fail closed',()=>{
  assert.equal(invoiceCandidate([invoice(),{...invoice(),InvoiceID:'other'}]).state,'equal_date_or_missing_date_ambiguity');
});
test('voided, draft, deleted and unrelated invoices are not qualifying payments',()=>{
  for(const Status of ['VOIDED','DRAFT','DELETED','SUBMITTED']) {
    assert.equal(invoiceCandidate([{...invoice(),Status}]).state,'missing_paid_membership_invoice');
  }
  const unrelated=invoice();unrelated.LineItems[0].Tracking[0].Option='EDUCATION';
  assert.equal(invoiceCandidate([unrelated]).state,'missing_paid_membership_invoice');
});
test('credits, refunds, incomplete money and mixed lines fail closed',()=>{
  for(const patch of [
    {AmountCredited:1},{AmountCredited:undefined},{CreditNotes:[{}]},{Prepayments:[{}]},
    {Overpayments:[{}]},{AmountPaid:100},{AmountDue:1},{CurrencyCode:'EUR'},
    {Payments:[]},{Payments:[{PaymentID:'refund',Amount:-109}]},{TotalTax:1},
  ])assert.equal(invoiceCandidate([{...invoice(),...patch}]).state,'financial_or_mixed_invoice_conflict');
  const mixed=invoice();mixed.LineItems.push({Description:'Conference',Tracking:[]});
  assert.equal(invoiceCandidate([mixed]).state,'financial_or_mixed_invoice_conflict');
});
test('invoice evidence is stable against volatile provider metadata but sensitive to financial changes',()=>{
  const i=invoice(),h=digest(invoiceProof(i));
  assert.equal(digest(invoiceProof({...i,UpdatedDateUTC:'later',HasAttachments:true})),h);
  assert.notEqual(digest(invoiceProof({...i,Total:110})),h);
});
test('preparer and importer use the same deterministic row identity',()=>{
  const id='d91d8aa3-4981-4ba0-b923-ab6ccb092f9f';
  assert.equal(recordId(id),deterministicId(id));
});