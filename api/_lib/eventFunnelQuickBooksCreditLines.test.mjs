import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelQuickBooksCreditLines} from './eventFunnelQuickBooksCreditLines.js';
function fixture(basis='TaxInclusive'){
  const gross=[1200,2400],tax=[200,400],amount=gross.map((v,i)=>basis==='TaxExcluded'?v-tax[i]:v);
  const original={Id:'invoice',CustomerRef:{value:'customer'},CurrencyRef:{value:'GBP'},GlobalTaxCalculation:basis,
    TotalAmt:36,TxnTaxDetail:{TotalTax:6,TaxLine:[{Amount:6,TaxLineDetail:{TaxRateRef:{value:'rate'}}}]},
    Line:amount.map((v,i)=>({Id:`line-${i}`,Description:'Same description',DetailType:'SalesItemLineDetail',Amount:v/100,
      SalesItemLineDetail:{ItemRef:{value:'item'},TaxCodeRef:{value:'code'},Qty:1,UnitPrice:v/100}})),
    taxAllocations:amount.map((v,i)=>({index:i,amountMinor:v,grossMinor:gross[i],taxMinor:tax[i],taxRateId:'rate',percentage:20}))};
  return {invoice:structuredClone(original),original,lineAllocations:gross.map((v,i)=>({
    index:i,source:'booking',bookingId:`booking-${i}`,amountMinor:v})),selected:[{source:'booking',id:'booking-0',amountMinor:1200}],priorAmounts:{}};
}
for(const basis of ['TaxInclusive','TaxExcluded'])test(`${basis} credit preserves original item and tax without touching another booking`,()=>{
  const f=fixture(basis),plan=buildFunnelQuickBooksCreditLines(f);
  assert.equal(plan.amountMinor,1200);assert.equal(plan.taxMinor,200);
  assert.equal(plan.payload.Line.length,1);
  assert.equal(plan.payload.Line[0].Amount,basis==='TaxExcluded'?10:12);
  assert.equal(plan.payload.TxnTaxDetail.TotalTax,2);
  assert.equal(plan.payload.TxnTaxDetail.TaxLine[0].TaxLineDetail.TaxRateRef.value,'rate');
});
test('provider percentage changes do not reinterpret the issued tax amount',()=>{
  const f=fixture();f.invoice.TxnTaxDetail.TaxLine[0].TaxLineDetail.TaxPercent=25;
  assert.equal(buildFunnelQuickBooksCreditLines(f).taxMinor,200);
  f.invoice.TxnTaxDetail.TaxLine[0].Amount=7;
  assert.throws(()=>buildFunnelQuickBooksCreditLines(f));
});
test('changed customer, item, quantities or missing history reject the credit',()=>{
  for(const change of [f=>{f.invoice.CustomerRef.value='other';},f=>{f.invoice.Line[0].SalesItemLineDetail.ItemRef.value='other';},
    f=>{f.invoice.Line[0].SalesItemLineDetail.Qty=2;},f=>delete f.priorAmounts]){
    const f=fixture();change(f);assert.throws(()=>buildFunnelQuickBooksCreditLines(f));
  }
});
test('identical descriptions and amounts remain pinned to distinct issued line IDs',()=>{
  const f=fixture();
  f.original.Line[1]={...structuredClone(f.original.Line[0]),Id:'line-1'};
  f.original.taxAllocations[1]={...f.original.taxAllocations[0],index:1};
  f.original.TotalAmt=24;f.original.TxnTaxDetail.TotalTax=4;f.original.TxnTaxDetail.TaxLine[0].Amount=4;
  f.invoice=structuredClone(f.original);
  assert.equal(buildFunnelQuickBooksCreditLines(f).allocations[0].invoiceLineId,'line-0');
});
test('funding deductions retain signed item amounts and original tax references',()=>{
  const f=fixture();
  Object.assign(f.original.Line[1],{Description:'Funding',Amount:-3});
  f.original.Line[1].SalesItemLineDetail.UnitPrice=-3;
  Object.assign(f.original.taxAllocations[1],{amountMinor:-300,grossMinor:-300,taxMinor:-50});
  f.original.TotalAmt=9;f.original.TxnTaxDetail.TotalTax=1.5;f.original.TxnTaxDetail.TaxLine[0].Amount=1.5;
  f.lineAllocations[1].bookingId='booking-0';f.selected[0].amountMinor=900;f.invoice=structuredClone(f.original);
  const plan=buildFunnelQuickBooksCreditLines(f);
  assert.deepEqual(plan.payload.Line.map(line=>line.Amount),[12,-3]);
  assert.equal(plan.payload.TxnTaxDetail.TotalTax,1.5);assert.equal(plan.amountMinor,900);
});
test('repeated penny credits return exactly the issued tax without touching other bookings',()=>{
  const f=fixture();f.selected[0].amountMinor=1;
  let gross=0,tax=0;
  for(let prior=0;prior<1200;prior++){
    f.priorAmounts['booking:booking-0']=prior;
    const plan=buildFunnelQuickBooksCreditLines(f);
    gross+=plan.amountMinor;tax+=plan.taxMinor;
  }
  assert.equal(gross,1200);assert.equal(tax,200);
});
