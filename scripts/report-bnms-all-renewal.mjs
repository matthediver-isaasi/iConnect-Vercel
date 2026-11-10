import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DIR, TENANT, hash } from './capture-bnms-all-renewal.mjs';
import { offlineDatabase } from './lib/renewal-audit-snapshot.mjs';
import { classifyMember, historicalInvoiceLinkMatches } from './lib/bnms-renewal-classification.mjs';
// Fence module-level clients as well as the injected database. No live I/O.
globalThis.fetch = async () => { throw new Error('Network forbidden during offline audit'); };
const { selectCanvasCommitment, buildCanvasSummary, matchingBillingEvidence,
  collectionEvidence, pilotHistoricalEvidence, pendingSignupPrice } = await import('../api/membership/canvas-summary.js');
const { attachAlphaMembershipRecognition } = await import('../api/_lib/alphaMembershipRecognition.js');
const { resolveMemberAmendmentReadOverlays } = await import('../api/_lib/membershipAmendmentReadOverlay.js');
const { loadCanvasRenewalEligibility } = await import('../api/_lib/canvasRenewalEligibility.js');
const { loadFormMembershipRenewalContext } = await import('../api/_lib/formMembershipRenewalContext.js');
const { canvasDirectDebitCollection } = await import('../api/_lib/canvasDirectDebitCollection.js');
const { applyRenewalJourney } = await import('../api/_lib/membershipRenewalJourney.js');
const snapshot=JSON.parse(await fs.readFile(`${DIR}/snapshot.json`,'utf8'));
assert.equal(hash(snapshot.tables),snapshot.snapshotHash);
const t=snapshot.tables, today=snapshot.meta.as_of.slice(0,10);
for(const [table,c] of Object.entries(snapshot.completeness)) {
  assert.equal(t[table].length,c.expected); assert.equal(hash(t[table]),c.sha256);
}
const literalCapability = name => {
  const f=snapshot.functions.find(f=>f.proname===name);
  return f && /\$function\$\s*SELECT true\s*\$function\$/.test(f.definition)
    ? {data:true,error:null} : {data:null,error:{code:'AUDIT_UNKNOWN',message:'Capability not verified'}};
};
const postGrace = snapshot.grants.length===3 && snapshot.grants.every(g=>g.executable);
const capabilities={
  membership_successor_elections_enabled:{data:t.membership_successor_tenant_rollout.find(r=>r.tenant_id===TENANT)?.enabled===true},
  form_expiry_only_renewal_supported:literalCapability('form_expiry_only_renewal_supported'),
  form_expiry_only_mapped_renewal_supported:literalCapability('form_expiry_only_mapped_renewal_supported'),
  post_grace_checkout_ready:{data:postGrace},
};
const db=offlineDatabase(t,capabilities);
const stop=new Error('AUDIT_STOP_BEFORE_PRICING');
const simulate=async()=>{throw stop;};
const rows=[];
const owned=(table,id,key='member_id')=>(t[table]||[]).filter(r=>r.tenant_id===TENANT&&r[key]===id);
const preference=(id,name)=>{
  const field=t.preference_field.find(f=>f.name===name);
  return t.member_preference_value.filter(v=>v.member_id===id&&v.field_id===field?.id).map(v=>v.value).join('|');
};
for(const member of t.member) {
  const errors=[];
  let selected=null,summary=null,renewal=null;
  const histories=owned('member_membership_history',member.id);
  const orgHistories=member.organization_id?owned('organisation_membership_history',member.organization_id,'organization_id'):[];
  const agreements=owned('membership_billing_agreements',member.id).filter(a=>!a.organization_id);
  const plans=owned('membership_payment_plans',member.id).filter(a=>!a.organization_id);
  try {
    const personal=await resolveMemberAmendmentReadOverlays({db,tenantId:TENANT,
      history:histories.map(h=>({...h,membership_source:'personal'})),asOf:today});
    await attachAlphaMembershipRecognition(db,TENANT,member.id,personal,today);
    selected=selectCanvasCommitment(personal,orgHistories.map(h=>({...h,membership_source:'organisation'})),today);
    const billing=await matchingBillingEvidence(db,selected,TENANT,member.id);
    const plan=billing?.plan||null;
    const managed=plan?.metadata?.collection_mode==='dynamic'?null:await collectionEvidence(db,plan,TENANT,member.id,today);
    const historical=await pilotHistoricalEvidence(db,selected,plan,TENANT,member.id);
    summary=buildCanvasSummary({selected:selected?{...selected,historicalPayment:historical,
      confirmedPayment:managed?.confirmed||historical?.latest,plannedCollection:managed?.planned}:null,
      plan,paused:member.membership_paused,today});
    const pending=await pendingSignupPrice(db,{selected,agreement:billing?.agreement,plan,owner:member,tenantId:TENANT,today});
    if(pending&&summary.membership.state==='pending')summary.payment.state='bank_setup_pending';
    summary.renewal=await loadCanvasRenewalEligibility(db,{selected,owner:member,history:personal,today,plan,simulate});
    if(summary.renewal.inGrace)summary.payment.state='paid';
    summary.renewal=await applyRenewalJourney(db,TENANT,summary.renewal);
    summary=await canvasDirectDebitCollection(db,{tenantId:TENANT,owner:member,plan,summary,today});
    summary.auditPlanId=plan?.id;
    if(summary.renewal.reason==='eligibility_evidence_unavailable')errors.push('Optional portal renewal eligibility unavailable; pricing was not executed.');
    if(summary.renewal.journeyUnavailable)errors.push('Configured renewal journey unavailable.');
  }catch(e){errors.push(`Portal projection: ${e.message}`);}
  try {renewal=(await loadFormMembershipRenewalContext(db,{tenantId:TENANT,memberId:member.id,now:new Date(`${today}T12:00:00Z`),simulate})).renewal;}
  catch(e){renewal=e===stop?{state:'admitted_to_pricing_not_run'}:{state:'unresolved'};if(e!==stop)errors.push(`Admission: ${e.message}`);}
  const planIds=new Set(plans.map(p=>p.id));
  const row=classifyMember({member,memberClass:preference(member.id,'member_class'),membershipStatus:preference(member.id,'membership_status'),
    histories,orgHistories,agreements,plans,payments:t.gocardless_payments.filter(p=>planIds.has(p.plan_id)),
    invoices:owned('historical_member_invoice',member.id),
    instalments:t.membership_instalment_invoices.filter(p=>planIds.has(p.plan_id)),
    arrears:t.membership_monthly_arrears_period.filter(p=>planIds.has(p.plan_id)),
    elections:owned('membership_successor_election',member.id),quotes:owned('membership_payment_quote',member.id),
    feeTokens:owned('membership_fee_token',member.id),selected,summary,renewal,errors,today,tenantId:TENANT});
  row.portalProjection=summary; row.admission=renewal;
  row.termEvidence=histories.map(h=>({id:h.id,start:h.term_start_date,end:h.term_end_date,
    renewalDate:h.membership_renewal_date,status:h.status,paymentStatus:h.payment_status,
    method:h.payment_method,period:h.billing_period,agreementId:h.billing_agreement_id,
    amount:h.total_with_vat??h.final_cost,currency:h.currency,
    invoiceId:h.accounting_invoice_id||h.xero_invoice_id||null,configId:h.config_id,
    previousTermId:h.previous_term_id}));
  const add=(category,code,records,reason,impact)=>row.issues.push({category,code,
    references:records.map(r=>r.id||r.history_id||r.provider_payment_id).filter(Boolean),reason,impact,
    confidence:'high',nextAction:'Verify exact owner, term and provider/accounting evidence; any repair requires separate approval.'});
  const imports=[
    ...owned('bnms_dd_alpha_provider_history',member.id).map(p=>({...p,cohort:'alpha'})),
    ...owned('bnms_dd_beta_provider_history',member.id).map(p=>({...p,cohort:'beta'})),
    ...owned('bnms_dd_historical_payment',member.id).map(p=>({...p,cohort:'pilot'})),
  ];
  for(const p of imports) {
    const links=p.cohort==='pilot'?(p.xero_invoice_id?[p]:[]):owned(`bnms_dd_${p.cohort}_invoice_link`,member.id)
      .filter(i=>i.provider_payment_id===p.provider_payment_id);
    if(links.length!==1||!links[0].xero_invoice_id)
      add('accounting_only','historical_payment_invoice_unresolved',[p,...links],
        'Imported payment does not have exactly one scoped invoice identity.',
        'Historical accounting evidence incomplete; no new debt or invoice inferred.');
    if(p.cohort!=='pilot'&&links.some(l=>!historicalInvoiceLinkMatches(p,l)))
      add('accounting_only','historical_invoice_history_mismatch',[p,...links],
        'Historical payment/invoice link does not match its provider-history identity and owner.','Payment attribution requires review.');
  }
  for(const h of histories) {
    const id=h.accounting_invoice_id||h.xero_invoice_id;
    if(!id)continue;
    const inv=owned('historical_member_invoice',member.id).filter(i=>i.xero_document_id===id);
    if(h.payment_status==='paid'&&inv.some(i=>['unpaid','partial'].includes(i.accounting_payment_status)))
      add('accounting_only','paid_history_unpaid_invoice',[h,...inv],
        'Paid history links to a historical invoice with an unpaid/partial stored accounting status.',
        'Possible stale accounting mirror or inconsistent evidence; verify balances before acting.');
  }
  const resources=new Set([...agreements.flatMap(a=>[a.gocardless_billing_request_id,a.gocardless_mandate_id,
    a.stripe_subscription_id,a.stripe_checkout_session_id]),...plans.flatMap(p=>[p.gocardless_subscription_id,p.stripe_subscription_id]),
    ...t.gocardless_payments.filter(p=>planIds.has(p.plan_id)).map(p=>p.gocardless_payment_id)].filter(Boolean));
  const failedEvents=t.payment_webhook_events.filter(e=>resources.has(e.resource_id)&&
    !['processed','ignored','skipped'].includes(e.processing_status));
  if(failedEvents.length)add('unresolved','provider_event_not_processed',failedEvents,
    'Linked provider events have not reached processed/ignored state.',
    'Stored outcome may be incomplete; this audit did not replay or reconcile events.');
  const reservations=t.gocardless_collection_reservations.filter(r=>planIds.has(r.plan_id)&&r.status==='blocked');
  if(reservations.length)add('risk','blocked_collection_reservation',reservations,
    'Stored collection reservation is blocked.','Collection continuation requires evidence review, not an automatic retry.');
  row.classification=['blocker','risk','unresolved','display_only','accounting_only','expected']
    .find(c=>row.issues.some(i=>i.category===c));
  rows.push(row);
}
assert.equal(rows.length,t.member.length);
assert.equal(new Set(rows.map(r=>r.memberId)).size,rows.length);
assert.equal(db.denied.length,0);
const counts=(list,key)=>list.reduce((o,r)=>{const k=key(r);o[k]=(o[k]||0)+1;return o;},{});
const issueCounts={};
for(const code of new Set(rows.flatMap(r=>r.issues.map(i=>i.code)))) {
  const affected=rows.filter(r=>r.issues.some(i=>i.code===code));
  issueCounts[code]={members:affected.length,activePopulationMembers:affected.filter(r=>!r.exclusion).length,
    occurrences:affected.reduce((n,r)=>n+r.issues.filter(i=>i.code===code).length,0),
    categories:[...new Set(affected.flatMap(r=>r.issues.filter(i=>i.code===code).map(i=>i.category)))]};
}
// Unowned evidence remains visible instead of disappearing in a member join.
const memberIds=new Set(t.member.map(m=>m.id)), planIds=new Set(t.membership_payment_plans.map(p=>p.id));
const orphans=[];
for(const [table,records] of Object.entries(t)) for(const r of records) {
  if(r.member_id&&!memberIds.has(r.member_id))orphans.push({table,id:r.id||r.history_id,memberId:r.member_id,reason:'owner outside captured population'});
  if(['gocardless_payments','membership_instalment_invoices'].includes(table)&&r.plan_id&&!planIds.has(r.plan_id))
    orphans.push({table,id:r.id,planId:r.plan_id,reason:'plan unavailable'});
}
const summary={...snapshot.meta,snapshotHash:snapshot.snapshotHash,population:rows.length,
  classification:counts(rows,r=>r.classification),populationExclusions:counts(rows,r=>r.exclusion||'not_excluded'),
  issueCounts,orphanEvidence:orphans.length,unavailableTables:snapshot.unavailable,
  uniqueActionableMembers:rows.filter(r=>!r.exclusion&&r.issues.some(i=>['blocker','risk'].includes(i.category))).length,
  uniqueBlockerMembers:rows.filter(r=>!r.exclusion&&r.issues.some(i=>i.category==='blocker')).length,
  readTables:[...db.reads],prohibitedOperations:db.denied};
await fs.writeFile(`${DIR}/evidence.json`,JSON.stringify({summary,rows,orphans},null,2),{mode:0o600});
const csvCell=v=>`"${String(v??'').replaceAll('"','""')}"`;
const columns=['memberId','memberClass','membershipStatus','exclusion','scope','historyCount','classification',
  'membershipState','paymentState','renewalState','renewalReason','selectedHistoryId','historyIds','agreementIds','planIds','termEvidence','issues'];
await fs.writeFile(`${DIR}/members.csv`,[columns.join(','),...rows.map(r=>columns.map(k=>csvCell(typeof r[k]==='object'?JSON.stringify(r[k]):r[k])).join(','))].join('\n'),{mode:0o600});
await fs.writeFile(`${DIR}/summary.json`,JSON.stringify(summary,null,2),{mode:0o600});
console.log(JSON.stringify(summary,null,2));
