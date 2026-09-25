import {readFile} from 'node:fs/promises';
import {hash,sqlHash} from './bnms-dd-beta-invoices.mjs';
import {MANUAL_TENANT,MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';

export const MANUAL_RUNTIME_PATHS=[
 'api/_lib/bnmsManualCohort.js','api/_lib/directDebitDynamicPipeline.js',
 'api/_lib/directDebitConsoleEligibility.js','api/_lib/alphaMembershipRecognition.js',
 'api/_lib/directDebitMembershipPresentation.js','api/_lib/gocardlessAccounting.js','api/_lib/xero.js',
];
export const MANUAL_RUNTIME_CAPABILITIES=[
 'manual_95_recognition','manual_95_worker_gate','manual_95_exact_contact_accounting','manual_95_webhook_accounting',
];
export const manualRuntimeHashes=async()=>Object.fromEntries(await Promise.all(
 MANUAL_RUNTIME_PATHS.map(async p=>[p,sqlHash(await readFile(p))])));

export const MANUAL_DEPLOYMENT_EXCEPTION = {
 deploymentId:'dpl_6wqgYP1jUPm3EiFiZeG2LtRzsqu3',
 commit:'40fdfc8928a578200ef5b7c11740da477c0fd42b',
 runtimeSha256:'0e288fa6125400c7dd6850bfddc9cbf3d3a097fd58512a0d59a054efb696d3df',
 waived:['independent_deployment_timestamp','scoped_runtime_attestation'],
};

// This validates independently supplied evidence, never manufactures proof of a
// deployment from local files, dates, old cron trust or an Alpha attestation.
// The whole evidence document must also be part of the parent's reviewed hash.
export function assertManualRuntimeProof(proof,expectedHashes,now=new Date()){
 const reject=reason=>{throw Error(`MANUAL_RUNTIME_DEPLOYMENT_REQUIRED: ${reason}`);};
 if(!proof)reject('new manual-aware production runtime proof missing');
 if(proof.version!==1||!['explicit_user_attestation','verified_deployment','operator_deployment_evidence_exception'].includes(proof.kind)
   ||proof.cohort!=='bnms_manual_95'||proof.tenantId!==MANUAL_TENANT
   ||proof.workbookSha256!==MANUAL_WORKBOOK||proof.destinationProject!=='lvmzliemqnieeoruhkik'
   ||proof.environment!=='production')reject('unknown or wrong deployment scope');
 if(!proof.runtimeSourceHashes||typeof proof.runtimeSourceHashes!=='object'
   ||hash(proof.runtimeSourceHashes)!==hash(expectedHashes)
   ||proof.runtimeSha256!==hash(expectedHashes))reject('reviewed manual runtime source hashes differ');
 if(hash([...(proof.capabilities||[])].sort())!==hash([...MANUAL_RUNTIME_CAPABILITIES].sort()))
  reject('worker, webhook, accounting and recognition deployment coverage required');
 if(proof.kind==='operator_deployment_evidence_exception'){
  const e=MANUAL_DEPLOYMENT_EXCEPTION,r=proof.operatorReport;
  if(proof.runtimeSha256!==e.runtimeSha256||proof.deploymentId!==e.deploymentId
   ||proof.deployedAt!==null||proof.verificationStatus!=='operator_report_not_independently_verified'
   ||proof.riskAccepted!==true||!proof.authorizationReference?.trim()
   ||!proof.assertedBy?.trim()||!proof.evidenceReference?.trim()
   ||hash(proof.waivedChecks)!==hash(e.waived)||proof.statement!==null)
   reject('exact operator exception and honest unknown deployment metadata required');
  if(r?.observedAt!=='2026-09-25T15:40:31.222790+00:00'
   ||proof.observedAt!==r.observedAt||Date.parse(r.observedAt)>now.getTime()
   ||r.teamId!=='team_6nULXm5hUGvUCNwvc7Axz6GF'||r.configurationUnchangedDuringCheck!==true
   ||r.productionDeployment?.id!==e.deploymentId||r.productionDeployment?.state!=='READY'
   ||r.productionDeployment?.target!=='production'||r.productionDeployment?.gitSource?.sha!==e.commit
   ||r.productionDeployment?.projectId!=='prj_iPFlb9rOOVNVtbobMRR1vyV934lf')
   reject('pinned operator production observation required');
  for(const p of [r.projectBefore,r.projectAfter]){
   if(p?.id!==r.productionDeployment.projectId||p.productionDeploymentId!==e.deploymentId
    ||p.cronDeploymentId!==e.deploymentId||p.cronDisabledAtPresent!==true||p.cronDisabledAt!==null
    ||hash(p.goCardlessSchedules)!==hash([{path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}]))
    reject('unchanged pinned production and cron configuration required');
  }
  return proof;
 }
 const deployed=Date.parse(proof.deployedAt),observed=Date.parse(proof.observedAt);
 if(!Number.isFinite(deployed)||!Number.isFinite(observed)||deployed>observed||observed>now.getTime())
  reject('independently supplied deployment/observation timestamps required');
 if(typeof proof.assertedBy!=='string'||!proof.assertedBy.trim()
   ||typeof proof.evidenceReference!=='string'||!proof.evidenceReference.trim()
   ||typeof proof.deploymentId!=='string'||!proof.deploymentId.trim())
  reject('identified verifier, deployment and independent evidence reference required');
 if(proof.statement!==`The production worker, webhook accounting and membership readers run the BNMS manual-95 integration with runtime SHA256 ${hash(expectedHashes)}.`)
  reject('explicit new-integration deployment statement required; general worker trust is insufficient');
 return proof;
}