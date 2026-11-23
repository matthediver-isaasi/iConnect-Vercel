import test from 'node:test';
import assert from 'node:assert/strict';
import {planFunnelInvoiceCredits} from './eventFunnelCreditPlan.js';
function fixture(){
  return {tenantId:'tenant',orderId:'order',
    reversal:{id:'reversal',tenant_id:'tenant',order_id:'order',cancelled_at:'2026-11-23',state:'processing',
      allocations:[{source:'booking',id:'one',invoiceMinor:100},{source:'booking',id:'two',invoiceMinor:200}]},
    invoiceWork:[{id:'work',tenant_id:'tenant',order_id:'order',status:'complete',provider:'xero',xero_tenant_id:'original-company',
      invoice_id:'invoice',issued_evidence:{InvoiceID:'invoice',CurrencyCode:'GBP',Contact:{ContactID:'original-customer'}},
      snapshot:{eventFunnel:{lineAllocations:[]}}}],
    invoiceLinks:['one','two'].map(id=>({tenant_id:'tenant',invoice_work_id:'work',booking_source:'booking',booking_id:id})),
    creditHistory:[]};
}
test('one shared-invoice credit retains individual selected amounts and original customer',()=>{
  const f=fixture(),[job]=planFunnelInvoiceCredits(f);
  assert.deepEqual(job.selected.map(i=>i.amountMinor),[100,200]);
  assert.equal(job.company_id,'original-company');
  job.original_invoice.Contact.ContactID='changed';
  assert.equal(f.invoiceWork[0].issued_evidence.Contact.ContactID,'original-customer');
});
test('missing history, invoice delivery and ambiguous links cannot create credit plans',()=>{
  for(const change of [
    f=>delete f.creditHistory,f=>{f.invoiceWork[0].status='retry';},
    f=>f.invoiceLinks.push({...f.invoiceLinks[0]}),f=>{f.invoiceWork[0].order_id='another';},
  ]){
    const f=fixture();change(f);assert.throws(()=>planFunnelInvoiceCredits(f));
  }
});
test('earlier credits require exact receipts and uncertainty blocks later credits',()=>{
  const f=fixture();f.creditHistory=[{id:'previous',invoice_work_id:'work',tenant_id:'tenant',order_id:'order',
    reversal_id:'previous-reversal',status:'complete',selected:[{source:'booking',id:'one',amountMinor:1}],
    receipt:{creditNoteId:'credit',invoiceId:'invoice',currency:'GBP',amountMinor:1}}];
  assert.deepEqual(planFunnelInvoiceCredits(f)[0].prior_amounts,{'booking:one':1});
  f.creditHistory[0].status='writing';assert.throws(()=>planFunnelInvoiceCredits(f),/reconciled/);
});
