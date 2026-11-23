const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_CREDIT_PLAN_UNAVAILABLE'});};
const key=(source,id)=>`${source}:${id}`;
const integer=value=>{
  if(!Number.isSafeInteger(value)||value<0)fail('Invalid original credit amount');
  return value;
};

/** Plans from private recovery evidence only. The persistence boundary must
 * recheck this input under the order lock before inserting any jobs; this
 * function is not permission to publish caller-supplied credit instructions.
 */
export function planFunnelInvoiceCredits({tenantId,orderId,reversal,invoiceWork,invoiceLinks,creditHistory}) {
  if(!tenantId||!orderId||reversal?.tenant_id!==tenantId||reversal.order_id!==orderId
    ||!reversal.id||!reversal.cancelled_at||reversal.state==='released'
    ||!Array.isArray(reversal.allocations)||!Array.isArray(invoiceWork)
    ||!Array.isArray(invoiceLinks)||!Array.isArray(creditHistory))fail('Complete private cancellation evidence is required');
  const jobs=new Map(),seen=new Set();
  for(const item of reversal.allocations){
    const amount=integer(item.invoiceMinor),identity=key(item.source,item.id);
    if(seen.has(identity))fail('Duplicate cancellation allocation');seen.add(identity);
    if(!amount)continue;
    const links=invoiceLinks.filter(link=>link.tenant_id===tenantId&&link.booking_source===item.source&&link.booking_id===item.id);
    if(links.length!==1)fail('Original invoice linkage is not ready');
    const matches=invoiceWork.filter(work=>work.id===links[0].invoice_work_id);
    const work=matches[0];
    if(matches.length!==1||work.tenant_id!==tenantId||work.order_id!==orderId||work.status!=='complete'
      ||work.provider!=='xero'||!work.issued_evidence||!work.xero_tenant_id
      ||work.issued_evidence.InvoiceID!==work.invoice_id||!work.issued_evidence.Contact?.ContactID
      ||!Array.isArray(work.snapshot?.eventFunnel?.lineAllocations))
      fail('Original accounting evidence is not ready');
    const earlier=creditHistory.filter(job=>job.invoice_work_id===work.id);
    if(earlier.some(job=>job.tenant_id!==tenantId||job.order_id!==orderId))
      fail('Credit history scope changed');
    const own=earlier.filter(job=>job.reversal_id===reversal.id);
    if(own.length>1)fail('Duplicate credit job identity');
    if(earlier.some(job=>job.reversal_id!==reversal.id&&job.status!=='complete'))
      fail('An earlier invoice credit must be reconciled first');
    let plan=jobs.get(work.id);
    if(!plan){
      const prior={},known=[];
      for(const job of earlier.filter(job=>job.reversal_id!==reversal.id)){
        if(!job.receipt?.creditNoteId||job.receipt.invoiceId!==work.invoice_id
          ||job.receipt.currency!==work.issued_evidence.CurrencyCode||!Array.isArray(job.selected))
          fail('Completed credit evidence is missing');
        let total=0;
        for(const selected of job.selected){
          const selectedKey=key(selected.source,selected.id),value=integer(selected.amountMinor);
          total=integer(total+value);prior[selectedKey]=integer((prior[selectedKey]||0)+value);
        }
        if(total!==job.receipt.amountMinor||known.includes(job.receipt.creditNoteId))
          fail('Completed credit totals disagree');
        known.push(job.receipt.creditNoteId);
      }
      plan={tenant_id:tenantId,order_id:orderId,reversal_id:reversal.id,invoice_work_id:work.id,
        invoice_id:work.invoice_id,company_id:work.xero_tenant_id,original_invoice:structuredClone(work.issued_evidence),
        line_allocations:structuredClone(work.snapshot.eventFunnel.lineAllocations),prior_amounts:prior,
        known_credit_ids:known,selected:[],existing_job_id:own[0]?.id||null};
      jobs.set(work.id,plan);
    }
    plan.selected.push({source:item.source,id:item.id,amountMinor:amount});
  }
  return [...jobs.values()].sort((a,b)=>a.invoice_work_id.localeCompare(b.invoice_work_id))
    .map(plan=>({...plan,selected:plan.selected.sort((a,b)=>key(a.source,a.id).localeCompare(key(b.source,b.id)))}));
}
