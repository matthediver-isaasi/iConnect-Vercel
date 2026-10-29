import {randomUUID} from 'node:crypto';
import {publicPoInvoiceState} from './publicInvoicePoReconciliation.js';
const escape=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function publicPoEmailRecipient(row){
 const details=row.original_records?.[0]?.purchaser_context?.details;
 const email=String(details?.email||'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Original booker email requires review');
 return {email,name:[details.first_name,details.last_name].filter(Boolean).join(' ')};
}
async function providerDocument(row){
 if(row.provider==='xero'){
  const x=await import('./xero.js');
  const binding=await x.getValidXeroAccessToken(row.tenant_id);
  if(binding.tenantId!==row.provider_snapshot?.provider?.xeroTenantId)throw Error('Accounting company changed');
  const invoice=await x.getXeroInvoice(row.invoice_id,row.tenant_id);
  publicPoInvoiceState(row,invoice);
  if(['DRAFT','SUBMITTED'].includes(invoice.Status))throw Error('Invoice awaiting authorisation');
  if(!['AUTHORISED','PAID'].includes(invoice.Status))throw Error('Invoice status requires review');
  if(invoice.LineItems?.some(l=>String(l.Description).includes('[Event invoice recovery:')))throw Error('Invoice description needs review');
  if(invoice.SentToContact)return {alreadySent:true};
  return {pdf:await x.fetchXeroInvoicePdf(row.invoice_id,row.tenant_id)};
 }
 const q=await import('./quickbooks.js');
 const binding=await q.getQuickBooksTokenRow(row.tenant_id);
 if(binding?.realm_id!==row.provider_snapshot?.approvalProvider?.realmId
   ||binding?.environment!==row.provider_snapshot?.environment)throw Error('Accounting company changed');
 const invoice=await q.getQuickBooksInvoice(row.tenant_id,row.invoice_id);
 publicPoInvoiceState(row,invoice);
 if(invoice.EmailStatus==='EmailSent')return {alreadySent:true};
 return {pdf:await q.fetchQuickBooksInvoicePdf(row.tenant_id,row.invoice_id)};
}
async function bounded(work,ms){
 let timer;
 try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Delivery time budget exceeded')),Math.max(1,ms));})]);}
 finally{clearTimeout(timer);}
}
export async function deliverPublicPoInvoice({db,row,deadlineAt=Date.now()+25000,document=providerDocument,send}){
 const token=randomUUID();
 const {data:claimed,error}=await db.from('public_invoice_po_billing').update({
  email_status:'preparing',email_lease:token,email_lease_until:new Date(Date.now()+600000).toISOString(),
  email_next_at:new Date(Date.now()+600000).toISOString(),email_error:null,
 }).eq('id',row.id).eq('tenant_id',row.tenant_id).eq('email_status','pending')
 .lte('email_next_at',new Date().toISOString()).select('id');
 if(error)throw error;
 if(!claimed?.length)return {claimed:false};
 const save=async values=>{
  const result=await db.from('public_invoice_po_billing').update(values).eq('id',row.id)
   .eq('tenant_id',row.tenant_id).eq('email_lease',token).select('id');
  if(result.error||result.data?.length!==1)throw Error('Delivery ownership or persistence failed');
 };
 let attempted=false;
 try{
  const recipient=publicPoEmailRecipient(row);
  const doc=await bounded(document(row),deadlineAt-Date.now()-3000);
  if(doc.alreadySent){await save({email_status:'sent_external',email_error:null});return {alreadySent:true};}
  if(!Buffer.isBuffer(doc.pdf)||doc.pdf.length<5||doc.pdf.subarray(0,5).toString()!=='%PDF-')throw Error('Invoice PDF unavailable');
  if(Date.now()>=deadlineAt-3000)throw Error('Delivery preparation time budget exceeded');
  // Use the established transport, including safe sender-domain fallback.
  if(!send)send=(await import('./emailService.js')).sendEmail;
  await save({email_status:'sending'});
  attempted=true;
  const result=await bounded(send({
   tenantId:row.tenant_id,to:recipient.email,subject:`Your event invoice ${row.invoice_number||''}`.trim(),
   html:`<p>Dear ${escape(recipient.name||'booker')},</p><p>Please find attached invoice ${escape(row.invoice_number)} for your event booking.</p><p>Please use the payment details on the invoice. If you have already paid, please disregard this payment request.</p><p>Thank you.</p>`,
   attachments:[{filename:`Invoice-${String(row.invoice_number||'event').replace(/[^a-zA-Z0-9_-]/g,'')}.pdf`,data:doc.pdf,contentType:'application/pdf'}],
  }),deadlineAt-Date.now());
  if(!result?.success){
   await save({email_status:result?.notSubmitted===true||result?.ambiguousEffect===false?'pending':'unknown',
    email_next_at:new Date(Date.now()+900000).toISOString(),email_error:'Invoice email was not confirmed. Delivery requires retry or review.'});
   return {sent:false};
  }
  await save({email_status:'sent',email_sent_at:new Date().toISOString(),email_message_id:result.messageId||null,email_error:null});
  return {sent:true};
 }catch(error){
  // Never retry an uncertain provider send: it may already have been accepted.
  const review=/review|company changed|authorised/.test(error.message);
  await save({email_status:attempted?'unknown':review?'needs_review':'pending',
   email_next_at:new Date(Date.now()+900000).toISOString(),email_error:attempted?'Delivery outcome is unknown; do not resend without checking.':error.message});
  return {sent:false,unknown:attempted};
 }
}
export async function sendDuePublicPoInvoices({db,deadlineAt=Date.now()+12000}){
 const {data,error}=await db.from('public_invoice_po_billing').select('*')
  .not('invoice_id','is',null).in('email_status',['pending','preparing','sending'])
  .lte('email_next_at',new Date().toISOString()).order('email_next_at').order('id').limit(10);
 if(error)throw error;
 for(const row of data||[]){
  if(Date.now()>=deadlineAt-3000)break;
  if(row.email_status!=='pending'){
   if(Date.parse(row.email_lease_until)>Date.now())continue;
   const result=await db.from('public_invoice_po_billing').update({email_status:row.email_status==='sending'?'unknown':'pending',
    email_error:row.email_status==='sending'?'Delivery outcome is unknown; check before resending.':null})
    .eq('id',row.id).eq('email_status',row.email_status).eq('email_lease',row.email_lease)
    .lte('email_lease_until',new Date().toISOString());
   if(result.error)throw result.error;
   continue;
  }
  await deliverPublicPoInvoice({db,row,deadlineAt});
 }
}
