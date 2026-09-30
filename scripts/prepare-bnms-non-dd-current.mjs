#!/usr/bin/env node
// Reads existing contacts/invoices only. Never creates provider objects.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inventory } from './audit-bnms-non-dd-cohort.mjs';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { TENANT, MEMBER, XERO_TENANT } from './audit-bnms-non-dd-pilot.mjs';

export const AS_OF = '2026-09-22';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function invoiceProof(i) {
  return {
    id:i.InvoiceID,contact:i.Contact?.ContactID,type:i.Type,status:i.Status,date:i.DateString,
    currency:i.CurrencyCode,total:i.Total,tax:i.TotalTax,paid:i.AmountPaid,due:i.AmountDue,
    credited:i.AmountCredited,credits:i.CreditNotes||[],prepayments:i.Prepayments||[],overpayments:i.Overpayments||[],
    lines:i.LineItems?.map(l=>({description:l.Description,amount:l.LineAmount,tax:l.TaxAmount,
      tracking:l.Tracking?.map(t=>({name:t.Name,option:t.Option}))})),
    payments:i.Payments?.map(p=>({id:p.PaymentID,amount:p.Amount,date:p.Date,reference:p.Reference})),
  };
}
export function recordId(memberId) {
  const s = digest(`bnms-non-dd-current:2025/2026:${memberId}`);
  return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;
}
const minor = value => value == null || !Number.isFinite(Number(value))
  || Math.abs(Number(value)*100-Math.round(Number(value)*100))>1e-7 ? null : Math.round(Number(value)*100);
export function invoiceCandidate(invoices) {
  const matching = invoices.filter(i => i.Type === 'ACCREC' && i.Status === 'PAID'
    && i.LineItems?.some(l => l.Tracking?.some(t => t.Name === 'Projects' && t.Option === 'MEMBERSHIPS')));
  matching.sort((a,b) => String(b.DateString).localeCompare(String(a.DateString)));
  if (!matching.length) return { state: 'missing_paid_membership_invoice' };
  const i = matching[0];
  if (!i.DateString || matching.filter(x=>x.DateString.slice(0,10)===i.DateString.slice(0,10)).length !== 1) {
    return { state: 'equal_date_or_missing_date_ambiguity' };
  }
  if (i.CurrencyCode !== 'GBP' || minor(i.Total) <= 0 || minor(i.Total) == null
    || minor(i.AmountPaid) !== minor(i.Total) || minor(i.AmountDue) !== 0 || minor(i.AmountCredited) !== 0
    || i.CreditNotes?.length || i.Prepayments?.length || i.Overpayments?.length
    || !Array.isArray(i.Payments) || !i.Payments.length
    || i.Payments.some(p=>!p.PaymentID || minor(p.Amount) == null || minor(p.Amount)<=0)
    || i.Payments.reduce((sum,p)=>sum+minor(p.Amount),0)!==minor(i.Total)
    || minor(i.TotalTax)!==0
    || i.LineItems.some(l=>!l.Tracking?.some(t=>t.Name==='Projects'&&t.Option==='MEMBERSHIPS'))) {
    return { state: 'financial_or_mixed_invoice_conflict' };
  }
  return { state: 'candidate', invoice: i };
}
export async function prepare({ pilot = false, progress = () => {} } = {}) {
  const snapshot = await inventory();
  const selected = snapshot.candidates.filter(r=>r.category==='requires_term_and_invoice_review'
    && r.expiry>=AS_OF && r.expiry<='2026-12-31' && (!pilot || r.id===MEMBER));
  const c=await destinationConnection(); await c.connect();
  let members,auth;
  try {
    await c.query('BEGIN READ ONLY');
    members=(await c.query('SELECT id,email FROM member WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[TENANT,selected.map(r=>r.id)])).rows;
    const tokens=(await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1',[TENANT])).rows;
    if(tokens.length!==1 || tokens[0].tenant_id!==XERO_TENANT
      || new Date(tokens[0].expires_at).getTime()<Date.now()+10*60*1000) {
      throw Error('Fresh BNMS Xero connection required; refresh using the existing helper in a DEST-pinned process');
    }
    auth={tenantId:tokens[0].tenant_id,accessToken:tokens[0].access_token};
  } finally { await c.query('ROLLBACK'); await c.end(); }
  const get=async resource=>{
    for(let attempt=0;attempt<4;attempt++){
      await new Promise(r=>setTimeout(r,2500));
      const response=await fetch(`https://api.xero.com/api.xro/2.0/${resource}`,{
        headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
        signal:AbortSignal.timeout(30000),
      });
      if(response.status===429&&attempt<3){
        const delay=Number(response.headers.get('retry-after'));
        if(!Number.isFinite(delay)||delay>120)throw Error('Provider rate limit requires later retry; no membership writes');
        await new Promise(r=>setTimeout(r,Math.max(60,delay)*1000));continue;
      }
      if(!response.ok)throw Error(`Provider HTTP ${response.status}; lookup is incomplete, not missing evidence`);
      return response.json();
    }
  };
  const pages=async(resource,params,key)=>{
    const values=[],seen=new Set();
    for(let page=1;page<=100;page++){
      const data=await get(`${resource}?${new URLSearchParams({...params,page:String(page)})}`);
      if(!Array.isArray(data[key]))throw Error('Provider pagination payload invalid');
      for(const row of data[key]){
        const id=row[`${resource==='Contacts'?'Contact':'Invoice'}ID`];
        if(!id||seen.has(id))throw Error('Provider pagination identity drift');
        seen.add(id);values.push(row);
      }
      if(data[key].length<100)return values;
    }
    throw Error('Provider pagination incomplete');
  };
  const manifest={version:1,tenantId:TENANT,asOf:AS_OF,sourceHash:snapshot.sourceHash,rows:[],evidence:[]};
  const reviews=[];
  for(const candidate of selected){
    const member=members.find(m=>m.id===candidate.id);
    const email=member?.email?.trim().toLowerCase();
    if(!email){reviews.push({memberId:candidate.id,state:'missing_identity'});continue;}
    const contacts=await pages('Contacts',{where:`EmailAddress==${JSON.stringify(email)}`},'Contacts');
    const exact=contacts.filter(x=>x.EmailAddress?.trim().toLowerCase()===email
      &&x.AccountNumber===candidate.preferences.ym_web_site_member_id&&x.ContactStatus==='ACTIVE');
    const review={memberId:candidate.id,expiry:candidate.expiry,type:candidate.preferences.ym_membership_type,
      state:'missing_or_ambiguous_contact'};
    reviews.push(review);
    if(exact.length!==1){progress(reviews.length,selected.length);continue;}
    const invoices=await pages('Invoices',{where:`Contact.ContactID==Guid("${exact[0].ContactID}")&&Type=="ACCREC"`,order:'Date DESC'},'Invoices');
    const choice=invoiceCandidate(invoices);
    review.state=choice.state;
    if(choice.state!=='candidate'){progress(reviews.length,selected.length);continue;}
    const invoice=choice.invoice;
    if(invoice.Contact?.ContactID!==exact[0].ContactID)throw Error('Invoice contact mismatch');
    // A paid older invoice must never prove a newer term. Cohort rows without
    // explicit 2025/2026 invoice wording need individual term-match review.
    const explicitTerm=invoice.LineItems.every(l=>/\b2025\s*[-/]\s*(?:2026|26)\b/.test(l.Description||''));
    const approvedPilot=candidate.id===MEMBER&&invoice.InvoiceID==='946eb930-d00b-4400-a1be-0138c01fcc55'
      &&minor(invoice.Total)===10900&&candidate.expiry==='2026-09-29';
    review.state=approvedPilot||explicitTerm?'ready_for_review':'invoice_term_unconfirmed';
    review.invoice={id:invoice.InvoiceID,number:invoice.InvoiceNumber,date:invoice.DateString.slice(0,10),
      amount:Number(invoice.Total),description:invoice.LineItems.map(l=>l.Description).join('; ')};
    if(invoice.DateString.slice(0,10)>AS_OF || invoice.DateString.slice(0,10)>candidate.expiry
      || invoice.DateString.slice(0,10)<'2025-01-01'){review.state='invoice_period_conflict';continue;}
    for(const p of invoice.Payments){
      const payments=(await get(`Payments/${p.PaymentID}`)).Payments;
      if(payments?.length!==1||payments[0].PaymentID!==p.PaymentID||payments[0].Status!=='AUTHORISED'
        ||payments[0].Invoice?.InvoiceID!==invoice.InvoiceID||minor(payments[0].Amount)!==minor(p.Amount)){
        review.state='payment_detail_conflict';break;
      }
    }
    if(review.state!=='ready_for_review'){progress(reviews.length,selected.length);continue;}
    const sourceHash=digest(candidate);
    const provenance={source:'bnms_non_dd_current_backfill',version:1,sourceHash,
      paymentAuthority:'operator_attested_upfront_paid_2025_2026',
      startDateAuthority:'unknown_not_inferred',expiryAuthority:'retained_legacy_expiry',
      legacy:candidate.preferences,xeroTenantId:XERO_TENANT,xeroContactId:exact[0].ContactID,
      invoiceId:invoice.InvoiceID,invoiceEvidenceSha256:digest(invoiceProof(invoice)),
      termAuthority:approvedPilot?'operator_reviewed_pilot':'explicit_invoice_2025_2026'};
    manifest.rows.push({
      id:recordId(candidate.id),tenant_id:TENANT,member_id:candidate.id,membership_year:'2025/2026',
      config_id:null,tier_label:candidate.preferences.ym_membership_type,
      term_start_date:null,term_end_date:candidate.expiry,status:'active',payment_status:'paid',
      final_cost:Number(invoice.Total),total_with_vat:Number(invoice.Total),currency:'GBP',
      payment_method:'upfront',billing_period:'annual',
      accounting_provider:'xero',accounting_invoice_id:invoice.InvoiceID,accounting_invoice_number:invoice.InvoiceNumber,
      xero_invoice_id:invoice.InvoiceID,xero_invoice_number:invoice.InvoiceNumber,notes:JSON.stringify(provenance),
    });
    manifest.evidence.push({memberId:candidate.id,sourceHash});
    progress(reviews.length,selected.length);
  }
  return {manifest,reviews,inventory:snapshot.totals,selected:selected.length,writes:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  const out=args.find(a=>a.startsWith('--out='))?.slice(6);
  if(!out?.startsWith('/tmp/')||args.some(a=>a!=='--pilot'&&!a.startsWith('--out=')))throw Error('Use [--pilot] --out=/tmp/new-private-report.json');
  const report=await prepare({pilot:args.includes('--pilot'),progress:(n,total)=>console.log(`Reviewed ${n}/${total}`)});
  const f=await open(out,'wx',0o600);try{await f.writeFile(JSON.stringify(report,null,2));}finally{await f.close();}
  console.log(JSON.stringify({selected:report.selected,ready:report.manifest.rows.length,states:report.reviews.reduce((a,r)=>(a[r.state]=(a[r.state]||0)+1,a),{}),out,writes:0}));
}