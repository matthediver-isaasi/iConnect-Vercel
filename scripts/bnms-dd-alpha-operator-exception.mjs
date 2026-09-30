// Exact one-off operator policy. Normal release, deployed runtime and SQL guards
// are intentionally unchanged. All provider access here is bounded GC GET only.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {hash,sqlHash,TENANT_ID,assertHistoricalInvoicesComplete} from './bnms-dd-beta-invoices.mjs';
import {REQUIRED_SOURCES} from './bnms-dd-pilot-deployment-proof.mjs';
import {ALPHA_MANIFEST_SHA256,ALPHA_XERO_TENANT_ID,PROCESSING_NOT_BEFORE,alphaStateHash,validateAlphaReleaseScope,
  validateAlphaBankApproval,prepareAlphaRelease,alphaReleaseManifest,verifyAlphaReleaseSchema,
  assertAlphaStageFresh} from './bnms-dd-alpha-release.mjs';
import {alphaPaymentHistoryRequiresReconciliation,assertAlphaManualEvidence,alphaManualApproval,
  ALPHA_MANUAL_APPROVAL_SHA256,unrelatedAlphaEventInvoice} from './bnms-dd-alpha-manual-exceptions.mjs';
import {readAlphaIdentityBindings,reviewNewAlphaIdentityBindings} from './bnms-dd-alpha-identity-binding-review.mjs';

export const CACHED_REPORT_PATH='exports/private-bnms-alpha-attestation-20260921/readiness-only-refreshed-auth.json';
export const CACHED_REPORT_SHA256='1b9adae3413e6e6440224f45e724c13ec51511f0bab87bcf27551b13904c55a9';
export const RENEWAL_PATH='exports/private-bnms-alpha-resume-20260923-0810/full-current-invoice.json';
export const RENEWAL_SHA256='55f78bb0c654112ea406d4fc6cff26dbe3925d7da4a14dcacf1cf4561e67be87';
export const HANDOVER_PATH='exports/private-bnms-readiness-20260923-074558/handover-alpha.json';
export const APPROVAL={
  id:'bnms-alpha-249-operator-exception-20260923',actor:'user',
  source:'Explicit user instruction in this conversation: yes implement exception release Alpha',
  waivers:['FRESH_XERO_CHECKS','DEPLOYMENT_REPORT_FRESHNESS'],
  tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,members:249,monthlyTotalMinor:303342,
  processingNotBefore:PROCESSING_NOT_BEFORE,
  restrictions:['No Xero API requests','No Beta10/pilot1 release','No provider business writes',
    'No identity/mandate/pricing/duplicate-payment/subscription/ownership/schema/Oct1-gate waiver'],
};
const APPROVAL_HASH=hash(APPROVAL);
// These are the supplied transcript facts, not an invented raw API response.
export const DEPLOYMENT_REPORT={
  observedAt:'2026-09-23T11:28:17.842681+00:00',teamId:'team_6nULXm5hUGvUCNwvc7Axz6GF',
  projectId:'prj_iPFlb9rOOVNVtbobMRR1vyV934lf',deploymentId:'dpl_CPcyWnUX9Fy1SeFKeUoc9BhxPY2v',
  cronDeploymentId:'dpl_CPcyWnUX9Fy1SeFKeUoc9BhxPY2v',state:'READY',target:'production',
  commit:'a7dc0f345ecd47e994dd9f103404fbe3aaa04d2e',
  baselineId:'dpl_6hEq9mdejDLdB9eUukppK419dPWt',baselineState:'READY',baselineTarget:'production',
  baselineCommit:'83ceae1732fb5b63e7312fe5c0baf438831b31f2',projectBeforeAfterUnchanged:true,
  cronDisabledAtPresent:true,cronDisabledAt:null,path:'/api/cron/reconcile-gocardless',
  schedule:'15 */6 * * *',configurationUnchanged:true,
};
const DEPLOYMENT_HASH=hash(DEPLOYMENT_REPORT);
const OPERATOR_SOURCES=[
  'scripts/bnms-dd-alpha-operator-exception.mjs','scripts/run-bnms-dd-alpha-operator-exception.mjs',
  'scripts/bnms-dd-alpha-identity-binding-review.mjs','scripts/bnms-dd-alpha-release.mjs',
  'scripts/bnms-dd-alpha-manual-exceptions.mjs','scripts/bnms-dd-beta-invoices.mjs',
  'scripts/bnms-dd-pilot-deployment-proof.mjs',
];
export const exceptionImplementationHashes=async()=>Object.fromEntries(
  await Promise.all(OPERATOR_SOURCES.map(async path=>[path,sqlHash(await readFile(path))])));
const check=(v,message)=>{if(!v)throw Error(message);};
const same=(a,b)=>hash(a)===hash(b);
const norm=v=>String(v||'').trim().toLowerCase();
const sorted=rows=>[...rows].sort((a,b)=>String(a.id||a.history_id).localeCompare(String(b.id||b.history_id)));
const withoutAudit=({created_at,updated_at,...row})=>row;

// Reuse the already-approved exact event-invoice renewal as aged evidence.
// Original full scan and renewed observation remain separate immutable sources.
export async function readApprovedCachedEvidence(){
  const raw=await readFile(CACHED_REPORT_PATH),renewalRaw=await readFile(RENEWAL_PATH);
  check(sqlHash(raw)===CACHED_REPORT_SHA256&&sqlHash(renewalRaw)===RENEWAL_SHA256,
    'Pinned complete aged Xero source digest differs');
  const cached=JSON.parse(raw).report,renewal=JSON.parse(renewalRaw),approval=alphaManualApproval();
  check(approval.renewals.length===1,'Exact approved cached renewal required');
  const pin=approval.renewals[0];
  const owner=cached.members.find(m=>m.exceptionInvoices?.some(i=>i.InvoiceID===pin.id));
  const index=owner?.exceptionInvoices.findIndex(i=>i.InvoiceID===pin.id);
  check(owner&&hash(owner.exceptionInvoices[index])===pin.previousDigest
    &&hash(renewal.invoice)===pin.digest&&renewal.invoice.InvoiceID===pin.id
    &&unrelatedAlphaEventInvoice({memberId:owner.memberId,contactId:owner.accounting.contactId},
      renewal.invoice,cached.accounts),'Approved aged invoice renewal identity/evidence differs');
  owner.exceptionInvoices[index]=renewal.invoice;
  cached.manualExceptionApproval=approval;
  cached.manualExceptionApprovalSha256=ALPHA_MANUAL_APPROVAL_SHA256;
  return {cached,renewalSource:{path:RENEWAL_PATH,sha256:RENEWAL_SHA256,
    observedAt:renewal.observedAt,completedAt:renewal.completedAt,
    invoiceDigest:pin.digest,approvalSha256:ALPHA_MANUAL_APPROVAL_SHA256,freshness:'AGED_EXPLICITLY_WAIVED'}};
}

export function validateExceptionAudit(audit,memberIds,now=new Date()){
  check(hash(audit?.approval)===APPROVAL_HASH&&audit.approvalSha256===APPROVAL_HASH,
    'Exact operator approval and only two scoped waivers required');
  check(hash(audit.deploymentReport)===DEPLOYMENT_HASH&&audit.deploymentReportSha256===DEPLOYMENT_HASH,
    'Pinned deployment summary/digest differs');
  check(audit.agedXero.sha256===CACHED_REPORT_SHA256&&audit.agedXero.freshness==='AGED_EXPLICITLY_WAIVED'
    &&audit.fullAlphaReadinessComplete===false,'Pinned aged Xero evidence required; cannot claim full readiness');
  const start=Date.parse(audit.agedXero.observedAt),end=Date.parse(audit.agedXero.completedAt);
  check(Number.isFinite(now.getTime())&&Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&end<=now.getTime()
    &&Date.parse(audit.deploymentReport.observedAt)<=now.getTime(),'Invalid/future exception evidence timestamp');
  {
    const r=audit.agedXero.approvedRenewal;
    check(r?.sha256===RENEWAL_SHA256&&r.approvalSha256===ALPHA_MANUAL_APPROVAL_SHA256
      &&r.freshness==='AGED_EXPLICITLY_WAIVED'
      &&Number.isFinite(Date.parse(r.observedAt))&&Date.parse(r.observedAt)<=Date.parse(r.completedAt)
      &&Date.parse(r.completedAt)<=now.getTime(),'Approved renewal digest/timestamps differ');
  }
  check(memberIds.length===249,'Exact 249 fresh observations required');
  assertAlphaStageFresh([audit.nonXeroStage],memberIds,now);
  check(audit.goCardless.requests>0&&audit.goCardless.requests<=20&&audit.goCardless.method==='GET'
    &&audit.goCardless.accountWideCursorExhausted===true,'Bounded fresh GoCardless evidence required');
  const gcStart=Date.parse(audit.goCardless.observedAt),gcEnd=Date.parse(audit.goCardless.completedAt);
  check(Number.isFinite(gcStart)&&Number.isFinite(gcEnd)&&gcStart>=Date.parse(audit.nonXeroStage.observedAt)
    &&gcStart<=gcEnd&&gcEnd<=Date.parse(audit.nonXeroStage.completedAt),'GoCardless evidence timestamps inconsistent');
}

export async function verifyExceptionSources(){
  const sourceHashes={};
  for(const path of REQUIRED_SOURCES){
    const local=await readFile(path),deployed=execFileSync('git',['show',`${DEPLOYMENT_REPORT.commit}:${path}`],
      {maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
    check(sqlHash(local)===sqlHash(deployed),`Reviewed/deployed source differs: ${path}`);
    sourceHashes[path]=sqlHash(local);
  }
  return {version:1,projectId:DEPLOYMENT_REPORT.projectId,teamId:DEPLOYMENT_REPORT.teamId,
    deploymentId:DEPLOYMENT_REPORT.deploymentId,commit:DEPLOYMENT_REPORT.commit,sourceHashes,
    provenance:{kind:'user-supplied-transcript-deployment-summary',agentLiveVerified:false,
      observedAt:DEPLOYMENT_REPORT.observedAt,summarySha256:DEPLOYMENT_HASH,freshnessWaived:true},
    cron:{deploymentId:DEPLOYMENT_REPORT.cronDeploymentId,path:DEPLOYMENT_REPORT.path,
      schedule:DEPLOYMENT_REPORT.schedule,disabledAt:null}};
}

export async function readExceptionSnapshot(c,ids){
  const state={};
  for(const table of ['member','membership_billing_agreements','membership_payment_plans','member_membership_history'])
    state[table]=(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 AND ${table==='member'?'id':'member_id'}=ANY($2::uuid[])`,[TENANT_ID,ids])).rows.map(r=>r.row);
  for(const table of ['membership_tier_config','membership_tier_vat_override'])
    state[table]=(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1`,[TENANT_ID])).rows.map(r=>r.row);
  state.preference_field=(await c.query("SELECT to_jsonb(t) row FROM preference_field t WHERE tenant_id=$1 AND name='member_class' AND entity_scope='member' AND is_active=true",[TENANT_ID])).rows.map(r=>r.row);
  state.member_preference_value=(await c.query('SELECT to_jsonb(t) row FROM member_preference_value t WHERE member_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
  const read=async table=>(await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1`,[TENANT_ID])).rows.map(r=>r.row);
  const adoptions=await read('bnms_dd_alpha_adoption'),historical=await read('bnms_dd_alpha_provider_history'),
    links=await read('bnms_dd_alpha_invoice_link');
  const settings=(await c.query("SELECT to_jsonb(t) row FROM system_settings t WHERE tenant_id=$1 AND setting_key IN ('xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code')",[TENANT_ID])).rows.map(r=>r.row);
  const provider=(await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1',[TENANT_ID])).rows[0]||null;
  // Local identity metadata only: do not retrieve tokens or call Xero.
  const xeroIdentity=(await c.query('SELECT app_tenant_id,tenant_id FROM xero_token WHERE app_tenant_id=$1',[TENANT_ID])).rows;
  const identity=await readAlphaIdentityBindings(c,ids);
  const collisions=(await c.query(`SELECT r.id FROM gocardless_collection_reservations r
    JOIN bnms_dd_alpha_adoption a ON r.plan_id=a.plan_id OR r.billing_agreement_id=a.agreement_id
    WHERE a.tenant_id=$1 UNION ALL SELECT p.id FROM gocardless_payments p
    JOIN bnms_dd_alpha_adoption a ON p.gocardless_mandate_id=a.mandate_id WHERE a.tenant_id=$1`,[TENANT_ID])).rows;
  return {state,adoptions,historical,links,settings,provider,xeroIdentity,identity,collisions};
}
// Normalize row order; timestamps are genuine JSONB database values, not JS Dates.
export const exceptionSnapshotHash=s=>hash({...s,state:alphaStateHash(s.state),
  adoptions:sorted(s.adoptions),historical:sorted(s.historical),links:sorted(s.links),
  settings:sorted(s.settings),identity:{current:sorted(s.identity.current),bindings:sorted(s.identity.bindings.map(b=>({...b,id:b.member_id})))}});

export async function readFreshExceptionGoCardless(credentials,{transport=fetch,now=()=>new Date()}={}){
  check(credentials.source==='tenant'&&credentials.tenantId===TENANT_ID&&credentials.environment==='live'
    &&credentials.accessToken&&!credentials.accessToken.startsWith('sandbox_')
    &&(!credentials.creditorId||credentials.creditorId==='CR0000B50W1Y2R'),'Pinned live GoCardless credentials required');
  const observedAt=now().toISOString(),discovery={};let requests=0;
  for(const resource of ['mandates','customers','subscriptions','payments']){
    const records=[],seen=new Set(),cursors=new Set();let after=null;
    do{
      check(requests<20,'Account-wide GoCardless 20-request budget exhausted');requests++;
      const url=new URL(`https://api.gocardless.com/${resource}`);url.searchParams.set('limit','500');
      if(after)url.searchParams.set('after',after);
      const response=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(25000),
        headers:{Authorization:`Bearer ${credentials.accessToken}`,'GoCardless-Version':'2015-07-06'}});
      check(response.ok,`GoCardless GET failed HTTP ${response.status}`);
      const body=await response.json();
      check(Array.isArray(body[resource])&&Object.hasOwn(body.meta?.cursors||{},'after'),'Incomplete GoCardless pagination');
      for(const row of body[resource]){
        check(row?.id&&!seen.has(row.id),'Duplicate/missing GoCardless resource identity');seen.add(row.id);records.push(row);
      }
      after=body.meta.cursors.after;
      check(after===null||(typeof after==='string'&&after&&!cursors.has(after)&&body[resource].length),'Invalid GoCardless pagination cursor');
      if(after)cursors.add(after);
    }while(after!==null);
    discovery[resource]=records;
  }
  return {observedAt,completedAt:now().toISOString(),requests,discovery};
}

export function validateFreshProvider(saved,discovery,historical,today){
  const {memberId,customerId,mandateId}=saved.identity;
  const mandate=discovery.mandates.find(m=>m.id===mandateId),customer=discovery.customers.find(c=>c.id===customerId);
  const owned=discovery.mandates.filter(m=>m.links?.customer===customerId);
  const subscriptions=discovery.subscriptions.filter(s=>s.links?.mandate===mandateId);
  const payments=discovery.payments.filter(p=>p.links?.mandate===mandateId);
  check(owned.length===1&&mandate?.status==='active'&&mandate.links?.customer===customerId
    &&mandate.links?.creditor==='CR0000B50W1Y2R'&&customer,'Fresh active mandate ownership mismatch');
  check(!subscriptions.length,'Alpha provider subscriptions exist');
  check(/^\d{4}-\d{2}-\d{2}$/.test(mandate.next_possible_charge_date||'')
    &&mandate.next_possible_charge_date>=today&&mandate.next_possible_charge_date<='2026-10-08','Alpha provider earliest date conflict');
  check(!alphaPaymentHistoryRequiresReconciliation({memberId,customerId,mandateId},payments,
    historical.filter(h=>h.member_id===memberId)),'Alpha provider payment history/future schedule requires reconciliation');
  return {mandate,customer,subscriptions,payments,mandateCount:owned.length};
}

export function validateExceptionSnapshot(cached,snapshot,handover,completedAt){
  validateAlphaReleaseScope(cached.manifest,snapshot.adoptions);
  validateAlphaBankApproval(handover,cached.members.map(m=>m.memberId),new Date(completedAt));
  check(!snapshot.collisions.length,'Canonical duplicate payment/reservation exists');
  check(snapshot.xeroIdentity?.length===1&&snapshot.xeroIdentity[0].app_tenant_id===TENANT_ID
    &&snapshot.xeroIdentity[0].tenant_id===ALPHA_XERO_TENANT_ID,'Pinned local Xero tenant identity changed');
  check(same(sorted(snapshot.settings).map(withoutAudit),sorted(cached.settings).map(withoutAudit))
    &&same(snapshot.provider,cached.provider),'Approved accounting configuration changed');
  const canonical=snapshot.adoptions.map(a=>({adoption_id:a.id,
    plan:snapshot.state.membership_payment_plans.find(p=>p.id===a.plan_id),
    agreement:snapshot.state.membership_billing_agreements.find(b=>b.id===a.agreement_id),
    history:snapshot.state.member_membership_history.find(h=>h.id===a.history_id),
    member:snapshot.state.member.find(m=>m.id===a.member_id)}));
  const held=prepareAlphaRelease({manifest:cached.manifest,adoptions:snapshot.adoptions,
    historical:snapshot.historical,links:snapshot.links,canonical,handover,observedAt:completedAt,completedAt});
  check(held.members.every(m=>!m.blockers.length),'Canonical Alpha hold/state changed');
  check(snapshot.state.preference_field.length===1,'Current member class field ambiguous');
  for(const {member:m} of canonical){
    check(!m.is_deleted&&!m.deleted_at&&!m.membership_paused&&!['deleted','cancelled','paused'].includes(m.status),'Member unavailable');
    for(const table of ['membership_payment_plans','membership_billing_agreements','member_membership_history'])
      check(snapshot.state[table].filter(r=>r.member_id===m.id).length===1,'Additional canonical member records');
    const saved=cached.manifest.members.find(s=>s.identity.memberId===m.id);
    const preferences=snapshot.state.member_preference_value.filter(r=>r.member_id===m.id&&r.field_id===snapshot.state.preference_field[0].id);
    check(preferences.length===1&&preferences[0].value===saved.structure.structure_match_value,'Member class changed');
    // Two original approved mappings already have differing member/provider
    // emails. Preserve their immutable owner links; do not invent a new match.
    // New identity enrichments below separately require exact source email.
    const previouslyVerified=cached.state.member.find(old=>old.id===m.id);
    check(norm(m.email)&&norm(m.email)===norm(previouslyVerified?.email),'Current member email changed from verified owner');
  }
  const identityChanges=reviewNewAlphaIdentityBindings(cached,snapshot.identity.current,snapshot.identity.bindings);
  check(identityChanges.every(r=>!r.blockers.length),'Global identity tenant/member ownership mismatch');
  check(hash({historical:sorted(snapshot.historical),links:sorted(snapshot.links)})===cached.historicalHash,'Historical evidence changed');
  return {canonical,identityChanges};
}

export async function prepareExceptionEvidence(c,db){
  const {cached,renewalSource}=await readApprovedCachedEvidence();
  const handover=JSON.parse(await readFile(HANDOVER_PATH,'utf8'));
  const proof=await verifyExceptionSources();
  await alphaReleaseManifest(cached,proof);
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let snapshot,startedAt;
  try{
    await c.query("SET LOCAL timezone='UTC'");
    startedAt=(await c.query('SELECT clock_timestamp() t')).rows[0].t.toISOString();
    await verifyAlphaReleaseSchema(c);
    check((await c.query('SELECT count(*)::int n FROM bnms_dd_alpha_release')).rows[0].n===0,
      'Alpha journal already populated; use immutable replay or reconcile');
    snapshot=await readExceptionSnapshot(c,cached.members.map(m=>m.memberId));
    await c.query('ROLLBACK');
  }catch(e){await c.query('ROLLBACK');throw e;}
  const {canonical,identityChanges}=validateExceptionSnapshot(cached,snapshot,handover,new Date().toISOString());
  const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
  const gc=await readFreshExceptionGoCardless(await getTenantGocardlessCredentials(TENANT_ID,{db}));
  const {resolveDynamicCollectionPrice}=await import('../api/_lib/gocardlessDynamicCollections.js');
  const members=[];
  for(const original of cached.members){
    const saved=cached.manifest.members.find(m=>m.identity.memberId===original.memberId);
    const agreement=canonical.find(a=>a.member.id===original.memberId).agreement;
    const price=await resolveDynamicCollectionPrice(agreement,'2026-10-01',{db});
    check(same(price,original.price)&&price.monthly_amount_minor===saved.monthlyQuoteMinor,
      'Current consent-aware price differs from approved economic evidence');
    const provider=validateFreshProvider(saved,gc.discovery,snapshot.historical,gc.observedAt.slice(0,10));
    check(norm(provider.customer.email)===norm(original.provider.customer.email),
      'Fresh GoCardless customer email differs from verified provider owner');
    members.push({...original,price,provider});
  }
  assertAlphaManualEvidence(members);
  check(members.reduce((sum,m)=>sum+m.price.monthly_amount_minor,0)===303342,'Exact Alpha monthly total differs');
  const audit={approval:structuredClone(APPROVAL),approvalSha256:APPROVAL_HASH,actor:'user',
    recordedAt:new Date().toISOString(),fullAlphaReadinessComplete:false,
    deploymentReport:structuredClone(DEPLOYMENT_REPORT),deploymentReportSha256:DEPLOYMENT_HASH,
    verifiedSourceHashes:proof.sourceHashes,implementationHashes:await exceptionImplementationHashes(),
    agedXero:{path:CACHED_REPORT_PATH,sha256:CACHED_REPORT_SHA256,observedAt:cached.observedAt,
      completedAt:cached.completedAt,freshness:'AGED_EXPLICITLY_WAIVED',approvedRenewal:renewalSource},
    knownRisks:['Xero contacts, accounts, invoices and authenticated connection were not refreshed; changed Xero state may exist.',
      'User production/cron observation is aged and not independently live-verified; deployment or cron state may have changed.'],
    nonXeroStage:{manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:members.map(m=>m.memberId),
      observedAt:startedAt,completedAt:new Date().toISOString(),complete:true},
    goCardless:{observedAt:gc.observedAt,completedAt:gc.completedAt,requests:gc.requests,
      method:'GET',accountWideCursorExhausted:true,discoverySha256:hash(gc.discovery)},
    identityChanges,identityAuthorityWarningDisposition:'Separate security finding; not a payer conflict; no roles or authentication guards changed.',
    ownerEmailProvenance:'Member and provider emails each compared with their corresponding approved full-scan owner, not assumed interchangeable; immutable member/customer/mandate IDs remain exact.',
    processingNotBefore:PROCESSING_NOT_BEFORE,processingTimezone:'Europe/London',
    snapshotSha256:exceptionSnapshotHash(snapshot)};
  const report={...cached,mode:'operator_exception_not_full_fresh_readiness',fullAlphaReadinessComplete:false,
    state:snapshot.state,stateHash:alphaStateHash(snapshot.state),members,handover};
  // report.observedAt remains the original OLD Xero time, never fake-fresh.
  validateExceptionAudit(audit,members.map(m=>m.memberId));
  return {report,proof,audit,snapshot};
}

export async function exceptionManifest(e){
  const {report,proof,audit,snapshot}=e;
  check(audit.approvalSha256===APPROVAL_HASH&&hash(audit.approval)===APPROVAL_HASH
    &&same(audit.verifiedSourceHashes,proof.sourceHashes),'Exception approval/source integrity mismatch');
  check(audit.snapshotSha256===exceptionSnapshotHash(snapshot)&&report.stateHash===alphaStateHash(snapshot.state),
    'Exception snapshot integrity mismatch');
  check(report.fullAlphaReadinessComplete===false&&report.observedAt===audit.agedXero.observedAt
    &&report.completedAt===audit.agedXero.completedAt,'Aged Xero timestamps must remain unchanged');
  const economic=await alphaReleaseManifest(report,proof);
  check(economic.members.reduce((sum,m)=>sum+m.price.monthly_amount_minor,0)===303342,'Exact Alpha monthly total differs');
  // Review hash describes economic scope, not refresh timestamps. Apply repeats
  // provider checks and journals the actual new observation/digest immutably.
  const reviewSha256=hash({economic,approvalSha256:APPROVAL_HASH,deploymentReportSha256:DEPLOYMENT_HASH,
    implementationHashes:audit.implementationHashes,
    agedXero:audit.agedXero,identityChanges:audit.identityChanges,snapshotSha256:audit.snapshotSha256});
  return {economic,reviewSha256,journalSha256:hash({reviewSha256,audit})};
}

export async function releaseOperatorException(c,e,{apply=false,reviewSha256}={}){
  const prepared=await exceptionManifest(e),{report,proof,audit,snapshot}=e;
  check(!apply||reviewSha256===prepared.reviewSha256,'Exact independently reviewed exception hash required');
  const journalEvidence=m=>({...m,production:proof,handover:report.handover,
    readinessObservedAt:report.observedAt,operatorRiskAcceptance:{...audit,reviewSha256:prepared.reviewSha256}});
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    await c.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-scheduled-release'))");
    await verifyAlphaReleaseSchema(c);
    const prior=(await c.query('SELECT * FROM bnms_dd_alpha_release')).rows;
    if(prior.length){
      check(prior.length===249&&prior.every(p=>p.tenant_id===TENANT_ID&&p.evidence_sha256===prepared.journalSha256
        &&prepared.economic.members.some(m=>m.adoptionId===p.adoption_id&&m.memberId===p.member_id&&m.planId===p.plan_id
          &&same(p.evidence,journalEvidence(m)))),'Partial/different Alpha release requires reconciliation');
      await c.query('ROLLBACK');return {mode:'exception_release_replay',writes:0,reviewSha256:prepared.reviewSha256};
    }
    const fresh=async()=>{
      const now=new Date((await c.query('SELECT clock_timestamp() t')).rows[0].t);
      validateExceptionAudit(audit,report.members.map(m=>m.memberId),now);
      validateAlphaBankApproval(report.handover,report.members.map(m=>m.memberId),now);
    };
    await fresh();
    check(same(await verifyExceptionSources(),proof),'Deployment source proof changed');
    check(same(await exceptionImplementationHashes(),audit.implementationHashes),'Reviewed exception implementation changed');
    await c.query(`LOCK TABLE member,tenant_identity,tenant_membership,preference_field,member_preference_value,membership_tier_config,
      membership_billing_agreements,membership_payment_plans,member_membership_history,
      gocardless_collection_reservations,gocardless_payments,system_settings,tenant_accounting_settings,xero_token,membership_tier_vat_override,
      bnms_dd_alpha_adoption,bnms_dd_alpha_provider_history,bnms_dd_alpha_invoice_link IN SHARE ROW EXCLUSIVE MODE`);
    const current=await readExceptionSnapshot(c,report.members.map(m=>m.memberId));
    check(exceptionSnapshotHash(current)===exceptionSnapshotHash(snapshot),'Concurrent canonical/identity/accounting state change');
    const {cached,renewalSource}=await readApprovedCachedEvidence();
    check(same(audit.agedXero.approvedRenewal,renewalSource)
      &&audit.agedXero.observedAt===cached.observedAt&&audit.agedXero.completedAt===cached.completedAt,
      'Aged source provenance was altered');
    validateExceptionSnapshot(cached,current,report.handover,new Date().toISOString());
    for(const member of report.members){
      const saved=report.manifest.members.find(s=>s.identity.memberId===member.memberId);
      check(member.price.monthly_amount_minor===saved.monthlyQuoteMinor,'Approved Alpha price changed');
      validateFreshProvider(saved,{mandates:[member.provider.mandate],
        customers:[member.provider.customer],subscriptions:member.provider.subscriptions,payments:member.provider.payments},
      current.historical,audit.goCardless.observedAt.slice(0,10));
      const original=cached.members.find(m=>m.memberId===member.memberId);
      check(same(member.price,original.price),'Reviewed consent-aware price evidence changed');
      check(member.provider.mandateCount===1&&norm(member.provider.customer.email)===norm(original.provider.customer.email),
        'Provider owner evidence mismatch');
    }
    assertAlphaManualEvidence(report.members);
    assertHistoricalInvoicesComplete(current.historical,current.links);
    await fresh();
    if(!apply){
      await c.query('ROLLBACK');return {mode:'operator_exception_dry_run_not_full_readiness',writes:0,
        reviewSha256:prepared.reviewSha256,journalSha256:prepared.journalSha256,members:249,monthlyTotalGBP:3033.42,held:249};
    }
    for(const m of prepared.economic.members){
      await c.query(`INSERT INTO bnms_dd_alpha_release(adoption_id,tenant_id,member_id,plan_id,evidence_sha256,evidence)
        VALUES($1,$2,$3,$4,$5,$6)`,[m.adoptionId,TENANT_ID,m.memberId,m.planId,prepared.journalSha256,journalEvidence(m)]);
      const agreement=await c.query(`UPDATE membership_billing_agreements SET status='first_payment_pending',needs_attention=false,attention_reason=NULL,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3 AND status='first_payment_pending'`,[m.agreementId,TENANT_ID,m.memberId]);
      const plan=await c.query(`UPDATE membership_payment_plans SET collection_stopped_at=NULL,metadata=jsonb_set(metadata,'{bnms_release_required}','false'),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3 AND collection_stopped_at IS NOT NULL
        AND metadata->>'bnms_release_required'='true'`,[m.planId,TENANT_ID,m.memberId]);
      check(agreement.rowCount===1&&plan.rowCount===1,'Concurrent Alpha release CAS conflict');
    }
    await fresh();await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('COMMIT');
    return {mode:'operator_exception_alpha_armed',writes:747,providerWrites:0,
      reviewSha256:prepared.reviewSha256,journalSha256:prepared.journalSha256,membershipActivated:false};
  }catch(error){await c.query('ROLLBACK');throw error;}
}