// Script-only, exact resources from the completed 2026-09-21 readiness scan
// plus the narrowly renewed event-invoice evidence approved on 2026-09-22.
// Approval is permission to leave these items for manual follow-up, NOT to pay,
// retry, write off, reconcile, or mutate any provider/canonical financial row.
import {hash} from './bnms-dd-beta-invoices.mjs';

const payments=[
  ['af48718a-aeb9-4f89-a03a-6884e987b974','CU004ECM767E3C','MD0039Q2X5TY4Y','PM01ST98RXMP3P','2026-02-18',1068,'289532c0bc45edd771a949fb89c26d64001fea14ce51afc173853f83d8cf7c8e'],
  ['b31a72f6-b764-4554-a6f7-0c262b5e9403','CU00426EDA9JNT','MD00330XCA59M9','PM01XSNT51XH733D5RSP93QRXN9S','2026-09-08',1304,'616ee12cd826c93c20b270a628c0ad6531408262fdea6d20f80b56d77b523808'],
  ['40f32190-8286-4f65-87af-6c051135e619','CU01KV0BAFNS85','MD01KJ63RP2PD5','PM01XSNT7DK2EAZCH8R4SXCNFMPM','2026-09-08',1304,'ad10fede3081474af0d9209ef833b42c89f6dd3e0d7f91951e77baea166f8989'],
  ['40f32190-8286-4f65-87af-6c051135e619','CU01KV0BAFNS85','MD01KJ63RP2PD5','PM01XQ5ZCZ92BHQMN882B7GQCHN7','2026-08-10',1304,'1d407a9a98334358dc1b6e594f8061f499d16e9c8a68abc894387c5df0e5bb22'],
  ['40f32190-8286-4f65-87af-6c051135e619','CU01KV0BAFNS85','MD01KJ63RP2PD5','PM01XJ8YDE75WZ4378FGT44VJDV7','2026-07-31',1304,'d60b8011586da9b81998d17fe2952aec1425ad1743205685eb3e4312e22f67cf'],
].map(([memberId,customerId,mandateId,id,date,amount,digest])=>({kind:'payment',memberId,customerId,mandateId,id,date,amount,status:'failed',currency:'GBP',digest}));
const invoices=[
  ['b31a72f6-b764-4554-a6f7-0c262b5e9403','38a1a6a0-812b-49dd-a544-276509ca4002','d7ef39f1-4488-4a12-a929-57e74fc6907e','2026-09-01T00:00:00',13.04,'bf681bb9e1be56565c70d49233e2482dbc52cd0c0ef1598e0699e293177c50e4'],
  ['40f32190-8286-4f65-87af-6c051135e619','91c069bd-460b-43ba-9b03-dd8d191f8946','0e3abea3-02c7-4dfd-91a9-973d429b9173','2026-09-01T00:00:00',13.04,'fd523dfc76624093d39b83186995a8403760f411ab2f9e4daef0b6675fef13b4'],
].map(([memberId,contactId,id,date,amount,digest])=>({kind:'invoice',memberId,contactId,id,date,amount,status:'AUTHORISED',currency:'GBP',digest}));
const events=[
  ['e553175b-8a9b-523c-aa40-19fbdf1acc8a','07cd2024-ff4b-48f2-bf99-e71db5f92d42','1ade600c-0a15-444c-bd25-842a5fd5aa70','ca9971af3b504171078ad1cd8910f323242d7179e73f878063b66387a2a035a7'],
  ['b31a72f6-b764-4554-a6f7-0c262b5e9403','38a1a6a0-812b-49dd-a544-276509ca4002','58219674-c351-4fca-b009-6cbd4b4f323e','b566e7dcd9da60bdb20c015fb6bfea152c438ce983734775b0616d8bc1a59258'],
  ['ad806e51-cb3d-4269-b88d-3fb04082a839','93e15381-689e-4f23-94fa-b1afd039a0d0','44d32213-ccf8-4bd8-8f50-1261513f2803','91457504431bb8390bf36aa2a090e7d34e9fb17620f1b1c7ece07b8f10d32354'],
  ['22f26bba-cfbc-48a6-a881-a6f0f15ffd45','08c254a8-8346-4fb6-ab93-d16f9a03491b','3af832fe-0243-449c-b345-3db131f26c86','9f2fe1a6fd5257ce4ba24ebf4e3e48105efd62f9eb6d93f5ad2a807a6c13db3f'],
  ['398c1645-f752-4151-8b8e-d232fc4222c7','ad860121-ffdd-4fc8-abbc-018f67823399','631543be-e306-41e0-98c0-138d677b3dd8','05b13b0919afe11541e637207d030f35e0c1efc6380acaeefbc09ca853b338af'],
  ['46d036ed-b430-44a7-83b0-e2abb5d16cd6','7da1b325-383b-43cf-9fac-07b5f19219bc','3028af51-72b9-469e-ad2a-7504e29f0685','a679210f3fe4ee3b8a8d0f26273001d2743f9c85994bc2c167c36a3076dfbd58'],
].map(([memberId,contactId,id,digest])=>({kind:'unrelated_event',memberId,contactId,id,digest}));
const approval={
  version:2,manifestSha256:'3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a',
  provenance:{source:'User instruction relayed in current BNMS Alpha release-exceptions task',
    approvalDate:'2026-09-21',approvedAt:null,timePrecision:'Exact user-message timestamp unavailable; date from task context only',
    summary:'Leave two unpaid membership invoices and five historical failed attempts for three members untouched for manual follow-up; provide member details after run.',
    evidence:'exports/private-bnms-alpha-attestation-20260921/readiness-dryrun-renewed.json; exports/private-bnms-alpha-readiness/checkpoint.json'},
  renewals:[{
    kind:'unrelated_event',invoiceNumber:'200008893',id:'1ade600c-0a15-444c-bd25-842a5fd5aa70',
    approvalDate:'2026-09-22',approvedAt:null,
    source:'User explicitly approved renewed exception in current BNMS Alpha readiness task',
    disposition:'keep_collections_held_manual_follow_up_no_financial_mutation',
    previousDigest:'66b6c69bb31a3ba61cd0c040fe2c75c0d166da8b1566d9f0973f3e3d06a8a97a',
    digest:'ca9971af3b504171078ad1cd8910f323242d7179e73f878063b66387a2a035a7',
    observedChange:{creditNoteNumber:'200008893C',creditAmount:60,currency:'GBP',amountDue:207.27},
    evidence:'exports/private-bnms-alpha-attestation-20260922/readiness-only-resume-0935.json; exports/private-bnms-alpha-readiness/checkpoint.json',
  }],
  disposition:'manual_follow_up_no_financial_mutation',payments,invoices,events,
};
export const alphaManualApproval=()=>structuredClone(approval);
export const ALPHA_MANUAL_APPROVAL_SHA256=hash(approval);

export function approvedAlphaFailedPayment(owner,payment){
  return payments.some(p=>p.memberId===owner.memberId&&p.customerId===owner.customerId&&p.mandateId===owner.mandateId
    &&p.id===payment.id&&payment.links?.mandate===p.mandateId&&payment.status===p.status
    &&payment.charge_date===p.date&&payment.amount===p.amount&&payment.currency===p.currency&&hash(payment)===p.digest);
}
export function approvedAlphaUnpaidInvoice(owner,invoice){
  return invoices.some(p=>p.memberId===owner.memberId&&p.contactId===owner.contactId
    &&p.id===invoice.InvoiceID&&invoice.Contact?.ContactID===p.contactId&&invoice.Status===p.status
    &&invoice.DateString===p.date&&invoice.AmountDue===p.amount&&invoice.CurrencyCode===p.currency&&hash(invoice)===p.digest);
}
export function alphaPaymentHistoryRequiresReconciliation(owner,providerPayments,stored){
  const windowPayments=providerPayments.filter(p=>p.charge_date>='2026-01-01'&&!approvedAlphaFailedPayment(owner,p));
  return windowPayments.length!==stored.length
    ||providerPayments.some(p=>['pending_submission','submitted','confirmed'].includes(p.status)
      ||p.charge_date>='2026-10-01'||(p.status==='failed'&&!approvedAlphaFailedPayment(owner,p)))
    ||windowPayments.some(p=>p.status!=='paid_out'||p.amount_refunded!==0
      ||!stored.some(h=>h.provider_payment_id===p.id&&h.amount_minor===p.amount&&h.currency===p.currency&&h.charge_date===p.charge_date));
}
export function unrelatedAlphaEventInvoice(owner,invoice,accounts){
  return invoice.Type==='ACCREC'&&invoice.CurrencyCode==='GBP'&&invoice.DateString?.slice(0,10)<'2026-10-01'
    &&Array.isArray(invoice.LineItems)&&invoice.LineItems.length>0
    &&invoice.LineItems.every(line=>['210','230'].includes(line.AccountCode)
      &&accounts.filter(a=>a.Code===line.AccountCode&&a.Status==='ACTIVE'&&a.Type==='REVENUE').length===1)
    &&events.some(p=>p.memberId===owner.memberId&&p.contactId===owner.contactId
      &&invoice.Contact?.ContactID===p.contactId&&invoice.InvoiceID===p.id&&hash(invoice)===p.digest);
}

// Presence as well as equality matters: disappearance/reownership never silently
// removes a previously approved exception from the economic release review.
export function assertAlphaManualEvidence(members){
  for(const p of [...payments,...invoices,...events]){
    const m=members.find(m=>m.memberId===p.memberId);
    const records=p.kind==='payment'?m?.provider?.payments:m?.exceptionInvoices;
    const current=records?.filter(r=>(p.kind==='payment'?r.id:r.InvoiceID)===p.id);
    if(current?.length!==1||hash(current[0])!==p.digest
      ||(p.kind==='payment'?!approvedAlphaFailedPayment(m,current[0]):
        m.accounting?.contactId!==p.contactId||current[0].Contact?.ContactID!==p.contactId))
      throw Error('Pinned alpha manual exception evidence changed or missing');
  }
}