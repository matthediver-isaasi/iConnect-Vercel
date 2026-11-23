import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateFunnelQuickBooksTax,captureFunnelQuickBooksInvoice} from './eventFunnelQuickBooksTax.js';
function fixture(gross,taxes,totalTax){
  return {hints:gross.map((amount,index)=>({index,amountMinor:amount,grossMinor:amount,taxMinor:taxes[index],taxCodeId:'code',taxRateId:'rate'})),
    invoice:{TotalAmt:gross.reduce((a,b)=>a+b,0)/100,
      Line:gross.map(amount=>({DetailType:'SalesItemLineDetail',Amount:amount/100,SalesItemLineDetail:{TaxCodeRef:{value:'code'}}})),
      TxnTaxDetail:{TotalTax:totalTax/100,TaxLine:[{Amount:totalTax/100,TaxLineDetail:{TaxRateRef:{value:'rate'}}}]}}};
}
test('issued aggregate rounding is preserved across individual registration lines',()=>{
  const f=fixture([3,3],[1,1],1),copy=structuredClone(f);
  assert.deepEqual(allocateFunnelQuickBooksTax(f).map(line=>line.taxMinor),[0,1]);
  assert.deepEqual(f,copy);
});
test('signed funding lines retain their tax while purchase pennies reconcile',()=>{
  assert.deepEqual(allocateFunnelQuickBooksTax(fixture([1200,-300],[200,-50],150)).map(l=>l.taxMinor),[200,-50]);
});
test('changed gross, missing rate evidence and non-rounding tax changes fail closed',()=>{
  for(const change of [f=>{f.invoice.TotalAmt=99;},f=>{f.invoice.TxnTaxDetail.TaxLine=[];},
    f=>{f.invoice.TxnTaxDetail.TotalTax=3;f.invoice.TxnTaxDetail.TaxLine[0].Amount=3;}]){
    const f=fixture([1200],[200],200);change(f);assert.throws(()=>allocateFunnelQuickBooksTax(f));
  }
});
test('issued invoice capture preserves identity and tax but not mutable balances',()=>{
  const f=fixture([1200],[200],200);
  Object.assign(f.invoice,{Id:'invoice',CustomerRef:{value:'original',name:'Private name'},CurrencyRef:{value:'GBP'},
    GlobalTaxCalculation:'TaxInclusive',Balance:0});
  f.invoice.Line[0].Id='line';
  f.invoice.Line[0].SalesItemLineDetail.ItemRef={value:'item'};
  const result=captureFunnelQuickBooksInvoice(f.invoice,{contactId:'original',currency:'GBP',totalMinor:1200,funnelTaxLines:f.hints});
  assert.deepEqual(result.CustomerRef,{value:'original'});assert.equal(result.Balance,undefined);
  assert.equal(result.taxAllocations[0].taxMinor,200);
  assert.throws(()=>captureFunnelQuickBooksInvoice(f.invoice,{contactId:'other',currency:'GBP',totalMinor:1200,funnelTaxLines:f.hints}));
});
