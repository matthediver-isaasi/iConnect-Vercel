import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BETA_XERO_EVIDENCE_SHA256,validateBetaXeroException,assertBetaXeroAudit,assertBetaPriorXeroMember} from './bnms-dd-beta-xero-exception.mjs';
import {readBetaReleaseEvidence,readBetaFreshProviderEvidence,betaReleaseManifest,assertBetaReleaseReplay} from './bnms-dd-beta-release.mjs';
import {parseBetaReleaseArgs} from './run-bnms-dd-beta-release.mjs';
import {fingerprint} from './bnms-dd-pilot-history.mjs';
import {TENANT_ID,BATCH_HASH} from './bnms-dd-beta-invoices.mjs';
const path='/tmp/bnms-beta-local-attestation-okqbHV/readiness-validated.json';
let raw;try{raw=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const original=raw?JSON.parse(raw):null,now=new Date('2026-10-01T11:32:00.000Z');
const approval=()=>({version:1,tenantId:TENANT_ID,batchHash:BATCH_HASH,evidenceSha256:BETA_XERO_EVIDENCE_SHA256,
  memberIds:original.report.members.map(m=>m.memberId),approval:'prior_verified_evidence',oneOff:true,
  laterXeroChangesUncheckedAccepted:true,confirmedBy:'current user',approvedOn:'2026-10-01',approvalTimePrecision:'date-only',
  confirmedAtLowerBound:'2026-10-01T00:00:00.000Z',recordedAt:'2026-10-01T11:31:00.000Z',
  reason:'Explicit one-off acceptance of unchecked later Xero changes',evidenceReference:'Mock test approval'});
test('xero exception CLI is paired, explicit and never accepted for schema or replay',()=>{
  const base=['--out','/tmp/test','--proof','/tmp/proof'];
  assert.equal(parseBetaReleaseArgs(base)['xero-evidence'],undefined);
  assert.equal(parseBetaReleaseArgs([...base,'--xero-evidence','e','--xero-exception','a'])['xero-evidence'],'e');
  for(const args of [[...base,'--xero-evidence','e'],[...base,'--xero-exception','a'],
    ['--schema','--xero-evidence','e','--xero-exception','a'],
    [...base,'--replay','old',`--review-sha256=${'a'.repeat(64)}`,'--xero-evidence','e','--xero-exception','a']])
    assert.throws(()=>parseBetaReleaseArgs(args));
});
test('xero exception pins authentic immutable artifact, approval, cohort and original time',{skip:!raw},()=>{
  const {audit}=validateBetaXeroException(raw,approval(),{now});
  assert.equal(audit.priorObservedAt,original.report.observedAt);
  assert.equal(audit.priorCompletedAt,original.report.completedAt);
  assert.equal(audit.liveXeroRevalidated,false);
  for(const mutate of [
    s=>s.report.globalBlockers.push('unresolved'),s=>s.report.members.pop(),
    s=>s.report.members[0].accounting.bankAccountId='wrong',
    s=>s.report.members[0].accounting.revenueCode='wrong',s=>s.report.tenantId='wrong',
    s=>s.report.members[0].historicalInvoiceCount++,s=>s.result.mode='beta_readiness_stopped',
  ]){const changed=structuredClone(original);mutate(changed);assert.throws(()=>validateBetaXeroException(JSON.stringify(changed),approval(),{now}));}
  for(const patch of [{oneOff:false},{memberIds:[]},{laterXeroChangesUncheckedAccepted:false},
    {evidenceSha256:'a'.repeat(64)},{recordedAt:'2026-10-01T12:00:00Z'},{approvedOn:'2026-09-30'}])
    assert.throws(()=>validateBetaXeroException(raw,{...approval(),...patch},{now}));
  assert.throws(()=>validateBetaXeroException(raw,approval(),{now:new Date('2026-10-02T00:00:00Z')}));
  assert.throws(()=>assertBetaXeroAudit({...audit,priorObservedAt:now.toISOString()},approval().memberIds,now));
});
test('xero exception rejects malformed evidence before any DB or provider requests',async()=>{
  let calls=0;
  await assert.rejects(readBetaReleaseEvidence({from(){calls++;throw Error('unexpected');}},
    {xeroException:{raw:'{}',approval:{}},transport:async()=>{calls++;},now:()=>now}),/prior-Xero/);
  assert.equal(calls,0);
  const source=readBetaReleaseEvidence.toString();
  assert.match(source,/tokens=priorXero\?null:await checked/);
  assert.match(source,/accounts=priorXero\?null:\(await xero\('Accounts'\)\)/);
  assert.match(source,/else if\(!priorXero\)/);
  assert.match(source,/if\(priorXero\)fail\('Live Xero request forbidden/);
});
test('xero exception does not cache GC evidence: all five fresh reads for every member',async()=>{
  const seen=[];
  const get=async(resource,query)=>{
    seen.push({resource,query});
    if(resource.includes('/'))return {[resource.split('/')[0]]:{id:resource.split('/')[1]}};
    return {[resource]:[],meta:{cursors:{after:null}}};
  };
  for(let n=0;n<10;n++)await readBetaFreshProviderEvidence(get,{mandate_id:`MD${n}`,customer_id:`CU${n}`});
  assert.equal(seen.length,50);
  for(const resource of ['mandates','subscriptions','payments'])assert.equal(seen.filter(x=>x.resource===resource).length,10);
  assert.ok(seen.every(x=>!x.resource.includes('xero')));
  assert.match(readBetaReleaseEvidence.toString(),/await readBetaFreshProviderEvidence\(get,a\)/);
});
test('xero exception audit changes reviewed hash and immutable replay evidence',{skip:!raw},()=>{
  const {audit}=validateBetaXeroException(raw,approval(),{now});
  const report={...original.report,xeroException:audit},proof=original.proof;
  const manifest=betaReleaseManifest(report,proof),hash=fingerprint(manifest);
  assert.notEqual(hash,original.result.hash);
  const prior=manifest.members.map(m=>({adoption_id:m.adoptionId,member_id:m.memberId,plan_id:m.planId,evidence_sha256:hash,
    evidence:{...m,production:proof,handover:report.handover,readinessObservedAt:report.observedAt,xeroException:audit}}));
  assertBetaReleaseReplay(prior,manifest,hash,report,proof);
  const changed=structuredClone(prior);delete changed[0].evidence.xeroException;
  assert.throws(()=>assertBetaReleaseReplay(changed,manifest,hash,report,proof));
  assert.throws(()=>assertBetaPriorXeroMember(original.report.members[0],{},[],0,'wrong'));
  assertBetaXeroAudit(audit,report.members.map(m=>m.memberId)); // readonly replay does not re-age
});