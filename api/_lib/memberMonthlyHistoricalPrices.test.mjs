import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberMonthlyHistoricalPrices} from './memberMonthlyHistoricalPrices.js';
function fixture() {
 const owner={tenant_id:'t',member_id:'m'};
 const input={tenantId:'t',memberId:'m',
   purchase:{...owner,id:'purchase',billing_agreement_id:'agreement',term_key:'term',
     term_start_date:'2026-01-15',membership_renewal_date:'2027-01-15'},
   agreement:{...owner,id:'agreement'},plan:{...owner,id:'plan',billing_agreement_id:'agreement'},
   authority:{purchaseId:'purchase',planId:'plan',agreementId:'agreement',provider:'gocardless',
     pricingBasis:'monthly_price',currency:'GBP'}};
 const tables={gocardless_collection_reservations:[{id:'reservation',tenant_id:'t',plan_id:'plan',
   billing_agreement_id:'agreement',term_key:'term',collection_number:1,currency:'GBP',
   amount_minor:1200,gocardless_payment_id:'PM1',price_snapshot:{currency:'GBP',monthly_amount_minor:1200}}],
   gocardless_payments:[{id:'payment',tenant_id:'t',plan_id:'plan',gocardless_payment_id:'PM1',
     accounting_provider:'xero',accounting_invoice_id:'invoice'}]};
 const invoice={InvoiceID:'invoice',Type:'ACCREC',Status:'PAID',CurrencyCode:'GBP',
   Contact:{ContactID:'contact'},LineItems:[{}],SubTotal:10,TotalTax:2,Total:12};
 let calls=0;
 const db={from(table){const filters={};const q={select(){return q},eq(k,v){filters[k]=v;return q},
   order(){return q},async range(start,end){assert.equal(filters.tenant_id,'t');assert.equal(filters.plan_id,'plan');
     return {data:tables[table].filter(row=>Object.entries(filters).every(([k,v])=>row[k]===v)).slice(start,end+1)};}};
   return q;}};
 const service=createMemberMonthlyHistoricalPrices({db,readInvoice:async(tenant,id)=>{
   assert.equal(tenant,'t');assert.equal(id,'invoice');calls++;return invoice;}});
 return {input,tables,invoice,service,calls:()=>calls};
}
test('loads original full price and invoice net/tax into anniversary service accounting',async()=>{
 const f=fixture();
 const result=await f.service.load(f.input,'2026-02-15');
 assert.equal(result.deliveredService.netMinor,1000);
 assert.equal(result.deliveredService.vatMinor,200);
 assert.equal(result.evidence.periods[0].serviceStartDate,'2026-01-15');
 assert.equal(f.calls(),1);
 // Service consumed is not evidence of paid cash.
 f.invoice.Status='AUTHORISED';
 assert.equal((await f.service.load(f.input,'2026-02-15')).deliveredService.grossMinor,1200);
});
test('missing prices, voucher reductions, duplicated invoices and foreign linkage do not fall back',async()=>{
 for(const change of [
   f=>f.tables.gocardless_collection_reservations=[],
   f=>f.tables.gocardless_collection_reservations[0].amount_minor=1100,
   f=>f.tables.gocardless_collection_reservations[0].term_key='foreign',
   f=>f.tables.gocardless_payments[0].xero_invoice_id='another-invoice',
   f=>f.tables.gocardless_payments.push({...f.tables.gocardless_payments[0],id:'duplicate'}),
   f=>f.invoice.Total=13,
   f=>f.invoice.CreditNotes=[{CreditNoteID:'credit'}],
   f=>f.invoice.Status='VOIDED',
   f=>f.invoice.CurrencyCode='USD',
   f=>f.input.agreement.organization_id='org',
 ]) {
   const f=fixture();change(f);
   await assert.rejects(f.service.load(f.input,'2026-02-15'),{code:'amendment_evidence_required'});
 }
});
test('a partially used month still requires historical pricing; no future month is inferred',async()=>{
 const f=fixture();
 const result=await f.service.load(f.input,'2026-01-16');
 assert.equal(result.deliveredService.periods[0].elapsedDays,1);
 await assert.rejects(f.service.load(f.input,'2026-02-16'),/service month 2/);
});
test('missing provider invoices never become an empty or zero-valued service history',async()=>{
 const f=fixture();
 delete f.invoice.InvoiceID;
 await assert.rejects(f.service.load(f.input,'2026-02-15'),/ambiguous/);
});
