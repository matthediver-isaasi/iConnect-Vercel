import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {APPROVAL,DEPLOYMENT_REPORT,CACHED_REPORT_PATH,CACHED_REPORT_SHA256,RENEWAL_SHA256,
  validateExceptionAudit,validateFreshProvider,readFreshExceptionGoCardless,
  verifyExceptionSources} from './bnms-dd-alpha-operator-exception.mjs';
import {parseExceptionArgs} from './run-bnms-dd-alpha-operator-exception.mjs';
import {hash,sqlHash,TENANT_ID} from './bnms-dd-beta-invoices.mjs';
import {ALPHA_MANIFEST_SHA256,assertAlphaEvidenceFresh} from './bnms-dd-alpha-release.mjs';
import {assertUserAttestationFresh} from './bnms-dd-pilot-deployment-proof.mjs';
import {ALPHA_MANUAL_APPROVAL_SHA256} from './bnms-dd-alpha-manual-exceptions.mjs';

const now=new Date('2026-09-23T12:05:00Z'),ids=Array.from({length:249},(_,i)=>String(i));
const audit=()=>({approval:structuredClone(APPROVAL),approvalSha256:hash(APPROVAL),
  deploymentReport:structuredClone(DEPLOYMENT_REPORT),deploymentReportSha256:hash(DEPLOYMENT_REPORT),
  fullAlphaReadinessComplete:false,agedXero:{sha256:CACHED_REPORT_SHA256,observedAt:'2026-09-21T11:42:47.142Z',
    completedAt:'2026-09-21T11:50:00Z',freshness:'AGED_EXPLICITLY_WAIVED',
    approvedRenewal:{sha256:RENEWAL_SHA256,approvalSha256:ALPHA_MANUAL_APPROVAL_SHA256,
      observedAt:'2026-09-23T08:40:30.696Z',completedAt:'2026-09-23T08:40:31.109Z',freshness:'AGED_EXPLICITLY_WAIVED'}},
  nonXeroStage:{manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:ids,observedAt:'2026-09-23T12:04:00Z',
    completedAt:'2026-09-23T12:04:30Z',complete:true},
  goCardless:{requests:20,method:'GET',accountWideCursorExhausted:true,
    observedAt:'2026-09-23T12:04:05Z',completedAt:'2026-09-23T12:04:20Z'}});
test('exact two waivers accept genuinely aged Xero/deployment and fresh remaining observations',()=>{
  assert.doesNotThrow(()=>validateExceptionAudit(audit(),ids,now));
});
for(const [name,mutate] of [
  ['extra waiver',a=>a.approval.waivers.push('IDENTITY')],
  ['missing waiver',a=>a.approval.waivers.pop()],
  ['different tenant',a=>a.approval.tenantId='other'],
  ['bad approval digest',a=>a.approvalSha256='0'.repeat(64)],
  ['wrong deployed SHA',a=>a.deploymentReport.commit='0'.repeat(40)],
  ['bad deployment digest',a=>a.deploymentReportSha256='0'.repeat(64)],
  ['bad Xero digest',a=>a.agedXero.sha256='0'.repeat(64)],
  ['missing approved renewal',a=>delete a.agedXero.approvedRenewal],
  ['bad renewal digest',a=>a.agedXero.approvedRenewal.sha256='0'.repeat(64)],
  ['fake green',a=>a.fullAlphaReadinessComplete=true],
  ['fake fresh Xero',a=>a.agedXero.freshness='FRESH'],
  ['future Xero timestamp',a=>a.agedXero.completedAt='2026-09-24T00:00:00Z'],
  ['bad timestamp',a=>a.nonXeroStage.observedAt='invalid'],
  ['stale nonXero',a=>a.nonXeroStage.observedAt='2026-09-23T11:00:00Z'],
  ['future GC',a=>a.goCardless.completedAt='2026-09-24T00:00:00Z'],
  ['incomplete pagination',a=>a.goCardless.accountWideCursorExhausted=false],
  ['over budget',a=>a.goCardless.requests=21],
  ['provider POST',a=>a.goCardless.method='POST'],
  ['wrong cohort',a=>a.nonXeroStage.memberIds=ids.slice(1)],
  ['duplicates',a=>a.nonXeroStage.memberIds=ids.map(()=>ids[0])],
]){
  test(`rejects ${name}`,()=>{const a=audit();mutate(a);assert.throws(()=>validateExceptionAudit(a,ids,now));});
}
test('normal release freshness remains strict and rejects the same stale evidence',()=>{
  assert.throws(()=>assertAlphaEvidenceFresh({manifestSha256:ALPHA_MANIFEST_SHA256,
    observedAt:'2026-09-21T11:42:47.142Z',completedAt:'2026-09-21T11:50:00Z',members:ids.map(memberId=>({memberId}))},now),/15 minutes/);
  assert.throws(()=>assertUserAttestationFresh({provenance:{kind:'user-supplied-local-vercel-attestation',
    agentLiveVerified:false,attestationSha256:'a'.repeat(64),observedAt:DEPLOYMENT_REPORT.observedAt}},now),/15 minutes/);
});
const providerFixture=()=>({saved:{identity:{memberId:'m',mandateId:'MD',customerId:'CU'}},
  discovery:{mandates:[{id:'MD',status:'active',links:{customer:'CU',creditor:'CR0000B50W1Y2R'},
    next_possible_charge_date:'2026-09-25'}],customers:[{id:'CU'}],subscriptions:[],payments:[]},history:[]});
test('fresh correct owner/mandate with no payment or subscription passes',()=>{
  const f=providerFixture();assert.doesNotThrow(()=>validateFreshProvider(f.saved,f.discovery,f.history,'2026-09-23'));
});
for(const [name,mutate] of [
  ['inactive mandate',f=>f.discovery.mandates[0].status='cancelled'],
  ['wrong owner',f=>f.discovery.mandates[0].links.customer='other'],
  ['wrong creditor',f=>f.discovery.mandates[0].links.creditor='other'],
  ['second mandate',f=>f.discovery.mandates.push({...f.discovery.mandates[0],id:'MD2'})],
  ['subscription',f=>f.discovery.subscriptions.push({id:'SU',links:{mandate:'MD'}})],
  ['pending payment',f=>f.discovery.payments.push({id:'PM',status:'pending_submission',charge_date:'2026-09-23',links:{mandate:'MD'}})],
  ['future payment',f=>f.discovery.payments.push({id:'PM',status:'cancelled',charge_date:'2026-10-01',links:{mandate:'MD'}})],
  ['changed amount',f=>{f.discovery.payments.push({id:'PM',status:'paid_out',charge_date:'2026-09-01',amount:100,currency:'GBP',amount_refunded:0,links:{mandate:'MD'}});f.history.push({member_id:'m',provider_payment_id:'PM',amount_minor:101,charge_date:'2026-09-01',currency:'GBP'});}],
]){
  test(`fresh provider rejects ${name}`,()=>{const f=providerFixture();mutate(f);assert.throws(()=>validateFreshProvider(f.saved,f.discovery,f.history,'2026-09-23'));});
}
const credentials={source:'tenant',tenantId:TENANT_ID,environment:'live',accessToken:'test-only'};
test('bounded transport has only exact GC GET endpoints and cursor exhaustion',async()=>{
  const calls=[];
  const r=await readFreshExceptionGoCardless(credentials,{transport:async(url,opts)=>{
    calls.push(url.href);assert.equal(url.origin,'https://api.gocardless.com');assert.equal(opts.method,'GET');
    assert.equal(opts.redirect,'error');
    return {ok:true,json:async()=>({[url.pathname.slice(1)]:[],meta:{cursors:{after:null}}})};
  }});
  assert.equal(r.requests,4);assert.equal(calls.length,4);
});
test('transport stops at twenty without request twenty-one',async()=>{
  let calls=0;
  await assert.rejects(readFreshExceptionGoCardless(credentials,{transport:async url=>{
    calls++;return {ok:true,json:async()=>({[url.pathname.slice(1)]:[{id:String(calls)}],meta:{cursors:{after:String(calls)}}})};
  }}),/20-request/);
  assert.equal(calls,20);
});
test('cursor cycles, missing cursor and HTTP errors fail closed',async()=>{
  for(const response of [
    {ok:true,json:async()=>({mandates:[],meta:{cursors:{}}})},
    {ok:true,json:async()=>({mandates:[{id:'x'}],meta:{cursors:{after:'same'}}})},
    {ok:false,status:429},
  ])await assert.rejects(readFreshExceptionGoCardless(credentials,{transport:async()=>response}));
});
test('CLI cannot mix replay/apply, omit apply hash or override tenant',()=>{
  for(const args of [['--apply','--out','exports/a.json'],['--out','/tmp/a.json'],
    ['--out','exports/a.json','--tenant','other'],
    ['--apply','--replay','x','--out','exports/a.json','--review-sha256','a'.repeat(64)]])
    assert.throws(()=>parseExceptionArgs(args));
});
test('pinned real cached evidence integrity and deployed sources match (no APIs)',async()=>{
  assert.equal(sqlHash(await readFile(CACHED_REPORT_PATH)),CACHED_REPORT_SHA256);
  const proof=await verifyExceptionSources();
  assert.equal(Object.keys(proof.sourceHashes).length,7);
});