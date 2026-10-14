import fs from 'node:fs';
import assert from 'node:assert/strict';
import {assessMember} from './bnms-live-xero-review-core.mjs';
const dir='generated-artifacts/bnms-live-xero-150';
const read=p=>JSON.parse(fs.readFileSync(p));
const complete=read(`${dir}/complete.json`);
const evidence=read(`${dir}/members.json`);
assert.equal(evidence.length,150);
assert.equal(new Set(evidence.map(m=>m.memberId)).size,150);
assert.ok(evidence.every(e=>Object.hasOwn(e,'archiveMatch')),'Expanded contact review has not completed');
const proposal=read('generated-artifacts/bnms-missing-150-review/final/proposal.json');
const context=read(`${dir}/live-context.json`);
assert.equal(context.classFields.length,1);
const results=proposal.members.map(review=>assessMember({review,
  live:context.sources.find(s=>s.id===review.memberId),
  provider:evidence.find(e=>e.memberId===review.memberId),
  configs:context.configs,classFieldId:context.classFields[0].id}));
const counts={};for(const r of results)for(const reason of r.holds)counts[reason]=(counts[reason]||0)+1;
const summary={reviewed:150,identityVerified:results.filter(r=>r.identityVerified).length,
  paidMembershipInvoiceVerified:results.filter(r=>r.paidInvoiceVerified).length,
  conditionalAnnualCandidates:results.filter(r=>r.conditionalCandidate).length,
  standaloneCandidates:results.filter(r=>r.conditionalCandidate&&r.invoiceKind==='Standalone or unresolved').length,
  itemisedMixedInvoiceCandidates:results.filter(r=>r.conditionalCandidate&&r.invoiceKind!=='Standalone or unresolved').length,
  furtherReview:results.filter(r=>!r.conditionalCandidate).length,overlappingHoldReasons:counts,
  latestMembershipInvoiceStates:evidence.reduce((counts,m)=>{
    const status=m.membershipInvoices.find(i=>i.InvoiceID===m.latestInvoiceId)?.Status||'NOT_FOUND';
    counts[status]=(counts[status]||0)+1;return counts;
  },{}),requests:complete.cachedRequests,remainingDay:complete.remainingDay,completedAt:complete.completedAt,
  membershipWrites:0,financialWrites:0,approvedForRepair:0,
  caveat:'Candidate terms assume 12 months ending on retained expiry. Invoice timing is corroboration, not explicit coverage. Recheck live records and obtain member-specific approval before repair.'};
fs.writeFileSync(`${dir}/review-results.json`,JSON.stringify({summary,results},null,2),{mode:0o600});
const columns={
  name:'Name',email:'Email',memberId:'Member ID',memberClass:'Member class',outcome:'Review outcome',
  identityVerified:'Contact verified',paidInvoiceVerified:'Paid membership invoice verified',
  invoiceNumber:'Latest paid membership invoice',invoiceDate:'Invoice date',amount:'Invoice total',
  membershipAmount:'Membership amount (not entire event invoice)',invoiceKind:'Invoice composition',
  currency:'Currency',description:'Invoice description',latestInvoiceNumber:'Latest membership invoice',
  latestInvoiceStatus:'Latest membership invoice status',proposedStart:'Conditional 12-month start',
  retainedExpiry:'Retained expiry',proposedRenewal:'Conditional renewal date',structure:'Member-class structure',
  holds:'Reasons for further review',authority:'Authority'};
const quote=value=>`"${String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;
const rows=[Object.values(columns),...results.sort((a,b)=>Number(b.conditionalCandidate)-Number(a.conditionalCandidate)||a.name.localeCompare(b.name))
  .map(r=>Object.keys(columns).map(k=>{
    if(['invoiceDate','proposedStart','retainedExpiry','proposedRenewal'].includes(k)&&r[k])
      return r[k].split('-').reverse().join('/');
    return Array.isArray(r[k])?r[k].join('; '):r[k];
  }))];
fs.writeFileSync(`${dir}/BNMS-Live-Xero-Membership-Review-150-14-10-2026.csv`,
  '\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n'),{mode:0o600});
console.log(JSON.stringify(summary));
