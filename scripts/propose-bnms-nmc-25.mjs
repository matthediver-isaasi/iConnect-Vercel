// Offline report only. This script has no database or provider client.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {assessMember} from './bnms-live-xero-review-core.mjs';
const dir='generated-artifacts/bnms-nmc-25-evidence';
const read=p=>JSON.parse(fs.readFileSync(p));
const snapshot=read(`${dir}/snapshot.json`), sources=read(`${dir}/sources.json`).rows;
const providers=read(`${dir}/members.json`), complete=read(`${dir}/complete.json`);
const config=read('generated-artifacts/bnms-current-commitments/snapshot.json');
assert.equal(complete.members,25);assert.equal(providers.length,25);
const field=config.preference_field.find(f=>f.name==='member_class'&&f.entity_scope==='member'&&f.is_active);
const date=(x,days=0)=>{const d=new Date(`${x}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const today=complete.completedAt.slice(0,10);
const rows=sources.map(source=>{
  const member=snapshot.members.find(m=>m.id===source.memberId);
  const live=snapshot.source.find(m=>m.id===source.memberId);
  const provider=providers.find(m=>m.memberId===source.memberId);
  const contact=provider.contacts.length===1?provider.contacts[0]:null;
  const legacy=String(live.preferences.ym_web_site_member_id||'').trim();
  const originalEmailIdentity=!!contact&&!!legacy&&contact.AccountNumber?.trim()===legacy
    &&source.sourceState==='source_fields_corroborated'
    &&source.matches.some(m=>!m.identityConflict&&m.legacyId===legacy&&m.email?.trim().toLowerCase()===contact.EmailAddress?.trim().toLowerCase());
  const assessed=assessMember({review:{memberId:member.id,name:source.name,email:member.email,memberClass:source.memberClass,
    retainedExpiry:source.expiry,sourceState:source.sourceState,liveSource:live},
    live,provider:{...provider,exact:provider.exact||originalEmailIdentity},
    configs:config.membership_tier_config,classFieldId:field.id,today});
  const invoice=provider.membershipInvoices.find(i=>i.InvoiceID===provider.latestPaidInvoiceId);
  const histories=snapshot.histories.filter(h=>h.member_id===member.id);
  const agreement=snapshot.agreements.find(a=>a.member_id===member.id);
  const existingEnd=histories.map(h=>h.term_end_date).filter(Boolean).sort().at(-1);
  const end=existingEnd||source.expiry;
  const invoiceDay=invoice?.DateString?.slice(0,10);
  const offset=end&&invoiceDay?(Date.parse(invoiceDay)-Date.parse(end))/86400000:null;
  const simpleAnnual=invoice?.LineItems?.length===1
    &&/\bmembership\b/i.test(invoice.LineItems[0].Description)
    &&!/\bDD\b|direct debit|upgrade|adjustment|instalment/i.test(invoice.LineItems[0].Description)
    &&invoice.Total>=100;
  let proposedStart='',proposedEnd='',category='',required='';
  if(agreement){
    category='Existing DD dates: reconcile activation/collection, not term dates';
    proposedStart=histories[0]?.term_start_date||'';proposedEnd=histories[0]?.term_end_date||'';
    required='Retain existing dates and unpaid status; verify provider setup/collection outcome before changing membership recognition.';
  }else if(!end){
    category='Missing expiry: administrator dates required';
    required='Xero records a payment date, not coverage dates. Confirm exact membership commencement and expiry; do not assume invoice anniversary.';
  }else if(assessed.paidInvoiceVerified&&simpleAnnual&&offset>=-31&&offset<=120){
    category='Renewal reconstruction proposed: approve successor dates';
    proposedStart=date(end,1);proposedEnd=`${Number(end.slice(0,4))+1}${end.slice(4)}`;
    required='Approve a 12-month successor starting after the retained prior expiry. Invoice supports payment, not exact coverage. Preserve/reconstruct prior term separately; do not overwrite it.';
  }else if((Date.parse(today)-Date.parse(end))/86400000<=90){
    category='Retain expiry: resolve historical membership evidence';
    proposedEnd=end;
    required=assessed.paidInvoiceVerified
      ?'Approve retained expiry as historical entitlement; commencement can remain unknown. Resolve any DD/term-timing holds without creating billing instructions.'
      :'Confirm historical entitlement and resolve contact/payment holds. Do not mark credited, uncertain or absent payments as verified cash.';
  }else{
    category='Expired beyond allowance: current entitlement dates required';
    required='Only older coverage is evidenced. Confirm a later membership period and its payment/free-entitlement basis; do not roll expiry forward merely to reach the journal count.';
  }
  return {memberId:member.id,name:source.name,email:member.email,memberClass:source.memberClass,category,
    retainedExpiry:end||'',proposedStart,proposedEnd,required,sourceState:source.sourceState,
    identityBasis:originalEmailIdentity&&!provider.exact?'Original import email plus matching legacy account; current email changed':
      assessed.identityVerified?'Existing matched provider identity':'Identity unresolved',
    verifiedPaid:assessed.paidInvoiceVerified,invoice:invoice?.InvoiceNumber||'',invoiceDate:invoiceDay||'',
    amount:invoice?.Total??'',membershipAmount:assessed.membershipAmount??'',
    paymentDates:provider.payments.map(p=>p.DateString?.slice(0,10)||(/\d+/.test(p.Date||'')?new Date(Number(p.Date.match(/\d+/)[0])).toISOString().slice(0,10):'')).join('; '),
    description:assessed.description,creditAmount:invoice?.AmountCredited||0,holds:assessed.holds.join('; '),
    ddAgreement:agreement?.status||'',sourceEvidence:source.matches.map(m=>`${m.file} row ${m.row}; expiry ${m.expiry||'unknown'}`).join(' | '),
    invoiceHistoryReviewed:provider.invoiceAudit.length>0,
    authority:'Proposal only. No financial or membership changes authorised by this report; exact successor coverage requires approval.'};
});
assert.equal(rows.length,25);assert.equal(new Set(rows.map(r=>r.memberId)).size,25);
const summary=rows.reduce((o,r)=>(o[r.category]=(o[r.category]||0)+1,o),{});
fs.writeFileSync(`${dir}/proposal.json`,JSON.stringify({asOf:complete.completedAt,summary,rows},null,2),{mode:0o600});
const columns={name:'Member',email:'Email',memberId:'Member ID',memberClass:'Member class',category:'Proposed action',
  retainedExpiry:'Existing/retained expiry',proposedStart:'Proposed start - needs approval',proposedEnd:'Proposed/retained end - needs approval',
  required:'Approval or further evidence required',verifiedPaid:'Cash settlement AND identity verified',identityBasis:'Identity evidence',
  invoice:'Latest paid-status Xero invoice',invoiceDate:'Invoice date',paymentDates:'Payment dates',amount:'Whole invoice GBP',
  membershipAmount:'Identifiable membership amount GBP',description:'Invoice description',creditAmount:'Amount settled by credits GBP',
  ddAgreement:'Local DD agreement status',holds:'Checks and cautions',sourceState:'Original import comparison',
  sourceEvidence:'Original evidence',invoiceHistoryReviewed:'Xero invoice audit history reviewed',authority:'Authority'};
const quote=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
const csv=[Object.values(columns),...rows.map(r=>Object.keys(columns).map(k=>{
  const v=r[k];return ['retainedExpiry','proposedStart','proposedEnd','invoiceDate'].includes(k)&&v?v.split('-').reverse().join('/'):v;
}))].map(row=>row.map(quote).join(',')).join('\r\n');
fs.writeFileSync(`${dir}/BNMS-25-NMC-Membership-Proposals-14-10-2026.csv`,'\uFEFF'+csv,{mode:0o600});
console.log(JSON.stringify({summary,renewals:rows.filter(r=>r.category.startsWith('Renewal')).map(r=>({name:r.name,from:r.proposedStart,to:r.proposedEnd,invoice:r.invoice,amount:r.membershipAmount}))}));
