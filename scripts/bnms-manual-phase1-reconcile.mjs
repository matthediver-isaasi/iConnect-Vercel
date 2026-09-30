import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {matchingStructures} from './bnms-dd-beta-review.mjs';
import {hash} from './bnms-dd-beta-invoices.mjs';
const dir='exports/private-bnms-manual-phase1';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const sheet=await load(`${dir}/spreadsheet.json`);
const {snapshot:s}=await load(`${dir}/destination.json`);
const {discovery:p}=await load(`${dir}/gocardless.json`);
const manifestPath='exports/private-bnms-alpha-final-review-20260920/manifest.json';
const manifestBytes=await readFile(manifestPath);
const manifest=JSON.parse(manifestBytes);
const exceptions=await load('exports/private-bnms-alpha-final-review-20260920/exceptions.json');
const counts=values=>Object.fromEntries([...new Set(values)].map(k=>[k,values.filter(v=>v===k).length]));
const members=[...new Set(sheet.rows.map(r=>r.memberId))].map(id=>{
 const rows=sheet.rows.filter(r=>r.memberId===id),customers=[...new Set(rows.map(r=>r.customerId))];
 const member=s.members.find(m=>m.id===id);
 const mandates=p.mandates.filter(m=>customers.includes(m.links?.customer));
 const active=mandates.filter(m=>m.status==='active');
 const customerRows=p.customers.filter(c=>customers.includes(c.id));
 const prefs=s.preferences.filter(v=>v.member_id===id);
 const structures=matchingStructures(s.structures,prefs.filter(v=>v.name==='member_class'),'2026-10-01');
 const agreements=s.agreements.filter(a=>a.member_id===id||customers.includes(a.gocardless_customer_id));
 const plans=s.plans.filter(a=>a.member_id===id||agreements.some(b=>b.id===a.billing_agreement_id));
 const history=s.history.filter(a=>a.member_id===id);
 const prior={alpha:s.bnms_dd_alpha_adoption.filter(a=>a.member_id===id||customers.includes(a.customer_id)),beta:s.beta.filter(a=>a.member_id===id||customers.includes(a.customer_id)),pilot:s.bnms_dd_pilot_adoption.filter(a=>a.member_id===id||customers.includes(a.customer_id))};
 const mandateIds=mandates.map(m=>m.id);
 const payments=p.payments.filter(a=>mandateIds.includes(a.links?.mandate));
 const future=payments.filter(a=>['pending_submission','submitted','confirmed'].includes(a.status)||a.charge_date>='2026-10-01');
 const subscriptions=p.subscriptions.filter(a=>mandateIds.includes(a.links?.mandate)&&!['cancelled','finished'].includes(a.status));
 const discoveryConflicts=s.discovery.filter(d=>customers.includes(d.gocardless_customer_id)&&d.matched_member_id&&d.matched_member_id!==id);
 const reasons=[];
 if(!member)reasons.push('MEMBER_NOT_FOUND');
 if(customers.length!==1||customerRows.length!==1)reasons.push('CUSTOMER_MAPPING_NOT_UNIQUE');
 if(active.length!==1)reasons.push('ACTIVE_MANDATE_NOT_UNIQUE');
 if(active.some(m=>m.links?.creditor!=='CR0000B50W1Y2R'||m.scheme!=='bacs'||!m.links?.customer_bank_account))reasons.push('MANDATE_CREDITOR_SCHEME_BANK_INVALID');
 if(member&&(member.membership_paused||['cancelled','paused','deleted'].includes(member.status)))reasons.push('MEMBER_STATE_CONFLICT');
 if(structures.length!==1)reasons.push('PRICING_STRUCTURE_NOT_UNIQUE');
 if(discoveryConflicts.length)reasons.push('DISCOVERY_OWNER_CONFLICT');
 if(future.length)reasons.push('PENDING_OR_FUTURE_PAYMENTS');
 if(subscriptions.length)reasons.push('ACTIVE_SUBSCRIPTIONS');
 if(plans.length||agreements.length||history.length)reasons.push('EXISTING_CANONICAL_REQUIRES_REVIEW');
 const overlap=Object.entries(prior).filter(([,v])=>v.length).map(([k])=>k);
 const originalExceptions=exceptions.filter(e=>mandateIds.includes(e.mandateId)||e.identity?.memberId===id||customers.includes(e.identity?.customerId));
 return {memberId:id,sourceRows:rows.map(r=>r.row),issues:rows.map(r=>r.issue),customerIds:customers,member,mandates,preferences:prefs,structures,agreements,plans,history,prior,overlap,payments,future,subscriptions,discoveryConflicts,originalExceptions,reasons,
 consentVerified:false,legacyHandoverVerified:false,approvedMonthlyAmount:null,
 indicativeMonthlyAmount:structures.length===1?structures[0].dd_monthly_amount:null};
});
const report={sheetSha256:sheet.sha256,manifestFileSha256:createHash('sha256').update(manifestBytes).digest('hex'),manifestCanonicalSha256:hash(manifest),originalExceptionCount:exceptions.length,members};
await writeFile(`${dir}/reconciliation.json`,JSON.stringify(report,null,2),{mode:0o600});
const summary={rows:sheet.rows.length,uniqueMembers:members.length,uniqueCustomers:new Set(sheet.rows.map(r=>r.customerId)).size,
 categories:counts(sheet.rows.map(r=>r.issue)),repeatedMembers:members.filter(m=>m.sourceRows.length>1).map(m=>({rows:m.sourceRows,issues:m.issues})),
 overlap:counts(members.flatMap(m=>m.overlap)),reasons:counts(members.flatMap(m=>m.reasons)),
 originalExceptionsMatched:members.filter(m=>m.originalExceptions.length).length,
 matchedExceptionRecords:new Set(members.flatMap(m=>m.originalExceptions.map(e=>JSON.stringify(e)))).size,
 memberStates:counts(members.map(m=>m.member?.status||'MISSING')),
 activeMandateCounts:counts(members.map(m=>m.mandates.filter(a=>a.status==='active').length)),
 prices:counts(members.map(m=>m.indicativeMonthlyAmount??'UNRESOLVED')),
 groups:counts(members.map(m=>m.structures[0]?.structure_match_value||'UNRESOLVED')),
 executableEligible:0,approvedMonthlySum:null};
await writeFile(`${dir}/summary.json`,JSON.stringify(summary,null,2),{mode:0o600});
console.log(JSON.stringify(summary,null,2));