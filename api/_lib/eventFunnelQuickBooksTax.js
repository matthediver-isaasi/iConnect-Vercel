const fail=()=>{throw Object.assign(new Error('Issued QuickBooks tax differs from original instructions'),{code:'FUNNEL_QBO_TAX_EVIDENCE'});};
const integer=value=>{if(!Number.isSafeInteger(value))fail();return value;};
const money=value=>{
  if(value==null||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))fail();
  return integer(Math.round(Number(value)*100));
};

/** Assign only the provider's rounding difference, never a new tax rate.
 * The original line order resolves penny ties; positive purchase lines precede
 * negative funding lines. Persist this once with the issued invoice.
 */
export function allocateFunnelQuickBooksTax({invoice,hints}) {
  if(!Array.isArray(hints)||!hints.length||!Array.isArray(invoice?.Line))fail();
  const lines=invoice.Line.filter(line=>line.DetailType==='SalesItemLineDetail');
  if(lines.length!==hints.length)fail();
  const allocated=hints.map((hint,index)=>{
    if(hint.index!==index||money(lines[index].Amount)!==integer(hint.amountMinor)
      ||lines[index].SalesItemLineDetail?.TaxCodeRef?.value!==hint.taxCodeId)fail();
    const gross=integer(hint.grossMinor),tax=integer(hint.taxMinor);
    if((gross>=0&&(tax<0||tax>gross))||(gross<0&&(tax>0||tax<gross)))fail();
    return {...hint};
  });
  if(allocated.reduce((sum,line)=>sum+line.grossMinor,0)!==money(invoice.TotalAmt))fail();
  const actual=new Map();
  for(const line of invoice.TxnTaxDetail?.TaxLine||[]){
    const id=line.TaxLineDetail?.TaxRateRef?.value;
    if(!id||actual.has(id))fail();
    actual.set(id,money(line.Amount));
  }
  const total=money(invoice.TxnTaxDetail?.TotalTax);
  if([...actual.values()].reduce((sum,value)=>sum+value,0)!==total)fail();
  const groups=new Map();
  for(const hint of allocated){
    const id=hint.taxRateId||null;
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push(hint);
  }
  for(const [id,group] of groups){
    if(!id&&group.some(line=>line.taxMinor!==0))fail();
    if(id&&!actual.has(id))fail();
    let delta=(id?actual.get(id):0)-group.reduce((sum,line)=>sum+line.taxMinor,0);
    if(Math.abs(delta)>group.length)fail();
    const ordered=[...group].sort((a,b)=>(b.grossMinor>0)-(a.grossMinor>0)||a.index-b.index);
    for(const line of ordered){
      if(!delta)break;
      const direction=Math.sign(delta),next=line.taxMinor+direction;
      if(next<Math.min(0,line.grossMinor)||next>Math.max(0,line.grossMinor))continue;
      line.taxMinor=next;delta-=direction;
    }
    if(delta)fail();
  }
  if([...actual].some(([id,amount])=>!groups.has(id)&&amount!==0)
    ||allocated.reduce((sum,line)=>sum+line.taxMinor,0)!==total)fail();
  return allocated;
}

export function captureFunnelQuickBooksInvoice(invoice,expected) {
  const hints=expected?.funnelTaxLines;
  if(!Array.isArray(hints)||!invoice.Id||!invoice.CustomerRef?.value
    ||invoice.CustomerRef.value!==expected.contactId||invoice.CurrencyRef?.value!==expected.currency
    ||money(invoice.TotalAmt)!==expected.totalMinor
    ||!['TaxInclusive','TaxExcluded'].includes(invoice.GlobalTaxCalculation))fail();
  const allocated=allocateFunnelQuickBooksTax({invoice,hints});
  const lines=invoice.Line.filter(line=>line.DetailType==='SalesItemLineDetail');
  const ids=new Set();
  for(const line of lines){
    if(!line.Id||ids.has(String(line.Id))||!line.SalesItemLineDetail?.ItemRef?.value)fail();
    ids.add(String(line.Id));
  }
  return {Id:invoice.Id,CustomerRef:{value:invoice.CustomerRef.value},CurrencyRef:{value:invoice.CurrencyRef.value},
    GlobalTaxCalculation:invoice.GlobalTaxCalculation,TotalAmt:invoice.TotalAmt,
    TxnTaxDetail:structuredClone(invoice.TxnTaxDetail),taxAllocations:allocated,
    Line:lines.map(line=>({Id:line.Id,Description:line.Description,Amount:line.Amount,DetailType:line.DetailType,
      SalesItemLineDetail:structuredClone(line.SalesItemLineDetail)}))};
}
