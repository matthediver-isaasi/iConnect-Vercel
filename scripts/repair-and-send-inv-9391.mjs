// Owner-approved scope: remove only this invoice's technical suffix, then send once.
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {connectDestination} from './annual-meeting-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const invoiceId='e75e8771-c6a0-4317-89b4-20532fea09f4';
const sql=await connectDestination();
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false}});
const {getXeroInvoice,getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const {getTenantEmailConfig}=await import('../api/_lib/tenantEmailService.js');
const {deliverPublicPoInvoice,publicPoEmailRecipient}=await import('../api/_lib/publicPoInvoiceEmail.js');
const {publicPoInvoiceState}=await import('../api/_lib/publicInvoicePoReconciliation.js');
try{
 const row=(await sql.query(`SELECT a.* FROM public_invoice_po_billing a JOIN booking b ON b.public_invoice_po_billing_id=a.id
   WHERE b.id='591492cb-2409-4625-8d7a-e753af3d4d5c' AND a.tenant_id=$1`,[tenant])).rows[0];
 assert.ok(row);assert.equal(Number(row.amount),200);assert.equal(row.provider,'xero');
 const recipient=publicPoEmailRecipient(row);
 const invoice=await getXeroInvoice(invoiceId,tenant);
 assert.equal(invoice.InvoiceNumber,'INV-9391');
 publicPoInvoiceState({...row,invoice_id:invoiceId},invoice);
 const binding=await getValidXeroAccessToken(tenant);
 assert.equal(binding.tenantId,row.provider_snapshot.provider.xeroTenantId);
 const config=await getTenantEmailConfig(tenant);
 assert.ok(config?.domain,'Verified sending domain required');
 // Check acceptance evidence before any send, not just Xero's SentToContact.
 const url=new URL(`https://api.eu.mailgun.net/v3/${encodeURIComponent(config.domain)}/events`);
 url.searchParams.set('recipient',recipient.email);url.searchParams.set('event','accepted');
 url.searchParams.set('begin',String(Math.floor(new Date(row.created_at).getTime()/1000)));url.searchParams.set('limit','300');
 const history=await fetch(url,{headers:{Authorization:'Basic '+Buffer.from(`api:${process.env.MAILGUN_EVENTS_API_KEY||process.env.MAILGUN_API_KEY}`).toString('base64')},signal:AbortSignal.timeout(20000)});
 assert.equal(history.status,200,'Mailgun history must be checked before sending');
 const events=(await history.json()).items;
 assert.ok(Array.isArray(events)&&events.length<300,'History must be complete');
 const previouslyMailed=events.some(e=>/invoice/i.test(e.message?.headers?.subject||''));
 const financial=i=>JSON.stringify({
  number:i.InvoiceNumber,contact:i.Contact.ContactID,status:i.Status,currency:i.CurrencyCode,
  total:i.Total,subtotal:i.SubTotal,tax:i.TotalTax,due:i.AmountDue,paid:i.AmountPaid,credited:i.AmountCredited,
  date:i.Date,dueDate:i.DueDate,reference:i.Reference,lineAmountTypes:i.LineAmountTypes,
  lines:i.LineItems.map(({Description,...rest})=>rest),payments:i.Payments,credits:i.CreditNotes,
 });
 const suffix=/\n?\[Event invoice recovery: event[0-9a-f-]+\]\s*$/;
 const lines=invoice.LineItems.map(line=>({...line,Description:line.Description.replace(suffix,'')}));
 const changes=lines.filter((l,i)=>l.Description!==invoice.LineItems[i].Description).length;
 assert.ok(changes<=1);
 console.log(JSON.stringify({invoice:'INV-9391',markerLines:changes,providerAlreadySent:!!invoice.SentToContact,
  priorInvoiceEmailFound:previouslyMailed,deliveryStatus:row.email_status,apply:process.argv.includes('--apply')}));
 if(!process.argv.includes('--apply'))process.exitCode=0;
 else{
  assert.deepEqual(process.argv.slice(2),['--apply']);
  if(changes){
   const response=await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`,{
    method:'POST',headers:{Authorization:`Bearer ${binding.accessToken}`,'xero-tenant-id':binding.tenantId,
     'Content-Type':'application/json',Accept:'application/json','Idempotency-Key':'inv-9391-description-cleanup'},
    body:JSON.stringify({Invoices:[{InvoiceID:invoiceId,LineItems:lines}]}),signal:AbortSignal.timeout(25000)});
   assert.equal(response.status,200,'Xero description update failed; do not send');
   const updated=await getXeroInvoice(invoiceId,tenant);
   assert.equal(financial(updated),financial(invoice),'Invoice financial evidence changed');
   assert.deepEqual(updated.LineItems.map(l=>l.Description),lines.map(l=>l.Description));
  }
  assert.ok(!['unknown','sending','preparing'].includes(row.email_status),'Delivery outcome needs review');
  const state=publicPoInvoiceState({...row,invoice_id:invoiceId},invoice);
  const desired=invoice.SentToContact||previouslyMailed?'sent_external':'pending';
  const updated=await db.from('public_invoice_po_billing').update({...state,invoice_id:invoiceId,invoice_number:'INV-9391',
   email_status:desired,email_next_at:new Date().toISOString()}).eq('id',row.id).eq('tenant_id',tenant)
   .eq('email_status','legacy_review').select('*');
  assert.ifError(updated.error);
  const current=updated.data?.[0]||(await db.from('public_invoice_po_billing').select('*').eq('id',row.id).single()).data;
  assert.ok(current);
  const result=current.email_status==='pending'
   ?await deliverPublicPoInvoice({db,row:current,deadlineAt:Date.now()+60000})
   :{alreadyHandled:current.email_status};
  console.log(JSON.stringify({descriptionCorrected:true,financialsPreserved:true,delivery:result}));
 }
}finally{await sql.end();}
