// GET-only accounting evidence for the already-corrected cohort.
// Does not change membership, invoices, payments or collections.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination, PROJECT} from './lib/member-index-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const dir='generated-artifacts/bnms-2027-correction';
assert.ok(fs.readFileSync('.gitignore','utf8').includes('/generated-artifacts/'));
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname,`${PROJECT}.supabase.co`);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const db=await connectDestination();
let rows;
try {
  await db.query('BEGIN READ ONLY');
  rows=(await db.query(`with corrected as materialized (
    select * from member_membership_history where tenant_id=$1
      and notes like '{"source":"bnms_2027_expiry_gap_correction",%'
    ) select h.id history_id,h.member_id,h.term_end_date::text,
    m.first_name,m.last_name,m.email,h.field_value member_class,
    i.id imported_invoice_id,i.invoice_number,i.amount_minor,i.description,
    (select v.value from member_preference_value v join preference_field f on f.id=v.field_id
      where v.member_id=m.id and f.tenant_id=m.tenant_id and f.name='ym_web_site_member_id' limit 1) legacy_account
    from corrected h join member m on m.id=h.member_id and m.tenant_id=h.tenant_id
    join historical_member_invoice i on i.tenant_id=h.tenant_id and i.member_id=h.member_id
      and (h.notes::jsonb->'historicalInvoiceIds') ? i.id::text
    where h.tenant_id=$1 and h.notes::jsonb->>'source'='bnms_2027_expiry_gap_correction'
    order by h.member_id,i.invoice_number`,[tenant])).rows;
  await db.query('ROLLBACK');
} finally {await db.end();}
assert.equal(new Set(rows.map(r=>r.member_id)).size,18,'Unexpected correction cohort');
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
let auth;
try {auth=await getValidXeroAccessToken(tenant);} catch {throw new Error('BNMS Xero authorisation unavailable; no accounting evidence read or membership changes made');}
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
let last=0;
async function get(resource,params={}) {
  await new Promise(r=>setTimeout(r,Math.max(0,2100-(Date.now()-last))));last=Date.now();
  const response=await fetch(`https://api.xero.com/api.xro/2.0/${resource}?${new URLSearchParams(params)}`,{
    headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Xero ${resource} read failed (HTTP ${response.status})`);
  return response.json();
}
const invoices=[];
for(let page=1;page<=5;page++){
  const data=await get('Invoices',{InvoiceNumbers:[...new Set(rows.map(r=>r.invoice_number))].join(','),page:String(page)});
  assert.ok(Array.isArray(data.Invoices));invoices.push(...data.Invoices);
  if(data.Invoices.length<100)break;
  if(page===5)throw Error('Incomplete pagination');
}
const contacts=[];
const ids=[...new Set(invoices.map(i=>i.Contact.ContactID))];
if(ids.length) {
  const data=await get('Contacts',{IDs:ids.join(','),includeArchived:'true'});
  assert.ok(Array.isArray(data.Contacts));contacts.push(...data.Contacts);
}
const results=rows.map(row=>{
  const found=invoices.filter(i=>i.InvoiceNumber===row.invoice_number);
  const invoice=found.length===1?found[0]:null;
  const contact=contacts.find(c=>c.ContactID===invoice?.Contact.ContactID);
  const lines=(invoice?.LineItems||[]).map(l=>({id:l.LineItemID,description:l.Description,lineAmount:l.LineAmount,
    tax:l.TaxAmount,quantity:l.Quantity,unitAmount:l.UnitAmount,taxType:l.TaxType}));
  const renewal=new Date(`${row.term_end_date}T00:00:00Z`);renewal.setUTCDate(renewal.getUTCDate()+1);
  const start=new Date(renewal);start.setUTCFullYear(start.getUTCFullYear()-1);
  return {...row,proposedStart:start.toISOString().slice(0,10),invoiceId:invoice?.InvoiceID,
    xeroStatus:invoice?.Status,currency:invoice?.CurrencyCode,lineAmountTypes:invoice?.LineAmountTypes,
    subTotal:invoice?.SubTotal,totalTax:invoice?.TotalTax,total:invoice?.Total,paid:invoice?.AmountPaid,
    due:invoice?.AmountDue,credited:invoice?.AmountCredited,
    emailMatches:!!contact&&contact.EmailAddress?.trim().toLowerCase()===row.email?.trim().toLowerCase(),
    legacyAccountMatches:!!contact?.AccountNumber&&contact.AccountNumber===row.legacy_account,
    explicitAccountConflict:!!contact?.AccountNumber&&contact.AccountNumber!==row.legacy_account,lines};
});
const paymentEvidence=[];
for(const result of results.filter(r=>r.emailMatches&&!r.explicitAccountConflict)) {
  const invoice=invoices.find(i=>i.InvoiceID===result.invoiceId);
  const verified=[];
  let reason=null;
  for(const p of invoice.Payments||[]) {
    try {
      const response=await get(`Payments/${p.PaymentID}`);
      const actual=response.Payments?.[0];
      assert.equal(response.Payments?.length,1);
      assert.equal(actual.Invoice?.InvoiceID,invoice.InvoiceID);
      assert.equal(actual.Status,'AUTHORISED');
      assert.equal(actual.Amount,p.Amount);
      verified.push(actual);
    } catch {reason='Payment detail could not be verified';break;}
  }
  const total=verified.reduce((n,p)=>n+Number(p.Amount),0);
  if(!verified.length||Math.abs(total-invoice.AmountPaid)>0.01)reason='Payment evidence incomplete';
  paymentEvidence.push({memberId:result.member_id,invoiceId:invoice.InvoiceID,verified:!reason,reason,payments:verified});
}
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const path=`${dir}/xero-evidence-${Date.now()}.json`;
fs.writeFileSync(path,JSON.stringify({capturedAt:new Date().toISOString(),rows:results,invoices,contacts,paymentEvidence,membershipWrites:0},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({evidence:path,members:18,invoiceReferences:rows.length,found:invoices.length,
  paidInvoices:invoices.filter(i=>i.Status==='PAID').length,
  results:results.map(({member_id,invoice_number,proposedStart,term_end_date,xeroStatus,currency,lineAmountTypes,subTotal,totalTax,total,paid,due,credited,
    emailMatches,legacyAccountMatches,explicitAccountConflict,lines})=>({member_id,invoice_number,proposedStart,
      term_end_date,xeroStatus,currency,lineAmountTypes,subTotal,totalTax,total,paid,due,credited,emailMatches,legacyAccountMatches,explicitAccountConflict,lines}))},null,2));
