import {fetchFunnelInvoicePdf} from './eventFunnelInvoiceReaders.js';

// One email per funnel order carrying every issued invoice PDF. The SQL
// journal (fenced by the 'invoices' delivery lease) decides whether a send is
// allowed; an attempt whose outcome is unknown is never repeated here.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const missingFunction=error=>['42883','PGRST202'].includes(error?.code);

export function composeFunnelInvoiceEmail({recipient,invoices,events,currency,payableMinor}) {
  const many=invoices.length>1;
  const titles=(Array.isArray(events)?events:[]).filter(Boolean);
  const total=Number.isSafeInteger(payableMinor)&&/^[A-Z]{3}$/i.test(currency||'')
    ?new Intl.NumberFormat('en-GB',{style:'currency',currency:currency.toUpperCase()}).format(payableMinor/100):null;
  const list=invoices.map(invoice=>`<li>${escape(invoice.invoiceNumber?`Invoice ${invoice.invoiceNumber}`:'Invoice')}</li>`).join('');
  return {
    to:recipient,
    subject:titles.length===1?`Your ${many?'invoices':'invoice'} for ${titles[0]}`.slice(0,200)
      :`Your event booking ${many?'invoices':'invoice'}`,
    html:[
      `<p>Thank you for your booking${titles.length?` for ${titles.map(escape).join(', ')}`:''}.</p>`,
      `<p>${many?`Your ${invoices.length} invoices are`:'Your invoice is'} attached to this email.</p>`,
      `<ul>${list}</ul>`,
      total?`<p>Total for this booking: <strong>${escape(total)}</strong></p>`:'',
      '<p>Your booking confirmation is sent separately.</p>',
    ].filter(Boolean).join(''),
  };
}

const attachmentName=(invoice,index)=>`${String(invoice.invoiceNumber||`invoice-${index+1}`)
  .replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100)}.pdf`;

/** @returns {{status:'complete'|'waiting'|'retry'|'needs_review'}} */
export async function deliverFunnelInvoiceEmail({db,job,deadlineAt,loadPdf=fetchFunnelInvoicePdf,send,now=()=>Date.now()}) {
  const call=async(action,payload=null)=>{
    const result=await db.rpc('event_funnel_invoice_email_operation',{p_tenant:job.tenant_id,p_order:job.order_id,
      p_token:job.lease_token,p_action:action,p_payload:payload});
    if(result.error||!result.data) throw Object.assign(new Error('Invoice email journal unavailable'),{cause:result.error});
    return result.data;
  };
  let plan;
  try {plan=await call('read');}
  catch(error) {
    // Not installed yet: invoices behave exactly as before the email step.
    if(missingFunction(error.cause)) return {status:'complete'};
    throw error;
  }
  if(plan.status!=='pending') return {status:plan.status==='needs_review'?'needs_review':plan.status==='waiting'?'waiting':'complete'};
  if(!Array.isArray(plan.invoices)||!plan.invoices.length||!plan.recipient) throw new Error('Invoice email plan incomplete');
  // Fetch every PDF before claiming the send; a provider failure only retries.
  const attachments=[];
  for(const [index,invoice] of plan.invoices.entries()) {
    if(deadlineAt-now()<10000) return {status:'retry'};
    let pdf;
    try {pdf=await loadPdf({db,tenantId:job.tenant_id,link:invoice});}
    catch {return {status:'retry'};}
    attachments.push({filename:attachmentName(invoice,index),data:pdf,contentType:'application/pdf'});
  }
  if(deadlineAt-now()<8000) return {status:'retry'};
  const begun=await call('begin',composeFunnelInvoiceEmail(plan));
  if(begun.status==='complete') return {status:'complete'};
  if(begun.status!=='send') return {status:'needs_review'};
  if(begun.payload?.to!==plan.recipient) throw new Error('Invoice email envelope changed');
  let result;
  try {
    if(deadlineAt-now()<8000) result={notSubmitted:true};
    // No deadlineAt here: the invoice budget is shorter than the Mailgun
    // socket timeout, so sendEmail would always refuse. The single send still
    // fits inside the cron invocation, and starts only with 8s of budget left.
    else result=await (send||(await import('./emailService.js')).sendEmail)({tenantId:job.tenant_id,
      to:begun.payload.to,subject:begun.payload.subject,html:begun.payload.html,attachments,
      confidentialDiagnostics:true});
  } catch {result={success:false};}
  // Mailgun's own pre-submission refusal (deadline) is not a send.
  const outcome=result?.success===true?'accepted':result?.notSubmitted===true
    ||/deadline exhausted before Mailgun|Email service not configured|Failed to initialize Mailgun client/i
      .test(result?.error||'')?'not_submitted':'unknown';
  const finished=await call('finish',{outcome,messageId:typeof result?.messageId==='string'
    ?result.messageId.replace(/^<|>$/g,''):null});
  return {status:finished.status==='complete'?'complete':finished.status==='pending'?'retry':'needs_review'};
}
