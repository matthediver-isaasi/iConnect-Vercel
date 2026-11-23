import {getValidQuickBooksAccessToken} from './quickbooks.js';
import {getIntuitEndpoints} from './quickbooksCredentials.js';
import {accountingOperationIdentity} from './accountingOperationIdentity.js';
import {buildFunnelQuickBooksCreditLines} from './eventFunnelQuickBooksCreditLines.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_CREDIT_REVIEW'});};
const minor=value=>{
  if(value==null||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))fail('Credit amount unavailable');
  const result=Math.round(Number(value)*100);if(!Number.isSafeInteger(result))fail('Credit amount invalid');return result;
};
const signature=line=>JSON.stringify([line.Description,minor(line.Amount),line.SalesItemLineDetail?.ItemRef?.value,
  line.SalesItemLineDetail?.TaxCodeRef?.value,line.SalesItemLineDetail?.Qty,line.SalesItemLineDetail?.UnitPrice,
  line.SalesItemLineDetail?.ClassRef?.value||null]);

/** No provider mutation is retried after an uncertain response. Discovery and
 * allocation are customer-bounded; an unrelated payment cannot consume this
 * credit or be used as proof that the intended invoice was credited.
 */
export async function executeFunnelQuickBooksCredit({job,store,deadlineAt=Date.now()+35000,
  loadToken=getValidQuickBooksAccessToken,fetcher=fetch}) {
  if(!job?.id||!job.tenant_id||job.provider!=='quickbooks'||!job.company_id
    ||!['production','sandbox'].includes(job.environment)||!job.original_native_invoice
    ||job.invoice_id!==job.original_native_invoice.Id||!Array.isArray(job.selected)
    ||!Array.isArray(job.known_credit_ids)||!job.prior_amounts||typeof job.prior_amounts!=='object'||Array.isArray(job.prior_amounts)
    ||!['pending','writing','needs_review','complete'].includes(job.status))fail('Original credit authority missing');
  const amount=job.selected.reduce((sum,line)=>sum+line.amountMinor,0);
  if(!Number.isSafeInteger(amount)||amount<=0)fail('Original credit amount missing');
  if(job.status==='complete'){
    if(job.receipt?.provider!=='quickbooks'||job.receipt.invoiceId!==job.invoice_id||job.receipt.amountMinor!==amount
      ||job.receipt.currency!==job.original_native_invoice.CurrencyRef?.value
      ||!job.receipt.creditNoteId||(job.receipt.allocationRequired&&!job.receipt.allocated))fail('Completed credit evidence missing');
    return {status:'complete',receipt:job.receipt};
  }
  if(['prepare','begin','beginAllocation','complete'].some(name=>typeof store?.[name]!=='function'))
    fail('Durable credit recovery unavailable');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(job.credit_date||'')
    ||new Date(`${job.credit_date}T00:00:00Z`).toISOString().slice(0,10)!==job.credit_date)fail('Original credit date missing');
  const token=await loadToken(job.tenant_id);
  if(!token?.accessToken||String(token.realmId)!==job.company_id||token.environment!==job.environment)
    fail('Original QuickBooks company changed');
  const base=`${getIntuitEndpoints(job.environment).apiBaseUrl}/v3/company/${encodeURIComponent(job.company_id)}`;
  const marker=`event-funnel-credit:${job.id}`;
  async function request(path,body=null,key=null){
    const remaining=deadlineAt-Date.now();if(remaining<500)fail('Accounting budget exhausted');
    const response=await fetcher(`${base}/${path}${path.includes('?')?'&':'?'}minorversion=70${key?`&requestid=${encodeURIComponent(key)}`:''}`,{
      method:body?'POST':'GET',headers:{Authorization:`Bearer ${token.accessToken}`,Accept:'application/json','Content-Type':'application/json'},
      signal:AbortSignal.timeout(Math.min(12000,remaining)),...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok)fail('QuickBooks response requires reconciliation');
    const data=await response.json();if(!data||data.Fault)fail('QuickBooks rejected the accounting operation');
    return data;
  }
  const invoice=(await request(`invoice/${encodeURIComponent(job.invoice_id)}`)).Invoice;
  const plan=buildFunnelQuickBooksCreditLines({invoice,original:job.original_native_invoice,
    lineAllocations:job.line_allocations,selected:job.selected,priorAmounts:job.prior_amounts});
  const due=minor(invoice.Balance);if(due<0)fail('Invoice balance changed');
  if(await store.prepare(job.id,plan)!==true)fail('Credit instructions changed');
  const customer=job.original_native_invoice.CustomerRef.value;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(customer))fail('Original customer identity invalid');
  async function list(entity){
    const rows=[],seen=new Set();
    for(let page=0;page<100;page++){
      const query=`SELECT * FROM ${entity} WHERE CustomerRef = '${customer}' STARTPOSITION ${page*100+1} MAXRESULTS 100`;
      const result=(await request(`query?query=${encodeURIComponent(query)}`)).QueryResponse;
      if(!result||Object.keys(result).some(key=>![entity,'startPosition','maxResults','totalCount'].includes(key)))
        fail('Accounting discovery incomplete');
      const batch=result[entity]??[];
      if(!Array.isArray(batch)||(!batch.length&&Number(result.maxResults||0)>0))fail('Accounting discovery incomplete');
      if(!batch.length)return rows;
      for(const row of batch){
        if(!row.Id||seen.has(row.Id)||row.CustomerRef?.value!==customer)fail('Accounting discovery scope changed');
        seen.add(row.Id);rows.push(row);
      }
    }
    fail('Accounting discovery limit exceeded');
  }
  const notes=await list('CreditMemo'),payments=await list('Payment');
  const matches=notes.filter(note=>note.PrivateNote===marker);
  if(matches.length>1)fail('Duplicate credit identities');
  let note=matches[0]||null;
  for(const payment of payments)for(const line of payment.Line||[]){
    const links=line.LinkedTxn||[];
    if(links.some(link=>link.TxnType==='Invoice'&&link.TxnId===job.invoice_id)
      &&links.some(link=>link.TxnType==='CreditMemo'&&link.TxnId!==note?.Id&&!job.known_credit_ids.includes(link.TxnId)))
      fail('Untracked invoice credit requires reconciliation');
  }
  if(!note){
    if(await store.begin(job.id)!==true)fail('Credit submission requires reconciliation');
    const created=(await request('creditmemo',{...plan.payload,PrivateNote:marker,TxnDate:job.credit_date},
      accountingOperationIdentity(marker,'fcr',50))).CreditMemo;
    if(!created?.Id)fail('Credit creation outcome unknown');
    note=(await request(`creditmemo/${encodeURIComponent(created.Id)}`)).CreditMemo;
  } else {
    note=(await request(`creditmemo/${encodeURIComponent(note.Id)}`)).CreditMemo;
  }
  const actualLines=note?.Line?.filter(line=>line.DetailType==='SalesItemLineDetail');
  const taxLines=value=>JSON.stringify((value?.TaxLine||[]).map(line=>[
    line.TaxLineDetail?.TaxRateRef?.value,minor(line.Amount)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  if(!note?.Id||note.Voided||note.PrivateNote!==marker||note.TxnDate!==job.credit_date||note.CustomerRef?.value!==customer
    ||note.CurrencyRef?.value!==plan.CurrencyCode||note.GlobalTaxCalculation!==plan.payload.GlobalTaxCalculation
    ||minor(note.TotalAmt)!==plan.amountMinor||minor(note.TxnTaxDetail?.TotalTax)!==plan.taxMinor
    ||taxLines(note.TxnTaxDetail)!==taxLines(plan.payload.TxnTaxDetail)
    ||!Array.isArray(actualLines)||JSON.stringify(actualLines.map(signature))!==JSON.stringify(plan.payload.Line.map(signature)))
    fail('Credit receipt differs from approved lines');
  const remaining=minor(note.RemainingCredit);
  if(remaining<0||remaining>amount)fail('Credit balance invalid');
  let allocatedMinor=0;
  const observedPayments=note===matches[0]?payments:await list('Payment');
  for(const payment of observedPayments)for(const line of payment.Line||[]){
    const links=line.LinkedTxn||[];
    if(!links.some(link=>link.TxnType==='CreditMemo'&&link.TxnId===note.Id))continue;
    if(links.length!==2||!links.some(link=>link.TxnType==='Invoice'&&link.TxnId===job.invoice_id)
      ||minor(payment.TotalAmt)!==0||minor(payment.UnappliedAmt)!==0||payment.CurrencyRef?.value!==plan.CurrencyCode)
      fail('Credit was applied outside its original invoice');
    const value=minor(line.Amount);if(value<=0)fail('Credit application amount invalid');allocatedMinor+=value;
  }
  if(allocatedMinor!==amount-remaining)fail('Credit application evidence incomplete');
  if(job.allocation_amount_minor!=null&&allocatedMinor>0&&allocatedMinor!==Number(job.allocation_amount_minor))
    fail('Credit application differs from its original intent');
  if(allocatedMinor===0&&due>0){
    const applying=Math.min(due,remaining);
    if(await store.beginAllocation(job.id,applying)!==true)fail('Credit allocation requires reconciliation');
    const payment={CustomerRef:{value:customer},CurrencyRef:{value:plan.CurrencyCode},TotalAmt:0,
      PrivateNote:`${marker}:allocation`,TxnDate:job.credit_date,
      Line:[{Amount:applying/100,LinkedTxn:[{TxnId:job.invoice_id,TxnType:'Invoice'},{TxnId:note.Id,TxnType:'CreditMemo'}]}]};
    const created=(await request('payment',payment,accountingOperationIdentity(marker,'fca',50))).Payment;
    if(!created?.Id)fail('Credit allocation outcome unknown');
    const proof=(await request(`payment/${encodeURIComponent(created.Id)}`)).Payment;
    if(proof?.CustomerRef?.value!==customer||proof.CurrencyRef?.value!==plan.CurrencyCode||minor(proof.TotalAmt)!==0
      ||minor(proof.UnappliedAmt)!==0||proof.PrivateNote!==payment.PrivateNote
      ||proof.Line?.length!==1||minor(proof.Line[0].Amount)!==applying
      ||JSON.stringify(proof.Line[0].LinkedTxn)!==JSON.stringify(payment.Line[0].LinkedTxn))
      fail('Credit allocation receipt changed');
    allocatedMinor=applying;
  }
  const receipt={provider:'quickbooks',creditNoteId:note.Id,invoiceId:job.invoice_id,amountMinor:amount,
    taxMinor:plan.taxMinor,currency:plan.CurrencyCode,allocated:allocatedMinor>0,
    allocationRequired:job.receipt?.allocationRequired??(due>0)};
  if(await store.complete(job.id,receipt)!==true)fail('Credit receipt persistence requires recovery');
  return {status:receipt.allocationRequired&&!receipt.allocated?'needs_review':'complete',receipt};
}
