const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_CREDIT_EVIDENCE_INVALID'});};
function minor(value){
  if(value===null||value===undefined||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))fail('Missing invoice amount');
  const n=Math.round(Number(value)*100);if(!Number.isSafeInteger(n))fail('Invalid invoice amount');return n;
}
function integer(value){if(!Number.isSafeInteger(value)||value<0)fail('Invalid credit allocation');return value;}
const key=(source,id)=>`${source}:${id}`;
function taxShare(tax,gross,share){
  if(!gross)return 0;
  const n=BigInt(Math.abs(tax))*BigInt(Math.abs(share)),d=BigInt(Math.abs(gross));
  return Number((n+d/2n)/d)*Math.sign(tax);
}

/** Use the issued invoice's tax/account evidence, never today's settings.
 * Per-registration lines were frozen when the funnel invoice was prepared.
 * priorAmounts includes only finalized credits using this same allocation
 * version; an uncertain predecessor must be reconciled before calling.
 */
export function buildFunnelCreditLines({invoice,expectedInvoice,lineAllocations,selected,priorAmounts={}}) {
  if(invoice?.LineAmountTypes!=='Inclusive'||invoice.CurrencyCode!==expectedInvoice?.CurrencyCode
    ||!Array.isArray(invoice.LineItems)||!Array.isArray(expectedInvoice.LineItems)||!Array.isArray(lineAllocations)
    ||lineAllocations.length!==expectedInvoice.LineItems.length||invoice.LineItems.length!==lineAllocations.length
    ||!Array.isArray(selected))fail('Original invoice line authority is unavailable');
  const groups=new Map(),used=new Set(),indices=new Set();
  const tracking=values=>JSON.stringify((values||[]).map(value=>[
    String(value.Name||'').trim(),String(value.Option||'').trim(),
  ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  let total=0,tax=0;
  for(const link of lineAllocations){
    if(!Number.isInteger(link.index)||indices.has(link.index)||!link.bookingId
      ||!['booking','complex_event_booking'].includes(link.source))fail('Invalid invoice linkage');
    indices.add(link.index);
    const expected=expectedInvoice.LineItems[link.index];
    if(!expected||!expected.TaxType||expected.TaxAmount===undefined||expected.TaxAmount===null)
      fail('Original resolved invoice tax is missing');
    const matches=invoice.LineItems.map((line,index)=>({line,index})).filter(({line})=>
      (!expected.LineItemID||line.LineItemID===expected.LineItemID)
      &&line.Description===expected.Description&&minor(line.LineAmount)===minor(expected.Quantity*expected.UnitAmount)
      &&line.AccountCode===expected.AccountCode&&line.TaxType===expected.TaxType
      &&minor(line.TaxAmount)===minor(expected.TaxAmount)&&tracking(line.Tracking)===tracking(expected.Tracking));
    if(matches.length!==1||used.has(matches[0].index))fail('Issued invoice line is ambiguous or changed');
    const {line,index}=matches[0];used.add(index);
    const gross=minor(line.LineAmount),lineTax=minor(line.TaxAmount);
    if(gross!==link.amountMinor||!line.LineItemID||!line.TaxType||!line.AccountCode
      ||Math.abs(lineTax)>Math.abs(gross)||(lineTax!==0&&Math.sign(gross)!==Math.sign(lineTax)))
      fail('Issued invoice tax or amount is inconsistent');
    const identity=key(link.source,link.bookingId);
    const group=groups.get(identity)||[];group.push({line,gross,tax:lineTax});groups.set(identity,group);
    total+=gross;tax+=lineTax;
    if(!Number.isSafeInteger(total)||!Number.isSafeInteger(tax))fail('Invoice totals overflow');
  }
  if(total!==minor(invoice.Total)||tax!==minor(invoice.TotalTax))fail('Issued invoice does not reconcile');
  const seen=new Set(),lines=[],evidence=[];
  let amountMinor=0,taxMinor=0;
  for(const selection of selected){
    const identity=key(selection.source,selection.id),group=groups.get(identity);
    if(seen.has(identity)||!group)fail('Credit registration is missing or repeated');seen.add(identity);
    const net=group.reduce((sum,line)=>sum+line.gross,0),requested=integer(selection.amountMinor);
    const before=integer(priorAmounts[identity]??0),after=integer(before+requested);
    if(after>net||group.filter(line=>line.gross>0).length!==1)fail('Credit exceeds the original registration');
    if(!requested)continue;
    // One positive purchased line and its original negative funding lines.
    // Truncating negative shares keeps cumulative allocations monotonic; the
    // positive line receives the exact remainder, including the final penny.
    const shares=cumulative=>{
      const values=group.map(line=>line.gross<0?-Number(BigInt(-line.gross)*BigInt(cumulative)/BigInt(net)):0);
      values[group.findIndex(line=>line.gross>0)]=cumulative-values.reduce((a,b)=>a+b,0);
      return values;
    };
    const previous=shares(before),next=shares(after);
    group.forEach((part,index)=>{
      const gross=next[index]-previous[index];
      if(!gross)return;
      const tax=taxShare(part.tax,part.gross,next[index])-taxShare(part.tax,part.gross,previous[index]);
      if(Math.abs(tax)>Math.abs(gross))fail('Credit tax does not reconcile');
      lines.push({Description:part.line.Description,Quantity:1,UnitAmount:gross/100,TaxAmount:tax/100,
        AccountCode:part.line.AccountCode,TaxType:part.line.TaxType,
        ...(part.line.Tracking?.length?{Tracking:structuredClone(part.line.Tracking)}:{})});
      evidence.push({source:selection.source,bookingId:selection.id,invoiceLineId:part.line.LineItemID,amountMinor:gross,taxMinor:tax});
      amountMinor+=gross;taxMinor+=tax;
    });
  }
  if(amountMinor!==selected.reduce((sum,s)=>sum+s.amountMinor,0))fail('Credit total does not balance');
  return {version:1,LineAmountTypes:'Inclusive',CurrencyCode:invoice.CurrencyCode,LineItems:lines,amountMinor,taxMinor,allocations:evidence};
}
