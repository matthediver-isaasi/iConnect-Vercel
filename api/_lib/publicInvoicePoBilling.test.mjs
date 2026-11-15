import test from 'node:test';
import assert from 'node:assert/strict';
import {publicPoInvoiceState} from './publicInvoicePoReconciliation.js';
import {readFileSync} from 'node:fs';
import {loadPublicPoBilling,generatePublicPoInvoice,publicPoInvoiceLines} from './publicInvoicePoBilling.js';
import {publicInvoicePoBillingContact} from '../../shared/publicInvoicePoAddress.js';
import {invoiceContactPayload} from './eventInvoiceProducer.js';
function fixture({discount=0,roleMember=true,operation=null,correction=null,memberEmail='booker@example.invalid',correctionError=false,projectCode=''}={}){
 const booking={id:'b1',tenant_id:'t',event_id:'e',booking_group_reference:'group',payment_method:'public_invoice_po',status:'confirmed',
   ticket_class_id:'ticket',total_cost:120,discount_code_amount:discount,attendee_email:'attendee@example.invalid',
   purchaser_context:{classification:'public_non_member',details:{first_name:'Original',last_name:'Booker',email:'booker@example.invalid'}}};
 const tables={booking:[booking],event:[{id:'e',tenant_id:'t',title:'Meeting',internal_reference:projectCode,pricing_config:{ticket_classes:[{id:'ticket',vat_rate_key:'OUTPUT2',vat_rate_percentage:20}]}}],
   member:roleMember?[{id:'m',tenant_id:'t',first_name:'Original',last_name:'Booker',email:memberEmail}]:[],
   public_po_booker_correction:correction?[correction]:[],
   public_invoice_po_billing:operation?[operation]:[]};
 return {from(table){
   const filters=[];const query={select(){return this;},eq(k,v){filters.push(r=>r[k]===v);return this;},
     ilike(k,v){filters.push(r=>r[k].toLowerCase()===v.replace(/\\(.)/g,'$1').toLowerCase());return this;},
     order(){return this;},limit(){return this;},
     async maybeSingle(){return {data:tables[table].filter(r=>filters.every(f=>f(r)))[0]||null,error:table==='public_po_booker_correction'&&correctionError?{message:'unavailable'}:null};},
     then(resolve,reject){return Promise.resolve({data:tables[table].filter(r=>filters.every(f=>f(r))),error:null}).then(resolve,reject);}};
   return query;
 },rpc(){throw new Error('Unexpected financial write');}};
}
const correction={
 id:'c',tenant_id:'t',source:'booking',booking_group_reference:'group',event_id:'e',member_id:'m',
 original_context:{details:{email:'booker@example.invalid',last_name:'Booker',first_name:'Original'},classification:'public_non_member'},
 corrected_details:{first_name:'Original',last_name:'Booker',email:'corrected@example.invalid'},
 created_at:'2026-11-05T00:00:00Z',
};
test('explicit correction links the existing member without replacing historical identity',async()=>{
 const result=await loadPublicPoBilling(fixture({correction,memberEmail:'corrected@example.invalid'}),'t','b1',false);
 assert.equal(result.public.booker.email,'corrected@example.invalid');
 assert.equal(result.public.originalBooker.email,'booker@example.invalid');
 assert.equal(result.rows[0].purchaser_context.details.email,'booker@example.invalid');
 assert.equal(result.public.member.id,'m');
 assert.equal(result.public.canGenerate,true);
 assert.equal(result.public.bookerCorrection.id,'c');
 const old=await loadPublicPoBilling(fixture(),'t','b1',false);
 assert.notEqual(result.public.fingerprint,old.public.fingerprint);
});
test('correction fails closed on changed identity, history, event or unavailable authority',async()=>{
 for(const options of [
  {correctionError:true},
  {correction,memberEmail:'changed@example.invalid'},
  {correction:{...correction,member_id:'other'},memberEmail:'corrected@example.invalid'},
  {correction:{...correction,event_id:'other'}},
  {correction:{...correction,original_context:{}}},
 ])await assert.rejects(loadPublicPoBilling(fixture(options),'t','b1',false));
});
test('preview invoices original booker and deducts recorded simple-event discounts',async()=>{
 const preview=await loadPublicPoBilling(fixture({discount:20}),'t','b1',false);
 assert.equal(preview.public.amount,100);
 assert.equal(preview.public.member.email,'booker@example.invalid');
 assert.equal(preview.public.canGenerate,true);
 assert.equal(preview.public.lines[0].taxPercentage,20);
 await assert.rejects(generatePublicPoInvoice(fixture(),'t','admin',{bookingId:'b1',isComplex:false,fingerprint:'stale'}),/booking changed/i);
 const missing=await loadPublicPoBilling(fixture({roleMember:false}),'t','b1',false);
 assert.equal(missing.public.canGenerate,false);
 assert.match(missing.public.reason,/original booker/);
});

test('changing event project code invalidates a previous manual invoice preview', async () => {
 const before=await loadPublicPoBilling(fixture({projectCode:'OLD'}),'t','b1',false);
 const after=await loadPublicPoBilling(fixture({projectCode:'NEW'}),'t','b1',false);
 assert.equal(after.public.projectCode,'NEW');
 assert.notEqual(before.public.fingerprint,after.public.fingerprint);
 await assert.rejects(generatePublicPoInvoice(fixture({projectCode:'NEW'}),'t','admin',
   {bookingId:'b1',isComplex:false,fingerprint:before.public.fingerprint}),/booking changed/i);
});
test('unpaid, partial, paid and void invoices use provider evidence, not a fabricated payment',()=>{
 const row={invoice_id:'i1',provider:'xero',currency:'GBP',amount:120};
 const invoice={InvoiceID:'i1',CurrencyCode:'GBP',Total:120,AmountDue:120,Status:'AUTHORISED',DateString:'2026-10-29T00:00:00'};
 assert.equal(publicPoInvoiceState(row,invoice).payment_status,'unpaid');
 assert.equal(publicPoInvoiceState(row,{...invoice,AmountDue:20}).payment_status,'partial');
 assert.equal(publicPoInvoiceState(row,{...invoice,AmountDue:0,Status:'PAID'}).payment_status,'paid');
 assert.equal(publicPoInvoiceState(row,{...invoice,AmountDue:0,Status:'VOIDED'}).payment_status,'voided');
 assert.equal(publicPoInvoiceState({...row,provider:'quickbooks'},{Id:'i1',CurrencyRef:{value:'GBP'},TotalAmt:120,Balance:0}).payment_status,'paid');
 for(const bad of [{...invoice,InvoiceID:'other'},{...invoice,Total:144},{...invoice,AmountDue:-1},{...invoice,CurrencyCode:'USD'}])
  assert.throws(()=>publicPoInvoiceState(row,bad));
});
test('approval preserves record-only checkout and explicitly creates an unpaid provider snapshot',()=>{
 const load=p=>readFileSync(new URL(p,import.meta.url),'utf8');
 const source=load('./publicInvoicePoBilling.js');
 assert.match(source,/paymentMethod:'invoice'/);
 assert.match(source,/p_original:p.rows/);
 assert.match(source,/fingerprint!==p.public.fingerprint/);
 assert.match(source,/contact:p.public.billingContact/);
 assert.match(load('./eventInvoiceProducer.js'),/paymentMethod === 'public_invoice_po'.*paymentMethod === 'free'/);
 assert.doesNotMatch(load('./publicInvoicePoReconciliation.js'),/createPayment|Payments|recordPayment/);
});

test('manual invoice uses captured organisation and structured billing address, with corrected booker delivery', () => {
 const original={organization:'Example Organisation',invoicing_address_line1:'1 Road',invoicing_address_line2:'Floor 2',
   invoicing_city:'London',invoicing_region:'Greater London',invoicing_postal_code:'N1 1AA',invoicing_country:'United Kingdom'};
 const booker={first_name:'Corrected',last_name:'Booker',email:'corrected@example.test'};
 const contact=publicInvoicePoBillingContact(original,booker,'member');
 assert.equal(contact.name,'Example Organisation');
 assert.equal(contact.email,booker.email);
 assert.equal(contact.isOrganization,true);
 assert.deepEqual(contact.provenance,{kind:'member',id:'member'});
 const payload=invoiceContactPayload(contact);
 assert.equal(payload.Name,'Example Organisation');
 assert.equal(payload.Addresses[0].City,'London');
 assert.equal(payload.Addresses[0].AddressLine2,'Floor 2');
 assert.equal(payload.Addresses[0].Region,'Greater London');
 assert.equal(payload.Addresses[0].PostalCode,'N1 1AA');
 const legacy=publicInvoicePoBillingContact({},booker,'member');
 assert.equal(legacy.name,'Corrected Booker');
 assert.equal(legacy.invoicingAddress,undefined);
});

test('manual public invoice lines carry event Projects tracking without replacing PO or economics', () => {
 const preview={projectCode:'SPRING27',lines:[{description:'Ticket',amount:120,taxType:'OUTPUT2',taxPercentage:20}]};
 const [line]=publicPoInvoiceLines(preview,'200');
 assert.deepEqual(line.Tracking,[{Name:'Projects',Option:'SPRING27'}]);
 assert.equal(line.UnitAmount,120);assert.equal(line.TaxAmount,20);assert.equal(line.AccountCode,'200');
 assert.equal(publicPoInvoiceLines({...preview,projectCode:''},'200')[0].Tracking,undefined);
});
