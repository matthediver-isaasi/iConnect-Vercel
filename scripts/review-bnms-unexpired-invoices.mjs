// Read-only financial review. Does not reconstruct or grant billing consent.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const dir='generated-artifacts/bnms-expiry-only-audit';
const cohort=JSON.parse(fs.readFileSync(`${dir}/audit.json`)).affected.filter(x=>x.unexpired);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
async function get(path) {
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},signal:AbortSignal.timeout(45000)});
    if(r.status===429){await new Promise(resolve=>setTimeout(resolve,Math.max(10,Number(r.headers.get('retry-after'))||60)*1000));continue;}
    assert.equal(r.status,200,`Provider read failed: ${r.status}`);
    return r.json();
  } throw Error('Rate limit persisted; no evidence inferred');
}
const ids=[...new Set(cohort.flatMap(x=>x.invoiceReferences.map(i=>i.xeroId).filter(Boolean)))];
const cached=process.argv.includes('--reuse-evidence')
  ? JSON.parse(fs.readFileSync(`${dir}/live-review.json`)) : null;
const invoices=cached?.invoices || [];
if(!cached) for(let i=0;i<ids.length;i+=20){
  invoices.push(...(await get(`Invoices?IDs=${ids.slice(i,i+20).join(',')}`)).Invoices);
  console.log(`Read invoice batch ${Math.floor(i/20)+1}`);
}
const missingNumbers=[...new Set(cohort.flatMap(r=>r.invoiceReferences)
  .filter(ref=>!invoices.some(i=>i.InvoiceID===ref.xeroId || i.InvoiceNumber===ref.number))
  .map(ref=>ref.number).filter(Boolean))];
for(let i=0;i<missingNumbers.length;i+=20){
  const found=(await get(`Invoices?InvoiceNumbers=${encodeURIComponent(missingNumbers.slice(i,i+20).join(','))}`)).Invoices;
  for(const invoice of found) if(!invoices.some(i=>i.InvoiceID===invoice.InvoiceID)) invoices.push(invoice);
}
const contactIds=[...new Set(invoices.map(i=>i.Contact.ContactID))];
const contacts=cached?.contacts || [];
const missingContacts=contactIds.filter(id=>!contacts.some(c=>c.ContactID===id));
for(let i=0;i<missingContacts.length;i+=20) contacts.push(...(await get(`Contacts?IDs=${missingContacts.slice(i,i+20).join(',')}`)).Contacts);
const db=await connectDestination();
let members,histories,prefs,configs;
try{
  await db.query('begin read only');
  members=(await db.query('select id,email,first_name,last_name from member where tenant_id=$1',[tenant])).rows;
  histories=(await db.query('select to_jsonb(h) data from member_membership_history h where tenant_id=$1',[tenant])).rows.map(r=>r.data);
  prefs=(await db.query(`select v.member_id,f.name,v.value from member_preference_value v join preference_field f on f.id=v.field_id
    where f.tenant_id=$1 and f.name in ('member_class','ym_web_site_member_id')`,[tenant])).rows;
  configs=(await db.query("select to_jsonb(c) data from membership_tier_config c where tenant_id=$1 and structure_scope_type='member'",[tenant])).rows.map(r=>r.data);
  await db.query('rollback');
}finally{await db.end();}
const norm=s=>String(s||'').trim().toLowerCase();
const reports=cohort.map(row=>{
  const member=members.find(m=>m.id===row.memberId);
  const history=histories.find(h=>h.id===row.historyId);
  const reasons=[];
  if(!history||history.term_end_date!==row.expiry||history.term_start_date) reasons.push('Membership changed since initial audit');
  const value=name=>prefs.find(p=>p.member_id===row.memberId&&p.name===name)?.value;
  const end=new Date(`${row.expiry}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate()+1);end.setUTCFullYear(end.getUTCFullYear()-1);
  const proposedStart=end.toISOString().slice(0,10);
  const schedules=configs.filter(c=>c.structure_match_value===value('member_class')&&c.is_active&&c.start_mode==='immediate'&&c.billing_period==='annual'&&c.effective_from<=proposedStart&&(!c.effective_to||c.effective_to>=proposedStart));
  if(schedules.length!==1)reasons.push('No unique date-applicable annual schedule');
  const evidence=row.invoiceReferences.map(ref=>{
    const i=invoices.find(i=>i.InvoiceID===ref.xeroId) || invoices.find(i=>i.InvoiceNumber===ref.number);
    if(!i)return {number:ref.number,issues:['Invoice missing from live Xero response']};
    const c=contacts.find(c=>c.ContactID===i.Contact.ContactID);
    const issues=[];
    const emailMatch=!!norm(member?.email)&&norm(member.email)===norm(c?.EmailAddress);
    const accountMatch=!!value('ym_web_site_member_id')&&String(value('ym_web_site_member_id'))===String(c?.AccountNumber);
    if(!emailMatch&&!accountMatch)issues.push('Identity requires review');
    if(c?.AccountNumber&&value('ym_web_site_member_id')&&!accountMatch)issues.push('Legacy account number conflict');
    if(i.Status!=='PAID'||i.AmountDue!==0||i.AmountPaid!==i.Total||(i.AmountCredited||0)!==0||(i.CreditNotes||[]).length)issues.push('Not fully cash-settled without credit');
    const lines=(i.LineItems||[]).filter(l=>/membership/i.test(l.Description||''));
    if(lines.length!==1)issues.push('Membership line is ambiguous');
    const l=lines[0];
    if(l&&/event|congress|conference|attending|incl(?:uding|\.)|ticket|bundle/i.test(l.Description||''))issues.push('Bundled event and membership line: membership-only value is unproven');
    if(l&&(!Number.isFinite(l.LineAmount)||l.LineAmount<=0))issues.push('Membership value is unavailable');
    if(l&&/upgrade|balance|difference|pro.?rat|instalment|monthly/i.test(l.Description||''))issues.push('May be partial membership consideration');
    const invoiceDate=(i.DateString||'').slice(0,10);
    const delta=invoiceDate?Math.round((Date.parse(proposedStart)-Date.parse(invoiceDate))/86400000):null;
    if(delta!==0&&delta!==1)issues.push('Invoice date does not corroborate retained annual term');
    if(!/1 year|one year|annual|year.s/i.test(l?.Description||''))issues.push('Annual duration requires confirmation');
    return {number:i.InvoiceNumber,id:i.InvoiceID,date:invoiceDate,status:i.Status,currency:i.CurrencyCode,
      total:i.Total,amountPaid:i.AmountPaid,lineAmountTypes:i.LineAmountTypes,
      membershipLine:l?{description:l.Description,amount:l.LineAmount,tax:l.TaxAmount,taxType:l.TaxType}:null,
      emailMatch,accountMatch,paymentCount:(i.Payments||[]).length,issues};
  });
  const candidates=evidence.filter(i=>!i.issues.length);
  if(candidates.length===1&&evidence.some(i=>i.date>candidates[0].date)) reasons.push('Later linked invoice needs term reconciliation');
  if(!evidence.length)reasons.push('No historical membership invoice linked');
  if(candidates.length!==1)reasons.push(candidates.length?'Multiple plausible invoices':'No unambiguous annual invoice candidate');
  return {memberId:row.memberId,name:row.name,expiry:row.expiry,proposedStart,memberClass:value('member_class'),
    schedule:schedules.length===1?schedules[0].name:null,
    outcome:reasons.length?'Review required':'Candidate for reconstruction',reasons,evidence};
});
const totals={members:reports.length,candidates:reports.filter(r=>r.outcome==='Candidate for reconstruction').length,
  reviewRequired:reports.filter(r=>r.outcome==='Review required').length,invoicesRead:invoices.length,
  noInvoice:reports.filter(r=>!r.evidence.length).length,
  identityReview:reports.filter(r=>r.evidence.some(i=>i.issues.some(s=>/Identity|account number/.test(s)))).length,
  dateReview:reports.filter(r=>r.evidence.some(i=>i.issues.includes('Invoice date does not corroborate retained annual term'))).length};
fs.writeFileSync(`${dir}/live-review.json`,JSON.stringify({checkedAt:new Date().toISOString(),totals,reports,invoices,contacts},null,2),{mode:0o600});
const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
const csv=[['Member','Member ID','Class','Retained expiry','Proposed annual start (not applied)','Outcome','Invoice','Invoice date','Xero status','Membership description','Membership line amount','Currency','Review notes']];
for(const r of reports)for(const i of r.evidence.length?r.evidence:[{}])csv.push([r.name,r.memberId,r.memberClass,r.expiry,r.proposedStart,r.outcome,i.number,i.date,i.status,i.membershipLine?.description,i.membershipLine?.amount,i.currency,[...r.reasons,...i.issues||[]].join('; ')]);
fs.writeFileSync(`${dir}/BNMS-membership-evidence-review.csv`,csv.map(r=>r.map(quote).join(',')).join('\r\n'),{mode:0o600});
console.log(JSON.stringify(totals));
