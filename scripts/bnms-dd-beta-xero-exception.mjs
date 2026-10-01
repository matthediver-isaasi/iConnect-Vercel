// One explicitly approved, digest-pinned prior-Xero exception. No network IO.
import {createHash} from 'node:crypto';
import {TENANT_ID,BATCH_HASH,XERO_TENANT_ID} from './bnms-dd-beta-invoices.mjs';
import {fingerprint} from './bnms-dd-pilot-history.mjs';
import {BNMS_BETA_REVENUE,assertBnmsBetaAccountingContext} from '../api/_lib/bnmsBetaAccounting.js';
export const BETA_XERO_EVIDENCE_SHA256='87912421607ddb5ca5b8840a9b703bd7be1803c5f20546c96170ebe3fa38cedf';
export const BETA_XERO_REVIEW_HASH='8790a95564c8b1deec32c7d1f8746aa3c975be220a97f6cc2314769bfe9497f4';
const ids=Object.keys(BNMS_BETA_REVENUE).sort();
const fail=()=>{throw Error('Explicit pinned beta prior-Xero exception invalid or expired');};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
export function assertBetaXeroAudit(audit,memberIds,instant){
  const a=audit?.approval;
  if(audit?.kind!=='explicit-user-approved-prior-xero-evidence'
    ||audit.evidenceSha256!==BETA_XERO_EVIDENCE_SHA256||audit.priorReviewHash!==BETA_XERO_REVIEW_HASH
    ||audit.priorObservedAt!=='2026-10-01T11:08:55.615Z'||audit.priorCompletedAt!=='2026-10-01T11:09:18.066Z'
    ||audit.liveXeroRevalidated!==false||audit.laterXeroChangesUnchecked!==true
    ||!a||a.version!==1||a.tenantId!==TENANT_ID||a.batchHash!==BATCH_HASH
    ||a.evidenceSha256!==BETA_XERO_EVIDENCE_SHA256||a.approval!=='prior_verified_evidence'
    ||a.oneOff!==true||a.laterXeroChangesUncheckedAccepted!==true
    ||a.confirmedBy!=='current user'||a.approvedOn!=='2026-10-01'||a.approvalTimePrecision!=='date-only'
    ||a.confirmedAtLowerBound!=='2026-10-01T00:00:00.000Z'
    ||typeof a.reason!=='string'||!a.reason.trim()||typeof a.evidenceReference!=='string'||!a.evidenceReference.trim()
    ||!Number.isFinite(Date.parse(a.recordedAt))||Date.parse(a.recordedAt)<Date.parse(a.confirmedAtLowerBound)
    ||!Array.isArray(a.memberIds)||!same([...a.memberIds].sort(),ids)||!same([...memberIds].sort(),ids)
    ||audit.approvalSha256!==fingerprint(a))fail();
  if(instant){
    const now=instant.getTime(),prior=Date.parse(audit.priorObservedAt),approved=Date.parse(a.confirmedAtLowerBound);
    if(!Number.isFinite(now)||now<Date.parse(a.recordedAt)||now<prior||now-prior>=86400000||now-approved>=86400000)fail();
  }
}
export function validateBetaXeroException(raw,approval,{now=new Date()}={}){
  if(createHash('sha256').update(raw).digest('hex')!==BETA_XERO_EVIDENCE_SHA256)fail();
  const saved=JSON.parse(raw),r=saved.report;
  if(saved.result?.mode!=='scheduled_beta_release_dry_run'||saved.result.hash!==BETA_XERO_REVIEW_HASH
    ||fingerprint(saved.result.manifest)!==BETA_XERO_REVIEW_HASH||saved.result.writes!==0
    ||r?.tenantId!==TENANT_ID||r.batchHash!==BATCH_HASH||r.globalBlockers?.length!==0
    ||r.members?.length!==10||!same(r.members.map(m=>m.memberId).sort(),ids)
    ||r.members.reduce((n,m)=>n+m.historicalInvoiceCount,0)!==221||r.provider?.active_provider!=='xero')fail();
  for(const key of ['memberId','adoptionId','planId','agreementId','historyId','mandateId','customerId']){
    if(r.members.some(m=>!m[key])||new Set(r.members.map(m=>m[key])).size!==10)fail();
  }
  for(const m of r.members){
    const mapping=assertBnmsBetaAccountingContext(TENANT_ID,{memberId:m.memberId,environment:'live',provider:'gocardless',snapshot:m.accounting?.mapping});
    if(m.blockers?.length!==0||m.futureInvoices?.length!==0||m.provider?.subscriptions?.length!==0
      ||m.provider?.payments?.some(p=>p.status!=='paid_out')||!m.accounting.contactId
      ||m.accounting.xeroTenantId!==XERO_TENANT_ID||m.accounting.bankAccountId!==mapping.bank_account_id
      ||m.accounting.revenueCode!==mapping.revenue_account_code||!/^[a-f0-9]{64}$/.test(m.adoptionHash))fail();
  }
  const audit={kind:'explicit-user-approved-prior-xero-evidence',evidenceSha256:BETA_XERO_EVIDENCE_SHA256,
    priorReviewHash:BETA_XERO_REVIEW_HASH,priorObservedAt:r.observedAt,priorCompletedAt:r.completedAt,
    liveXeroRevalidated:false,laterXeroChangesUnchecked:true,approval,approvalSha256:fingerprint(approval)};
  assertBetaXeroAudit(audit,r.members.map(m=>m.memberId),now);
  return {audit,report:r};
}
export function assertBetaPriorXeroMember(prior,a,contactIds,historicalCount,revenueCode){
  if(!prior||prior.adoptionHash!==fingerprint(a)||prior.memberId!==a.member_id
    ||prior.planId!==a.plan_id||prior.agreementId!==a.agreement_id||prior.historyId!==a.history_id
    ||prior.mandateId!==a.mandate_id||prior.customerId!==a.customer_id
    ||contactIds.length!==1||prior.accounting.contactId!==contactIds[0]
    ||prior.historicalInvoiceCount!==historicalCount||prior.accounting.revenueCode!==revenueCode)fail();
}