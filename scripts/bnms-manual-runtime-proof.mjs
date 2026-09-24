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

// This validates independently supplied evidence, never manufactures proof of a
// deployment from local files, dates, old cron trust or an Alpha attestation.
// The whole evidence document must also be part of the parent's reviewed hash.
export function assertManualRuntimeProof(proof,expectedHashes,now=new Date()){
 const reject=reason=>{throw Error(`MANUAL_RUNTIME_DEPLOYMENT_REQUIRED: ${reason}`);};
 if(!proof)reject('new manual-aware production runtime proof missing');
 if(proof.version!==1||!['explicit_user_attestation','verified_deployment'].includes(proof.kind)
   ||proof.cohort!=='bnms_manual_95'||proof.tenantId!==MANUAL_TENANT
   ||proof.workbookSha256!==MANUAL_WORKBOOK||proof.destinationProject!=='lvmzliemqnieeoruhkik'
   ||proof.environment!=='production')reject('unknown or wrong deployment scope');
 if(!proof.runtimeSourceHashes||typeof proof.runtimeSourceHashes!=='object'
   ||hash(proof.runtimeSourceHashes)!==hash(expectedHashes)
   ||proof.runtimeSha256!==hash(expectedHashes))reject('reviewed manual runtime source hashes differ');
 if(hash([...(proof.capabilities||[])].sort())!==hash([...MANUAL_RUNTIME_CAPABILITIES].sort()))
  reject('worker, webhook, accounting and recognition deployment coverage required');
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