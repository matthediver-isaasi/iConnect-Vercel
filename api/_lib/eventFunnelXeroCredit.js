import {createXeroCreditNote,getValidXeroAccessToken} from './xero.js';
import {xeroRateLimitedFetch} from './xeroRateLimit.js';
import {buildFunnelCreditLines} from './eventFunnelCreditLines.js';

const fail=reason=>{throw Object.assign(new Error(reason),{code:'FUNNEL_CREDIT_REVIEW'});};
const minor=n=>{if(n===null||n===undefined||n===''||!Number.isFinite(Number(n)))fail('Invalid credit amount');
  const value=Math.round(Number(n)*100);if(!Number.isSafeInteger(value))fail('Invalid credit amount');return value;};
const signature=line=>JSON.stringify([line.Description,line.AccountCode,line.TaxType,minor(line.LineAmount??line.UnitAmount),
  minor(line.TaxAmount),(line.Tracking||[]).map(t=>[String(t.Name||'').trim(),String(t.Option||'').trim()]).sort()]);

/** Original-company, exact-line Xero credit execution. Store methods must be
 * fenced durable operations; a lease alone never permits repeating a POST.
 */
export async function executeFunnelXeroCredit({job,store,deadlineAt=Date.now()+35000,
  loadToken=getValidXeroAccessToken,fetcher=xeroRateLimitedFetch,create=createXeroCreditNote}) {
  if(!job?.id||!job.tenant_id||!job.invoice_id||!job.company_id||!job.original_invoice?.Contact?.ContactID
    ||job.original_invoice.InvoiceID!==job.invoice_id||!Array.isArray(job.selected)||!Array.isArray(job.line_allocations)
    ||!['pending','writing','needs_review','complete'].includes(job.status)
    ||!job.prior_amounts||typeof job.prior_amounts!=='object'||Array.isArray(job.prior_amounts)
    ||!Array.isArray(job.known_credit_ids))
    fail('Original credit authority is missing');
  if(job.status==='complete'){
    if(!job.receipt?.creditNoteId||job.receipt.provider!=='xero'||job.receipt.invoiceId!==job.invoice_id
      ||job.receipt.currency!==job.original_invoice.CurrencyCode
      ||(job.receipt.allocationRequired&&!job.receipt.allocated)
      ||job.receipt.amountMinor!==job.selected.reduce((sum,item)=>sum+item.amountMinor,0))
      fail('Completed credit evidence is missing');
    return {status:'complete',receipt:job.receipt};
  }
  if(['prepare','begin','beginAllocation','complete'].some(method=>typeof store?.[method]!=='function'))
    fail('Durable credit recovery is unavailable');
  const token=await loadToken(job.tenant_id);
  if(token?.tenantId!==job.company_id)fail('Original accounting company changed');
  if(!token.accessToken)fail('Original accounting credentials unavailable');
  const reference=`event-funnel-credit:${job.id}`;
  let expected,verifiedId,verifiedNote,lastInvoice,writeStarted=false,allocationAttempted=false,allocationConfirmed=false;
  const headers={Authorization:`Bearer ${token.accessToken}`,'xero-tenant-id':token.tenantId,Accept:'application/json'};
  async function transport(url,options={}){
    const remaining=deadlineAt-Date.now();
    if(remaining<500)fail('Accounting time budget exhausted');
    const method=options.method||'GET',path=new URL(url).pathname;
    if(method==='POST'&&path.endsWith('/CreditNotes')){
      if(writeStarted||!expected||await store.begin(job.id)!==true)fail('Credit submission requires reconciliation');
      writeStarted=true;
    } else if(!['GET','HEAD'].includes(method)){
      // The ordinary helper also allocates new credit notes. Fence that
      // separate effect before allowing its PUT to reach the provider.
      if(method!=='PUT'||!path.endsWith('/Allocations')||!verifiedId
        ||!path.includes(`/${verifiedId}/`))fail('Unexpected accounting mutation');
      const entries=JSON.parse(options.body)?.Allocations;
      if(entries?.length!==1||entries[0].Invoice?.InvoiceID!==job.invoice_id)fail('Credit allocation scope changed');
      const amount=minor(entries[0].Amount);
      allocationAttempted=true;
      if(amount<=0||amount>expected.amountMinor||await store.beginAllocation(job.id,amount)!==true)
        fail('Credit allocation requires reconciliation');
    }
    const response=await fetcher(url,{...options,signal:AbortSignal.timeout(Math.min(12000,remaining))});
    if(method==='PUT'&&response.ok){
      const observed=(await response.clone().json())?.Allocations;
      const requested=JSON.parse(options.body).Allocations[0];
      if(!Array.isArray(observed)||observed.length!==1||observed[0].Invoice?.InvoiceID!==job.invoice_id
        ||minor(observed[0].Amount)!==minor(requested.Amount))fail('Credit allocation receipt differs from its intent');
      allocationConfirmed=true;
    }
    return response;
  }
  async function calculate(invoice,currentCreditId=null){
    if(invoice.InvoiceID!==job.invoice_id||invoice.Contact?.ContactID!==job.original_invoice.Contact.ContactID)
      fail('Original invoice customer changed');
    if(!['AUTHORISED','PAID'].includes(invoice.Status)||minor(invoice.AmountDue)<0)fail('Invoice balance is unavailable');
    const credited=minor(invoice.AmountCredited??0),notes=invoice.CreditNotes||[];
    if(credited<0||((credited>0||notes.length)&&(!Array.isArray(notes)||!notes.length
      ||notes.some(note=>note.CreditNoteID!==currentCreditId&&!job.known_credit_ids?.includes(note.CreditNoteID))
      ||notes.reduce((sum,note)=>sum+minor(note.AppliedAmount),0)!==credited)))
      fail('Unallocated historical invoice credit requires reconciliation');
    const plan=buildFunnelCreditLines({invoice,expectedInvoice:job.original_invoice,
      lineAllocations:job.line_allocations,selected:job.selected,priorAmounts:job.prior_amounts});
    if(!plan.amountMinor||await store.prepare(job.id,plan)!==true)fail('Credit instructions changed');
    expected=plan;lastInvoice=invoice;return plan;
  }
  async function verify(note,invoice){
    const plan=await calculate(invoice,note.CreditNoteID);
    if(!Array.isArray(note.LineItems)||note.RemainingCredit===undefined){
      const response=await transport(`https://api.xero.com/api.xro/2.0/CreditNotes/${encodeURIComponent(note.CreditNoteID)}`,{headers});
      if(!response.ok)fail('Credit receipt unavailable');
      note=(await response.json())?.CreditNotes?.[0];
    }
    if(!note?.CreditNoteID||note.HasErrors||note.ValidationErrors?.length
      ||note.Type!=='ACCRECCREDIT'||!['AUTHORISED','PAID'].includes(note.Status)
      ||note.Reference!==reference||note.Contact?.ContactID!==job.original_invoice.Contact.ContactID
      ||note.CurrencyCode!==plan.CurrencyCode||minor(note.Total)!==plan.amountMinor||minor(note.TotalTax)!==plan.taxMinor
      ||!Array.isArray(note.LineItems)||note.LineItems.some(line=>line.HasErrors||line.ValidationErrors?.length)
      ||JSON.stringify(note.LineItems.map(signature).sort())!==JSON.stringify(plan.LineItems.map(signature).sort())
      ||note.Allocations?.some(a=>a.Invoice?.InvoiceID!==job.invoice_id))
      fail('Credit receipt differs from the approved lines');
    verifiedId=note.CreditNoteID;verifiedNote=note;
  }
  const amount=job.selected.reduce((sum,item)=>sum+item.amountMinor,0);
  if(!Number.isSafeInteger(amount)||amount<=0)fail('Invalid selected credit amount');
  const result=await create({appTenantId:job.tenant_id,invoiceId:job.invoice_id,creditAmount:amount/100,
    reference,recoveryKey:reference},{fetcher:transport,loadToken:async()=>token,
    buildAmounts:async invoice=>{
      const plan=await calculate(invoice);
      return {LineAmountTypes:plan.LineAmountTypes,CurrencyCode:plan.CurrencyCode,LineItems:plan.LineItems,
        ...(job.credit_date?{Date:job.credit_date}:{})};
    },verifyCredit:verify,validateCredit:(note,amount,currency,tax)=>{
      if(note.HasErrors||note.ValidationErrors?.length||minor(note.Total)!==minor(amount)
        ||minor(note.TotalTax)!==minor(tax)||note.CurrencyCode!==currency)fail('Created credit totals differ from their original allocation');
    }});
  if(!verifiedId||result?.creditNoteId!==verifiedId)fail('Verified credit receipt unavailable');
  let allocated=allocationConfirmed||verifiedNote.Allocations?.some(a=>a.Invoice?.InvoiceID===job.invoice_id&&minor(a.Amount)>0)===true;
  const due=minor(lastInvoice.AmountDue),remaining=minor(verifiedNote.RemainingCredit);
  if(!allocated&&due>0&&!allocationAttempted&&remaining===expected.amountMinor){
    const amount=Math.min(due,remaining);
    const response=await transport(`https://api.xero.com/api.xro/2.0/CreditNotes/${encodeURIComponent(verifiedId)}/Allocations`,{
      method:'PUT',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({Allocations:[{Invoice:{InvoiceID:job.invoice_id},Amount:amount/100,Date:new Date().toISOString().slice(0,10)}]}),
    });
    if(!response.ok)fail('Credit allocation outcome requires reconciliation');
    const observed=(await response.json())?.Allocations;
    if(!Array.isArray(observed)||!observed.some(a=>a.Invoice?.InvoiceID===job.invoice_id&&minor(a.Amount)===amount))
      fail('Credit allocation receipt requires reconciliation');
    allocated=true;
  }
  const receipt={provider:'xero',creditNoteId:verifiedId,invoiceId:job.invoice_id,amountMinor:expected.amountMinor,
    taxMinor:expected.taxMinor,currency:expected.CurrencyCode,allocated,allocationRequired:job.receipt?.allocationRequired??(due>0)};
  if(await store.complete(job.id,receipt)!==true)fail('Credit receipt persistence requires recovery');
  return {status:receipt.allocationRequired&&!allocated?'needs_review':'complete',receipt};
}
