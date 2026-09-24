import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {MANUAL_TENANT,MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';
import {assertManualRuntimeProof,manualRuntimeHashes,MANUAL_RUNTIME_CAPABILITIES} from './bnms-manual-runtime-proof.mjs';
import {applyManualManifest} from './run-bnms-dd-manual-cohort.mjs';

test('new manual deployment evidence must exactly cover the reviewed runtime and production cohort',async()=>{
 const hashes=await manualRuntimeHashes();
 // Synthetic evidence only in this unit test; never persisted as real proof.
 const p={version:1,kind:'explicit_user_attestation',cohort:'bnms_manual_95',tenantId:MANUAL_TENANT,
  workbookSha256:MANUAL_WORKBOOK,destinationProject:'lvmzliemqnieeoruhkik',environment:'production',
  runtimeSourceHashes:hashes,runtimeSha256:hash(hashes),capabilities:MANUAL_RUNTIME_CAPABILITIES,
  deployedAt:'2026-09-24T00:00:00Z',observedAt:'2026-09-24T00:01:00Z',
  assertedBy:'fixture verifier',evidenceReference:'fixture-only evidence',deploymentId:'fixture-only deployment',
  statement:`The production worker, webhook accounting and membership readers run the BNMS manual-95 integration with runtime SHA256 ${hash(hashes)}.`};
 const now=new Date('2026-09-24T01:00:00Z');
 assert.equal(assertManualRuntimeProof(p,hashes,now),p);
 for(const bad of [null,{}, {...p,cohort:'alpha'}, {...p,kind:'existing_worker_trust'},
  {...p,runtimeSourceHashes:{...hashes,'api/_lib/xero.js':'old'}},
  {...p,runtimeSha256:'old'}, {...p,capabilities:['manual_95_worker_gate']},
  {...p,observedAt:'2026-09-25T00:00:00Z'}, {...p,evidenceReference:''},
  {...p,statement:'Existing cron is trusted'}]){
  assert.throws(()=>assertManualRuntimeProof(bad,hashes,now),/MANUAL_RUNTIME_DEPLOYMENT_REQUIRED/);
 }
 let queries=0;
 const c={query:async()=>{queries++;throw Error('Unexpected database access');}};
 await assert.rejects(applyManualManifest(c,{}, {schemas:[],now:()=>now,
  deploymentProof:{...p,runtimeSourceHashes:{...hashes,'api/_lib/xero.js':'old'}}}),
  /MANUAL_RUNTIME_DEPLOYMENT_REQUIRED: reviewed manual runtime source hashes differ/);
 await assert.rejects(applyManualManifest(c,{}, {schemas:[],now:()=>now,deploymentProof:p}),
  /Reviewed manifest deployment proof differs/);
 assert.equal(queries,0);
});

test('direct apply cannot begin a transaction with missing or old runtime evidence',async()=>{
 let queries=0;
 const c={query:async()=>{queries++;throw Error('No database access allowed');}};
 await assert.rejects(applyManualManifest(c,{}, {schemas:[]}),/manual-aware production runtime proof missing/);
 await assert.rejects(applyManualManifest(c,{}, {schemas:[],deploymentProof:{kind:'existing_worker_trust'}}),
  /unknown or wrong deployment scope/);
 assert.equal(queries,0);
});