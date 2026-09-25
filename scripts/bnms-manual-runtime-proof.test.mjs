import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {MANUAL_TENANT,MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';
import {assertManualRuntimeProof,manualRuntimeHashes,MANUAL_RUNTIME_CAPABILITIES,MANUAL_DEPLOYMENT_EXCEPTION} from './bnms-manual-runtime-proof.mjs';
import {applyManualManifest,safeManualFailure,insert} from './run-bnms-dd-manual-cohort.mjs';

test('actual insert helper permits hash columns, binds values and rejects unsafe identifiers',async()=>{
 const calls=[],c={query:async(...args)=>calls.push(args)};
 await insert(c,'bnms_dd_manual_manifest',{sha256:'a'.repeat(64),workbook_sha256:"value'); DROP TABLE member;--"});
 assert.equal(calls.length,1);
 assert.equal(calls[0][0],'INSERT INTO bnms_dd_manual_manifest (sha256,workbook_sha256) VALUES ($1,$2)');
 assert.equal(calls[0][1][1],"value'); DROP TABLE member;--");
 for(const [table,row]of [['member',{id:1}],['bnms_dd_manual_manifest',{ '0bad':1 }],
  ['bnms_dd_manual_manifest',{'sha256); DROP TABLE member;--':1}],['bnms_dd_manual_manifest',{}]]){
  await assert.rejects(insert(c,table,row),/Unsafe canonical insert/);
 }
 assert.equal(calls.length,1);
});

test('failure diagnostics expose only safe guard names and SQLSTATE',()=>{
 assert.equal(safeManualFailure(new Error('Live member drift')).reason,'Live member drift');
 const diagnostic=safeManualFailure({code:'23505',message:'private member/contact detail'});
 assert.equal(diagnostic.code,'23505');
 assert.ok(!JSON.stringify(diagnostic).includes('private member/contact detail'));
});

test('operator exception is pinned and never fabricates deployment verification',async()=>{
 const e=MANUAL_DEPLOYMENT_EXCEPTION,hashes=await manualRuntimeHashes();
 const project={id:'prj_iPFlb9rOOVNVtbobMRR1vyV934lf',productionDeploymentId:e.deploymentId,
  cronDeploymentId:e.deploymentId,cronDisabledAtPresent:true,cronDisabledAt:null,
  goCardlessSchedules:[{path:'/api/cron/reconcile-gocardless',schedule:'15 */6 * * *'}]};
 const report={observedAt:'2026-09-25T15:40:31.222790+00:00',teamId:'team_6nULXm5hUGvUCNwvc7Axz6GF',
  configurationUnchangedDuringCheck:true,projectBefore:project,projectAfter:project,
  productionDeployment:{id:e.deploymentId,projectId:project.id,state:'READY',target:'production',gitSource:{sha:e.commit}}};
 const p={version:1,kind:'operator_deployment_evidence_exception',cohort:'bnms_manual_95',
  tenantId:MANUAL_TENANT,workbookSha256:MANUAL_WORKBOOK,destinationProject:'lvmzliemqnieeoruhkik',
  environment:'production',runtimeSourceHashes:hashes,runtimeSha256:hash(hashes),
  capabilities:MANUAL_RUNTIME_CAPABILITIES,operatorReport:report,deployedAt:null,observedAt:report.observedAt,
  deploymentId:e.deploymentId,verificationStatus:'operator_report_not_independently_verified',riskAccepted:true,
  authorizationReference:'fixture operator risk acceptance',assertedBy:'fixture operator',evidenceReference:'fixture report',
  waivedChecks:e.waived,statement:null};
 const now=new Date('2026-09-25T16:00:00Z');
 assert.equal(assertManualRuntimeProof(p,hashes,now),p);
 for(const change of [{riskAccepted:false},{deployedAt:report.observedAt},{statement:'verified'},
  {waivedChecks:[...e.waived,'mandate_identity']},{runtimeSha256:'other'},{workbookSha256:'other'},
  {operatorReport:{...report,projectAfter:{...project,cronDeploymentId:'other'}}},
  {operatorReport:{...report,productionDeployment:{...report.productionDeployment,state:'BUILDING'}}}]){
  assert.throws(()=>assertManualRuntimeProof({...p,...change},hashes,now),/MANUAL_RUNTIME_DEPLOYMENT_REQUIRED/);
 }
});

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
 const statements=[],events=[];
 const timeout=Object.assign(new Error('private backend detail'),{code:'55P03'});
 const lockClient={query:async(sql)=>{
  statements.push(sql);
  if(sql.startsWith('SELECT pg_advisory_xact_lock'))throw timeout;
  return {rows:[]};
 }};
 await assert.rejects(applyManualManifest(lockClient,{runtimeDeployment:p},{
  schemas:[],deploymentProof:p,now:()=>now,onProgress:e=>events.push(e),
 }),e=>e===timeout);
 assert.ok(statements.includes("SET LOCAL lock_timeout='15s'"));
 assert.ok(statements.includes("SET LOCAL statement_timeout='60s'"));
 assert.ok(statements.includes("SET LOCAL application_name='bnms-manual-95-reviewed-release'"));
 assert.equal(statements.at(-1),'ROLLBACK');
 assert.equal(safeManualFailure(timeout).stage,'journal_lock');
 assert.equal(safeManualFailure(timeout).code,'55P03');
 assert.deepEqual(events.map(e=>e.stage),['journal_lock','rolled_back']);
 assert.ok(!JSON.stringify(safeManualFailure(timeout)).includes('private backend detail'));
});

test('direct apply cannot begin a transaction with missing or old runtime evidence',async()=>{
 let queries=0;
 const c={query:async()=>{queries++;throw Error('No database access allowed');}};
 await assert.rejects(applyManualManifest(c,{}, {schemas:[]}),/manual-aware production runtime proof missing/);
 await assert.rejects(applyManualManifest(c,{}, {schemas:[],deploymentProof:{kind:'existing_worker_trust'}}),
  /unknown or wrong deployment scope/);
 assert.equal(queries,0);
});