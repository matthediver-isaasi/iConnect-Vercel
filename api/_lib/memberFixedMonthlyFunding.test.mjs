import test from 'node:test';
import assert from 'node:assert/strict';
import {readMemberFixedMonthlyFunding} from './memberFixedMonthlyFunding.js';
for(const provider of ['stripe','gocardless']){
  test(`${provider}: actual receipts/invoices and immutable annual contract determine delivered value`,async()=>{
    const dates=['2024-01-02','2024-02-02','2024-03-02','2024-04-02','2024-05-02','2024-06-02'];
    const amounts={final_cost:120,vat_amount:0,total_with_vat:120};
    const input={tenantId:'t',memberId:'m',effectiveDate:'2024-07-02',
      purchase:{id:'purchase',...amounts,commitment_snapshot:{amounts},term_start_date:'2024-01-01',membership_renewal_date:'2025-01-01'},
      agreement:{id:'agreement',metadata:{[provider==='stripe'?'card':'dd']:{plan_total:120}}},
      plan:{id:'plan'},authority:{pricingBasis:'annual_instalments',provider,currency:'GBP',collectionDates:dates}};
    const funding={sourceRecordId:'purchase',planId:'plan',agreementId:'agreement',currency:'GBP',provider,
      pendingGrossMinor:0,settledGrossMinor:6000,
      payments:dates.map((date,i)=>({id:`payment-${i}`,date,amountMinor:1000,settled:true}))};
    const rows=funding.payments.map(p=>({id:p.id,external_payment_id:p.id,gocardless_payment_id:p.id,
      provider,billing_agreement_id:'agreement',accounting_provider:'xero',
      accounting_invoice_id:`invoice-${p.id}`,amount_minor:1000,currency:'GBP'}));
    const db={from(){return {select(){return this},eq(){return this},order(){return this},
      async range(start,end){return {data:rows.slice(start,end+1)}}}}};
    const readInvoice=async(_,id)=>({InvoiceID:id,Type:'ACCREC',Status:'PAID',CurrencyCode:'GBP',
      Contact:{ContactID:'contact'},LineItems:[{}],SubTotal:10,TotalTax:0,Total:10});
    const result=await readMemberFixedMonthlyFunding({db,input,funding,readInvoice});
    assert.equal(result.sourcePrice.grossMinor,12000);
    assert.equal(result.fundingEvidence.deliveredService.grossMinor,6000);
    assert.equal(result.fundingEvidence.settledFunding.length,6);
    funding.payments.pop();
    await assert.rejects(readMemberFixedMonthlyFunding({db,input,funding,readInvoice}),/missing past collections/);
    funding.payments.push({id:'foreign',date:'2024-06-02',amountMinor:1000,settled:true});
    await assert.rejects(readMemberFixedMonthlyFunding({db,input,funding,readInvoice}),/unique purchase-linked/);
  });
}
