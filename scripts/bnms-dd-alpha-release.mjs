// Preparation only: no arming, SQL mutation, provider writes or runtime fallback.
import { hash, assertHistoricalInvoicesComplete } from './bnms-dd-beta-invoices.mjs';
import { TENANT_ID } from './bnms-dd-pilot.mjs';

export const ALPHA_MANIFEST_SHA256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a';
export const PROCESSING_NOT_BEFORE='2026-09-30T23:00:00Z';
export const MAX_EVIDENCE_AGE_MS=15*60*1000;
const fail=message=>{throw Error(message);};
const same=(a,b)=>hash(a)===hash(b);

export function validateAlphaReleaseScope(manifest,adoptions){
  if(hash(manifest)!==ALPHA_MANIFEST_SHA256||manifest.tenantId!==TENANT_ID
    ||manifest.members.length!==249||manifest.exceptions.length!==170
    ||adoptions.length!==249)fail('Exact immutable 249-member alpha scope required');
  for(const key of ['id','member_id','mandate_id','customer_id','plan_id','agreement_id','history_id']){
    if(adoptions.some(a=>!a[key])||new Set(adoptions.map(a=>a[key])).size!==249)fail(`Alpha duplicate/missing ${key}`);
  }
  for(const a of adoptions){
    const m=manifest.members.find(m=>m.identity.memberId===a.member_id);
    if(!m||a.tenant_id!==TENANT_ID||a.manifest_sha256!==ALPHA_MANIFEST_SHA256
      ||a.evidence_sha256!==hash(m)||!same(a.evidence,m)
      ||a.mandate_id!==m.identity.mandateId||a.customer_id!==m.identity.customerId
      ||a.plan_id!==m.ids.plan||a.agreement_id!==m.ids.agreement||a.history_id!==m.ids.membership
      ||a.id!==m.ids.adoption)fail('Alpha adoption identity/provenance drift');
  }
}

// A staged scan never acquires a new observation time on resume. Final arming
// must use the oldest actual read, including subsequent lock/transaction time.
export function assertAlphaStageFresh(stages,memberIds,instant=new Date()){
  const ids=stages.flatMap(s=>s.memberIds||[]);
  if(!same([...ids].sort(),[...memberIds].sort())||new Set(ids).size!==ids.length)
    fail('Complete non-overlapping alpha evidence stages required');
  const now=instant.getTime();
  if(!Number.isFinite(now)||!stages.length)fail('Valid evidence clock required');
  for(const stage of stages){
    const start=Date.parse(stage.observedAt),end=Date.parse(stage.completedAt);
    if(stage.manifestSha256!==ALPHA_MANIFEST_SHA256||stage.complete!==true
      ||!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now
      ||now-start>MAX_EVIDENCE_AGE_MS)fail('Oldest alpha evidence exceeds 15 minutes or is incomplete');
  }
}

export function validateAlphaHandover(handover,memberIds,instant=new Date()){
  const confirmed=Date.parse(handover?.confirmedAt),now=instant.getTime();
  if(handover?.tenantId!==TENANT_ID||handover.manifestSha256!==ALPHA_MANIFEST_SHA256
    ||handover.automaticLegacyCollectionsDisabled!==true
    ||typeof handover.confirmedBy!=='string'||!handover.confirmedBy.trim()
    ||typeof handover.evidenceReference!=='string'||!handover.evidenceReference.trim()
    ||!Array.isArray(handover.memberIds)||!same([...handover.memberIds].sort(),[...memberIds].sort())
    ||!Number.isFinite(now)||!Number.isFinite(confirmed)||confirmed>now||now-confirmed>86400000)
    fail('Fresh exact-alpha legacy collector handover required; beta confirmation is not alpha approval');
}

export function prepareAlphaRelease({manifest,adoptions,historical,links,canonical,handover=null,observedAt,completedAt}){
  validateAlphaReleaseScope(manifest,adoptions);
  if(historical.length!==2137||links.length!==2137)fail('Exact 2137 historical alpha invoice links required');
  assertHistoricalInvoicesComplete(historical,links);
  const globalBlockers=[
    'Alpha accounting destination approval has not been granted',
    'Fresh complete provider and Xero readiness evidence required',
    'Independently reviewed scheduled-release migration and runtime adapter required',
    'Matching active deployed worker/accounting source proof required',
  ];
  try{validateAlphaHandover(handover,adoptions.map(a=>a.member_id),new Date(completedAt));}
  catch(error){globalBlockers.push(error.message);}
  const members=adoptions.map(a=>{
    const m=manifest.members.find(m=>m.identity.memberId===a.member_id);
    const rows=canonical.filter(r=>r.adoption_id===a.id),blockers=[];
    if(rows.length!==1)fail('Canonical alpha identity missing/ambiguous');
    const {plan:p,agreement:b,history:h,member}=rows[0];
    for(const r of [p,b,h,member]){
      if(!r||r.tenant_id!==TENANT_ID||(r===member?r.id:r.member_id)!==a.member_id)
        fail('Cross-tenant/member alpha canonical identity');
    }
    if(p.id!==a.plan_id||b.id!==a.agreement_id||h.id!==a.history_id
      ||p.billing_agreement_id!==b.id||h.billing_agreement_id!==b.id
      ||p.gocardless_mandate_id!==a.mandate_id||b.gocardless_mandate_id!==a.mandate_id
      ||b.gocardless_customer_id!==a.customer_id||p.environment!=='live'||b.environment!=='live'
      ||p.provider!=='gocardless'||b.provider!=='gocardless'||!same(b.metadata?.dd,m.dd))
      fail('Alpha canonical ownership or immutable consent drift');
    if(!p.collection_stopped_at||p.metadata?.bnms_release_required!==true||p.metadata?.bnms_alpha_held!==true
      ||p.status!=='first_payment_pending'||b.status!=='first_payment_pending'
      ||h.status!=='pending_payment_setup'||h.payment_status!=='unpaid'
      ||p.gocardless_subscription_id||p.dynamic_next_collection_date!=='2026-10-01')
      blockers.push('Canonical alpha hold/state drift');
    const stored=historical.filter(r=>r.adoption_id===a.id);
    if(stored.length!==m.history.length||stored.some(r=>r.member_id!==a.member_id||r.tenant_id!==TENANT_ID
      ||!m.history.some(e=>e.id===r.id&&same(e.evidence,r.evidence))))
      fail('Immutable alpha historical provider evidence drift');
    const invoiceLinks=links.filter(r=>r.member_id===a.member_id);
    if(!same([...invoiceLinks].sort((a,b)=>a.history_id.localeCompare(b.history_id)),
      [...m.links].sort((a,b)=>a.history_id.localeCompare(b.history_id))))fail('Immutable alpha Xero links drift');
    return {memberId:a.member_id,adoptionId:a.id,planId:a.plan_id,mandateId:a.mandate_id,
      customerId:a.customer_id,held:!blockers.length,blockers};
  });
  return {version:1,mode:'alpha_release_preparation_only',tenantId:TENANT_ID,
    manifestSha256:ALPHA_MANIFEST_SHA256,observedAt,completedAt,
    processingNotBefore:PROCESSING_NOT_BEFORE,providerChargeDate:'Fresh provider date; existing seven-day safety window',
    members,excludedExceptions:170,historicalInvoiceCount:2137,globalBlockers,
    releasable:false,writes:0,providerWrites:0};
}

// Bounded staging stops rather than hiding 429s or resetting the freshness clock.
// Callers persist checkpoints privately; a completed earlier stage can only be
// reused while its original timestamps still satisfy assertAlphaStageFresh.
export async function readAlphaStage(memberIds,readMember,{now=()=>new Date(),maxMembers=25}={}){
  if(!Number.isInteger(maxMembers)||maxMembers<1||maxMembers>25
    ||!memberIds.length||memberIds.length>maxMembers||new Set(memberIds).size!==memberIds.length)
    fail('A stage requires 1–25 unique members');
  const observedAt=now().toISOString(),evidence=[];
  for(const memberId of memberIds){
    if(now().getTime()-Date.parse(observedAt)>MAX_EVIDENCE_AGE_MS)
      return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt:now().toISOString(),
        complete:false,evidence,blocker:'Evidence budget exhausted; refresh oldest stage'};
    try{evidence.push({memberId,evidence:await readMember(memberId)});}
    catch(error){
      return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt:now().toISOString(),
        complete:false,evidence,blocker:error?.status===429?'Provider rate limit; resume only with fresh evidence':'Provider evidence read failed'};
    }
  }
  const completedAt=now().toISOString();
  return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt,
    complete:Date.parse(completedAt)-Date.parse(observedAt)<=MAX_EVIDENCE_AGE_MS,evidence};
}