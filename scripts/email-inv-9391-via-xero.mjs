// Explicitly approved fallback after Mailgun definitively rejected the send.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDestination} from './annual-meeting-destination.mjs';
assert.deepEqual(process.argv.slice(2),['--send']);
const sql=await connectDestination();
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',id='e75e8771-c6a0-4317-89b4-20532fea09f4';
const token=randomUUID();
let claimed,attempted=false,accepted=false;
try{
 const x=await import('../api/_lib/xero.js');
 const binding=await x.getValidXeroAccessToken(tenant);
 const invoice=await x.getXeroInvoice(id,tenant);
 assert.equal(invoice.InvoiceNumber,'INV-9391');assert.equal(invoice.Total,200);
 assert.equal(invoice.TotalTax,33.33);assert.equal(invoice.SentToContact,false);
 assert.ok(invoice.LineItems.every(l=>!l.Description.includes('[Event invoice recovery:')));
 const headers={Authorization:`Bearer ${binding.accessToken}`,'xero-tenant-id':binding.tenantId,Accept:'application/json'};
 const contactResponse=await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${invoice.Contact.ContactID}`,{headers,signal:AbortSignal.timeout(20000)});
 assert.equal(contactResponse.status,200);const contact=(await contactResponse.json()).Contacts[0];
 const row=(await sql.query('SELECT * FROM public_invoice_po_billing WHERE tenant_id=$1 AND invoice_id=$2',[tenant,id])).rows[0];
 assert.ok(row);assert.equal(binding.tenantId,row.provider_snapshot.provider.xeroTenantId);
 const email=row.original_records[0].purchaser_context.details.email.trim().toLowerCase();
 assert.equal(contact.EmailAddress?.trim().toLowerCase(),email);
 assert.equal((contact.ContactPersons||[]).filter(p=>p.IncludeInEmails).length,0);
 const claim=await sql.query(`UPDATE public_invoice_po_billing SET email_status='sending',email_lease=$3,
   email_lease_until=now()+interval '10 minutes',email_next_at=now()+interval '10 minutes'
   WHERE id=$1 AND tenant_id=$2 AND email_status='pending' AND email_sent_at IS NULL RETURNING id`,[row.id,tenant,token]);
 assert.equal(claim.rowCount,1,'Invoice delivery is already handled or needs review');
 claimed=row.id;attempted=true;
 const response=await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${id}/Email`,{
  method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':'inv-9391-approved-email'},
  body:'{}',signal:AbortSignal.timeout(25000)});
 accepted=response.status===204;
 if(!accepted)throw Error(`Xero email response ${response.status}`);
 const saved=await sql.query(`UPDATE public_invoice_po_billing SET email_status='sent_external',
   email_sent_at=now(),email_message_id=NULL,email_error=NULL
   WHERE id=$1 AND email_lease=$2 AND email_status='sending'`,[claimed,token]);
 assert.equal(saved.rowCount,1);
 const verified=await x.getXeroInvoice(id,tenant);
 console.log(JSON.stringify({invoice:'INV-9391',emailAcceptedByXero:true,sentToContact:verified.SentToContact,
   originalBookerOnly:true,duplicateSendBlocked:true}));
}catch(error){
 if(claimed&&!accepted)await sql.query(`UPDATE public_invoice_po_billing SET email_status='unknown',
  email_error='Xero email outcome needs review; do not resend automatically.' WHERE id=$1 AND email_lease=$2`,[claimed,token]);
 console.error(JSON.stringify({error:error.message,attempted,accepted}));
 process.exitCode=1;
}finally{await sql.end();}
