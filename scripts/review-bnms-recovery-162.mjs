import fs from 'node:fs';
import assert from 'node:assert/strict';
import {assessMember} from './bnms-live-xero-review-core.mjs';
import {overseasWordingAgrees} from './bnms-recovery-source-evidence.mjs';
const root='generated-artifacts/bnms-current-commitments';
const read=p=>JSON.parse(fs.readFileSync(p));
const sources=read(`${root}/recovery-sources.json`).rows;
const snapshot=read(`${root}/recovery-162.json`),context=read(`${root}/snapshot.json`);
const old=read('generated-artifacts/bnms-live-xero-150/members.json');
const fresh=read('generated-artifacts/bnms-remaining-84/members.json');
assert.equal(fresh.length,84);assert.equal(sources.length,162);
const classField=context.preference_field.filter(f=>f.name==='member_class'&&f.entity_scope==='member'&&f.is_active);
assert.equal(classField.length,1);
const previous=read('generated-artifacts/bnms-live-xero-150/review-results.json').results;
const dd=read(`${root}/recovery-dd-live.json`);assert.equal(dd.complete,true);
const rows=sources.map(s=>{
  const live=snapshot.source.find(r=>r.id===s.memberId);
  const provider=fresh.find(r=>r.memberId===s.memberId)||old.find(r=>r.memberId===s.memberId);
  assert.ok(provider);assert.equal(live.history_count,0);
  const aliasReconciled=overseasWordingAgrees(s);
  const sourceState=aliasReconciled?'source_fields_corroborated':s.state;
  const result=assessMember({review:{...s,sourceState,liveSource:live,historicalDDDescription:
    (previous.find(r=>r.memberId===s.memberId)?.holds||[]).includes('DD evidence needs reconciliation')
      ||snapshot.invoices.some(i=>i.member_id===s.memberId&&/\bDD\b|direct debit/i.test(i.description||''))},
    live,provider,configs:context.membership_tier_config,classFieldId:classField[0].id});
  const current=s.retainedExpiry&&s.retainedExpiry>='2026-10-14';
  let category='Unresolved: further evidence or owner confirmation required';
  if(result.conditionalCandidate)category=current?'Paid current-term reconstruction candidate':'Paid historical-only reconstruction candidate';
  else if(s.memberClass==='Student'&&sourceState==='source_fields_corroborated')
    category=current?'Free Student: confirm entitlement through retained expiry':'Expired Student: confirm continuation, not just historical repair';
  const p=provider.membershipInvoices.find(i=>i.InvoiceID===provider.latestPaidInvoiceId);
  const ddFullPayment=result.paidInvoiceVerified
    &&(previous.find(r=>r.memberId===s.memberId)?.holds||[]).includes('DD evidence needs reconciliation')
    &&provider.payments.length===1&&provider.payments[0].Amount===p.Total;
  const oldEndPaidLater=result.paidInvoiceVerified&&s.retainedExpiry&&s.retainedExpiry<'2026-10-14'
    &&p.DateString.slice(0,10)>s.retainedExpiry;
  const gc=dd.results.find(r=>r.memberId===s.memberId);
  const gcPayments=gc?.mandates.flatMap(m=>m.payments)||[];
  return {...result,category,aliasReconciled,sourceState,originalSourceState:s.state,
    liveGcMandates:gc?.mandates.map(m=>m.mandate.status).join('; ')||'Not in the eight linked-mandate cases',
    liveGcEmailMatches:gc?gc.mandates.every(m=>m.customer.email?.trim().toLowerCase()===s.email?.trim().toLowerCase()):null,
    liveGcSubscriptions:gc?gc.mandates.reduce((n,m)=>n+m.subscriptions.length,0):null,
    liveGcPaymentCount:gc?gcPayments.length:null,
    lastSuccessfulGcDate:gcPayments.filter(p=>['confirmed','paid_out'].includes(p.status)).map(p=>p.charge_date).sort().at(-1)||null,
    sourceDetails:s.matches.map(m=>`${m.file} row ${m.row}: ${m.class}; ${m.type}; expiry ${m.expiry||'unknown'}`).join(' | '),
    ddFullPayment,oldEndPaidLater,earlier35:!!previous.find(r=>r.memberId===s.memberId&&r.paidInvoiceVerified&&!r.conditionalCandidate),
    providerCheck:old.some(r=>r.memberId===s.memberId)?'Earlier live Xero evidence from 14/10/2026 reused':'New live Xero review 14/10/2026',
    nextStep:category.startsWith('Paid current')?'Approve exact reconstructed dates; revalidate before writing':
      category.startsWith('Paid historical')?'Historical record only; requires later payment/continuation evidence for current access':
      category.startsWith('Free Student')?'Confirm historic free eligibility and retained end date; do not invent cash payment':
      category.startsWith('Expired Student')?'Confirm still eligible/enrolled and approved continuation dates':
      ddFullPayment?'Single full-amount Xero settlement verified; confirm historical term/instrument separately from collection consent':
      oldEndPaidLater?'Later paid invoice found; reconcile successor dates rather than keep the stale expiry':
      'Resolve listed holds; no automatic restoration'};
});
const tally=(items,key)=>items.reduce((a,r)=>(a[r[key]]=(a[r[key]]||0)+1,a),{});
const summary={reviewed:rows.length,categories:tally(rows,'category'),paidIdentityVerified:rows.filter(r=>r.paidInvoiceVerified).length,
  aliasesReconciled:rows.filter(r=>r.aliasReconciled).length,earlier35Categories:tally(rows.filter(r=>r.earlier35),'category'),
  earlier35AliasResolved:rows.filter(r=>r.earlier35&&r.aliasReconciled).length,
  singleFullPaymentWithDDLabel:rows.filter(r=>r.ddFullPayment).length,
  laterPaidThanStaleExpiry:rows.filter(r=>r.oldEndPaidLater).length,
  dd:{members:dd.results.length,mandateStatuses:tally(dd.results.flatMap(r=>r.mandates.map(m=>m.mandate)),'status'),
    subscriptions:dd.results.reduce((n,r)=>n+r.mandates.reduce((n,m)=>n+m.subscriptions.length,0),0),
    membersWithPayments:dd.results.filter(r=>r.mandates.some(m=>m.payments.length)).length},
  repairsApplied:0,providerWrites:0};
fs.writeFileSync(`${root}/recovery-review.json`,JSON.stringify({summary,rows},null,2),{mode:0o600});
const cols={name:'Name',email:'Email',memberId:'Member ID',memberClass:'Member class',category:'Recovery position',
  invoiceNumber:'Paid invoice',invoiceDate:'Invoice date',amount:'Whole invoice total',membershipAmount:'Membership amount',
  retainedExpiry:'Retained expiry',proposedStart:'Conditional historical start',proposedRenewal:'Conditional renewal date',
  aliasReconciled:'Overseas terminology reconciled',paidInvoiceVerified:'Paid invoice and identity verified',
  ddFullPayment:'DD-labelled invoice settled as one full payment',oldEndPaidLater:'Paid invoice after stale expiry',
  liveGcMandates:'Live GC mandate status',liveGcEmailMatches:'GC customer email matches member',
  liveGcSubscriptions:'GC subscriptions found',liveGcPaymentCount:'GC payments found',
  lastSuccessfulGcDate:'Last successful GC collection',
  holds:'Remaining checks',nextStep:'Next step',sourceDetails:'Original source evidence',providerCheck:'Provider check'};
const quote=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
const csv=[Object.values(cols),...rows.map(r=>Object.keys(cols).map(k=>{
  const v=r[k];if(['invoiceDate','retainedExpiry','proposedStart','proposedRenewal','lastSuccessfulGcDate'].includes(k)&&v)return v.split('-').reverse().join('/');
  return Array.isArray(v)?v.join('; '):v;
}))].map(r=>r.map(quote).join(',')).join('\r\n');
fs.writeFileSync(`${root}/BNMS-Membership-Recovery-162-14-10-2026.csv`,'\uFEFF'+csv,{mode:0o600});
console.log(JSON.stringify(summary));
