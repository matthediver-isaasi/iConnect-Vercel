import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelCreditLines} from './eventFunnelCreditLines.js';
function fixture(){
  const values=[['entry',25,4.17,'one'],['voucher',-5,-.83,'one'],['other event',30,5,'two']];
  const invoice={LineAmountTypes:'Inclusive',CurrencyCode:'GBP',Total:50,TotalTax:8.34,
    LineItems:values.map(([Description,LineAmount,TaxAmount],i)=>({LineItemID:`line${i}`,Description,LineAmount,TaxAmount,AccountCode:'200',TaxType:'OUTPUT2'}))};
  const expectedInvoice={CurrencyCode:'GBP',LineItems:invoice.LineItems.map(line=>({...line,Quantity:1,UnitAmount:line.LineAmount}))};
  const lineAllocations=values.map((v,index)=>({index,source:'booking',bookingId:v[3],amountMinor:Math.round(v[1]*100)}));
  return {invoice,expectedInvoice,lineAllocations,selected:[{source:'booking',id:'one',amountMinor:2000}]};
}
test('shared invoice credit touches only purchased lines of the selected booking',()=>{
  const result=buildFunnelCreditLines(fixture());
  assert.equal(result.amountMinor,2000);assert.equal(result.taxMinor,334);
  assert.deepEqual(result.LineItems.map(l=>l.UnitAmount),[25,-5]);
  assert.ok(result.allocations.every(a=>a.bookingId==='one'));
});
test('repeated penny credits preserve signed funding and every original tax penny',()=>{
  const f=fixture();f.selected[0].amountMinor=1;
  let amount=0,tax=0;
  for(let before=0;before<2000;before++){
    const result=buildFunnelCreditLines({...f,priorAmounts:{'booking:one':before}});
    amount+=result.amountMinor;tax+=result.taxMinor;
  }
  assert.equal(amount,2000);assert.equal(tax,334);
});
test('changed issued lines, unlinked bookings and excessive credits fail closed',()=>{
  const f=fixture();f.invoice.LineItems[0].AccountCode='other';
  assert.throws(()=>buildFunnelCreditLines(f),/changed/);
  assert.throws(()=>buildFunnelCreditLines({...fixture(),selected:[{source:'booking',id:'unknown',amountMinor:1}]}));
  assert.throws(()=>buildFunnelCreditLines({...fixture(),priorAmounts:{'booking:one':1}}),/exceeds/);
  const changedTax=fixture();changedTax.invoice.LineItems[0].TaxAmount=4;
  assert.throws(()=>buildFunnelCreditLines(changedTax),/changed/);
  const unresolved=fixture();delete unresolved.expectedInvoice.LineItems[0].TaxAmount;
  assert.throws(()=>buildFunnelCreditLines(unresolved),/resolved invoice tax/);
});
