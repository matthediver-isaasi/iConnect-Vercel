import {createHash} from 'node:crypto';
import {enqueueCheckoutEventInvoice} from './eventInvoiceProducer.js';
import {validRecoverySnapshot,validRecoveryTaxIntent} from './eventInvoiceRecovery.js';
import {loadComplexReleaseTickets} from './ticketReleaseAccess.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function loadPublicPoBilling(db,tenantId,bookingId,isComplex){
 const source=isComplex?'complex_event_booking':'booking';
 const first=await db.from(source).select('*').eq('tenant_id',tenantId).eq('id',bookingId).maybeSingle();
 if(first.error)fail('Unable to load registration.',503);
 if(!first.data)fail('Registration not found.',404);
 const b=first.data,group=b.booking_group_reference;
 if(!group||b.purchaser_context?.classification!=='public_non_member'||(!b.public_invoice_po_billing_id&&b.payment_method!=='public_invoice_po'))fail('This is not a public Invoice / PO booking.');
 const result=await db.from(source).select('*').eq('tenant_id',tenantId).eq('booking_group_reference',group).order('id').limit(1001);
 if(result.error||!result.data?.length||result.data.length>1000)fail('Unable to load the complete booking.',503);
 const rows=result.data,booker=b.purchaser_context.details;
 const eventResult=await db.from(isComplex?'complex_event':'event').select('*').eq('tenant_id',tenantId).eq('id',b.event_id).maybeSingle();
 if(eventResult.error||!eventResult.data)fail('Event unavailable.',503);
 const event=eventResult.data;
 const tickets=isComplex?await loadComplexReleaseTickets(db,event):event.pricing_config?.ticket_classes||[];
 const members=await db.from('member').select('id,first_name,last_name,email').eq('tenant_id',tenantId)
 .ilike('email',String(booker?.email||'').trim().replace(/[%_\\]/g,'\\$&')).limit(2);
 if(members.error||members.data?.length>1)fail('The original booker account needs review.');
 const member=members.data?.[0]||null;
 const operation=await db.from('public_invoice_po_billing').select('*').eq('tenant_id',tenantId).eq('source',source).eq('booking_group_reference',group).maybeSingle();
 if(operation.error)fail('Invoice generation is not yet available. The database update must be applied.',503);
 const o=operation.data;
 let reason=null;
 const currency=String(rows[0].currency||'GBP').toUpperCase();
 const lines=rows.map(r=>{
   const amount=Number(isComplex?r.ticket_price:r.total_cost)-(isComplex?0:Number(r.discount_code_amount||0));
   const ticket=tickets.find(t=>t.id===r.ticket_class_id);
   if(!Number.isFinite(amount)||amount<=0||(isComplex?r.ticket_price:r.total_cost)==null)reason='A registration amount needs manual review.';
   if(!ticket?.vat_rate_key||ticket.vat_rate_percentage==null||ticket.vat_rate_percentage===''||!Number.isFinite(Number(ticket.vat_rate_percentage)))reason='The ticket tax settings must be reviewed before generating an invoice.';
   if(r.status!=='confirmed'||r.event_id!==b.event_id||JSON.stringify(r.purchaser_context)!==JSON.stringify(b.purchaser_context)
      ||(!o&&r.payment_method!=='public_invoice_po')||r.stripe_payment_intent_id)reason='The booking contains conflicting registration or payment evidence.';
   if(Number(r.voucher_amount||0)||Number(r.training_fund_amount||0)||Number(r.account_balance_amount||0))reason='This booking has funding allocations and needs manual review.';
   return {description:`${event.title} — ${r.ticket_class_name||'Ticket'} — ${[r.attendee_first_name,r.attendee_last_name].filter(Boolean).join(' ')}`,
     amount,taxType:ticket?.vat_rate_key,taxPercentage:Number(ticket?.vat_rate_percentage)};
 });
 const amount=Math.round(lines.reduce((s,l)=>s+l.amount,0)*100)/100;
 if(!member)reason='Create the original booker’s member account first.';
 const fingerprint=hash({rows,member,event:lines,currency});
 const invoice=o?{id:o.invoice_id||null,number:o.invoice_number,provider:o.provider,status:o.invoice_status,paymentStatus:o.payment_status}:null;
 return {public:{booker,member,amount,currency,lines,fingerprint,canGenerate:!reason&&!o,reason,invoice},
   source,group,rows,event,operation:o};
}

export async function generatePublicPoInvoice(db,tenantId,actorId,input){
 if(!actorId)fail('The acting administrator could not be identified.',403);
 const p=await loadPublicPoBilling(db,tenantId,input.bookingId,input.isComplex);
 if(p.operation)return p.public;
 if(!p.public.canGenerate)fail(p.public.reason);
 if(input.fingerprint!==p.public.fingerprint)fail('The booking changed. Review the updated invoice before continuing.');
 const commit=async(provider,snapshot)=>{
   const {data,error}=await db.rpc('public_invoice_po_bill',{
     p_tenant:tenantId,p_source:p.source,p_group:p.group,p_member:p.public.member.id,p_actor:String(actorId),
     p_original:p.rows,p_amount:p.public.amount,p_currency:p.public.currency,p_provider:provider,p_snapshot:snapshot});
   if(error)fail(error.code==='P0001'?error.message:'Invoice approval could not be saved. No new approval was committed.',503);
   return data;
 };
 const result=await enqueueCheckoutEventInvoice({
   db,tenantId,source:p.source,bookingGroupReference:p.group,event:p.event,amount:p.public.amount,currency:p.public.currency,
   paymentMethod:'invoice',contact:{name:[p.public.booker.first_name,p.public.booker.last_name].filter(Boolean).join(' '),
     email:p.public.booker.email,isOrganization:false,provenance:{kind:'member',id:p.public.member.id}},
   booker:{...p.public.booker,id:p.public.member.id},
   purchaseOrderNumber:p.rows[0].purchase_order_number,poToFollow:p.rows[0].po_to_follow,
   buildLines:accountCode=>p.public.lines.map(l=>({Description:l.description,Quantity:1,UnitAmount:l.amount,
     AccountCode:accountCode,TaxType:l.taxType,TaxAmount:Math.round(l.amount*l.taxPercentage/(100+l.taxPercentage)*100)/100,
     _invoiceLineAmountType:'Inclusive'})),
 },{
   enqueue:async({snapshot})=>{
     if(!validRecoverySnapshot(snapshot)&&!validRecoveryTaxIntent(snapshot))fail('The accounting configuration requires review before generating this invoice.');
     await commit('xero',snapshot);return {status:'pending'};
   },
   captureAccountingEvent:async args=>{
     const r=await commit('quickbooks',{...args.p_snapshot,approvalProvider:{connectionId:args.p_connection,realmId:args.p_company}});
     return {id:r.id,state:'pending'};
   },
 });
 if(!result.queued)fail('The invoice could not be queued. Check the accounting configuration before retrying.',503);
 return (await loadPublicPoBilling(db,tenantId,input.bookingId,input.isComplex)).public;
}
