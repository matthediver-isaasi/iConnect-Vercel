import {buildFunnelCreditLines} from './eventFunnelCreditLines.js';
const fail=()=>{throw Object.assign(new Error('Original QuickBooks credit evidence changed'),{code:'FUNNEL_QBO_CREDIT_EVIDENCE'});};
const money=value=>{
  if(value==null||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))fail();
  const n=Math.round(Number(value)*100);if(!Number.isSafeInteger(n))fail();return n;
};
const taxSignature=invoice=>JSON.stringify((invoice.TxnTaxDetail?.TaxLine||[]).map(line=>[
  line.TaxLineDetail?.TaxRateRef?.value,money(line.Amount),
]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));

export function canonicalFunnelQuickBooksInvoice(invoice,original=invoice) {
  const lines=invoice?.Line?.filter(line=>line.DetailType==='SalesItemLineDetail');
  if(!Array.isArray(lines)||!Array.isArray(original?.taxAllocations)||lines.length!==original.taxAllocations.length
    ||!['TaxInclusive','TaxExcluded'].includes(original.GlobalTaxCalculation)
    ||invoice.Id!==original.Id||invoice.CustomerRef?.value!==original.CustomerRef?.value
    ||invoice.CurrencyRef?.value!==original.CurrencyRef?.value||invoice.GlobalTaxCalculation!==original.GlobalTaxCalculation
    ||money(invoice.TotalAmt)!==money(original.TotalAmt)||money(invoice.TxnTaxDetail?.TotalTax)!==money(original.TxnTaxDetail?.TotalTax)
    ||taxSignature(invoice)!==taxSignature(original))fail();
  const ids=new Set();
  const result=original.Line.map((expected,index)=>{
    const hint=original.taxAllocations[index],matches=lines.filter(line=>line.Id===expected.Id);
    if(!expected.Id||ids.has(expected.Id)||matches.length!==1||hint?.index!==index)fail();
    ids.add(expected.Id);const actual=matches[0],detail=actual.SalesItemLineDetail,prior=expected.SalesItemLineDetail;
    if(!detail||!prior||money(actual.Amount)!==hint.amountMinor||money(actual.Amount)!==money(expected.Amount)
      ||actual.Description!==expected.Description||detail.ItemRef?.value!==prior.ItemRef?.value
      ||detail.TaxCodeRef?.value!==prior.TaxCodeRef?.value||detail.Qty!==prior.Qty||detail.UnitPrice!==prior.UnitPrice
      ||detail.ClassRef?.value!==prior.ClassRef?.value||!Number.isSafeInteger(hint.grossMinor)||!Number.isSafeInteger(hint.taxMinor))fail();
    return {LineItemID:actual.Id,Description:actual.Description,Quantity:1,UnitAmount:hint.grossMinor/100,
      LineAmount:hint.grossMinor/100,TaxAmount:hint.taxMinor/100,TaxType:detail.TaxCodeRef.value,AccountCode:detail.ItemRef.value};
  });
  return {InvoiceID:invoice.Id,Contact:{ContactID:invoice.CustomerRef.value},CurrencyCode:invoice.CurrencyRef.value,
    LineAmountTypes:'Inclusive',Total:invoice.TotalAmt,TotalTax:invoice.TxnTaxDetail.TotalTax,LineItems:result};
}

export function buildFunnelQuickBooksCreditLines({invoice,original,lineAllocations,selected,priorAmounts}) {
  if(!priorAmounts||typeof priorAmounts!=='object'||Array.isArray(priorAmounts)||!Array.isArray(lineAllocations))fail();
  const expected=canonicalFunnelQuickBooksInvoice(original);
  const current=canonicalFunnelQuickBooksInvoice(invoice,original);
  const links=lineAllocations.map(link=>({...link,amountMinor:original.taxAllocations[link.index]?.grossMinor}));
  const plan=buildFunnelCreditLines({invoice:current,expectedInvoice:expected,lineAllocations:links,selected,priorAmounts});
  const taxes=new Map();
  const Line=plan.allocations.map((allocation,index)=>{
    const position=original.Line.findIndex(line=>line.Id===allocation.invoiceLineId);
    if(position<0)fail();
    const native=original.Line[position],hint=original.taxAllocations[position],credit=plan.LineItems[index];
    if(hint.taxRateId){
      if(!Number.isFinite(hint.percentage)||hint.percentage<0)fail();
      const part=taxes.get(hint.taxRateId)||{amount:0,net:0,percentage:hint.percentage};
      if(part.percentage!==hint.percentage)fail();
      part.amount+=allocation.taxMinor;part.net+=allocation.amountMinor-allocation.taxMinor;
      taxes.set(hint.taxRateId,part);
    } else if(allocation.taxMinor!==0)fail();
    const amount=allocation.amountMinor-(original.GlobalTaxCalculation==='TaxExcluded'?allocation.taxMinor:0);
    return {Description:credit.Description,DetailType:'SalesItemLineDetail',Amount:amount/100,
      SalesItemLineDetail:{ItemRef:{value:native.SalesItemLineDetail.ItemRef.value},
        TaxCodeRef:{value:native.SalesItemLineDetail.TaxCodeRef.value},Qty:1,UnitPrice:amount/100,
        ...(native.SalesItemLineDetail.ClassRef?{ClassRef:structuredClone(native.SalesItemLineDetail.ClassRef)}:{})}};
  });
  return {...plan,payload:{CustomerRef:structuredClone(original.CustomerRef),CurrencyRef:structuredClone(original.CurrencyRef),
    GlobalTaxCalculation:original.GlobalTaxCalculation,Line,TxnTaxDetail:{TotalTax:plan.taxMinor/100,
      TaxLine:[...taxes].map(([id,tax])=>({Amount:tax.amount/100,DetailType:'TaxLineDetail',
        TaxLineDetail:{TaxRateRef:{value:id},PercentBased:true,TaxPercent:tax.percentage,NetAmountTaxable:tax.net/100}}))}}};
}
