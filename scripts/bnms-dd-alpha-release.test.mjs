import test from 'node:test';
import assert from 'node:assert/strict';
import {ALPHA_MANIFEST_SHA256,PROCESSING_NOT_BEFORE,MAX_EVIDENCE_AGE_MS,
  assertAlphaStageFresh,validateAlphaHandover,validateAlphaReleaseScope,readAlphaStage} from './bnms-dd-alpha-release.mjs';
import {parseAlphaReleaseArgs} from './run-bnms-dd-alpha-release.mjs';
import {TENANT_ID} from './bnms-dd-pilot.mjs';

const now=new Date('2026-09-20T12:00:00Z');
const stage=(ids=['a'])=>({manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:ids,
  observedAt:'2026-09-20T11:59:00Z',completedAt:now.toISOString(),complete:true});
const handover=()=>({tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,memberIds:['a'],
  confirmedAt:now.toISOString(),confirmedBy:'test administrator',evidenceReference:'test attestation',
  automaticLegacyCollectionsDisabled:true});

test('Processing gate is October 1 midnight London, not a charge-date requirement',()=>{
  assert.equal(PROCESSING_NOT_BEFORE,'2026-09-30T23:00:00Z');
});
test('Preparation CLI cannot write, migrate, override scope or release',()=>{
  for(const flag of ['--apply','--migration','--release','--tenant','--member','--skip-checks'])
    assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','exports/new.json',flag]));
  assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','/tmp/public.json']));
  assert.throws(()=>parseAlphaReleaseArgs(['--manifest','input.json','--out','exports/new.json','--out','exports/other.json']));
  assert.equal(parseAlphaReleaseArgs(['--manifest','input.json','--out','exports/new.json']).out,'exports/new.json');
});
test('Unpinned/generated manifests and beta-sized scope fail closed',()=>{
  assert.throws(()=>validateAlphaReleaseScope({tenantId:TENANT_ID,members:Array(10).fill({})},[]),/immutable/);
});
test('Missing or beta-only handover cannot authorize alpha',()=>{
  assert.throws(()=>validateAlphaHandover(null,['a'],now),/exact-alpha/);
  const h=handover();h.manifestSha256='beta';assert.throws(()=>validateAlphaHandover(h,['a'],now));
  delete h.manifestSha256;h.batchHash=ALPHA_MANIFEST_SHA256;assert.throws(()=>validateAlphaHandover(h,['a'],now));
});
test('Handover exact scope, date and evidence are mandatory',()=>{
  validateAlphaHandover(handover(),['a'],now);
  for(const patch of [{memberIds:['b']},{memberIds:['a','a']},{confirmedBy:''},{evidenceReference:''},
    {confirmedAt:'2026-09-19T11:59:59Z'},{confirmedAt:'2026-09-20T12:01:00Z'},
    {automaticLegacyCollectionsDisabled:false}]){
    assert.throws(()=>validateAlphaHandover({...handover(),...patch},['a'],now));
  }
});
test('Freshness retains oldest stage time across resume and final transaction',()=>{
  assertAlphaStageFresh([stage(['a']),stage(['b'])],['a','b'],now);
  const stale={...stage(),observedAt:new Date(now.getTime()-MAX_EVIDENCE_AGE_MS-1).toISOString()};
  assert.throws(()=>assertAlphaStageFresh([stale],['a'],now),/15 minutes/);
  assert.throws(()=>assertAlphaStageFresh([stage()],['a'],new Date(now.getTime()+MAX_EVIDENCE_AGE_MS)));
});
test('Partial, duplicate, wrong-batch and future stages never count as final readiness',()=>{
  for(const stages of [[stage(['a'])],[stage(['a']),stage(['a'])],
    [{...stage(['a','b']),complete:false}],[{...stage(['a','b']),manifestSha256:'beta'}],
    [{...stage(['a','b']),completedAt:'2026-09-20T13:00:00Z'}]]){
    assert.throws(()=>assertAlphaStageFresh(stages,['a','b'],now));
  }
});
test('Staging is bounded and stops at provider rate limits, preserving prior reads',async()=>{
  const seen=[];
  const result=await readAlphaStage(['a','b','c'],async id=>{
    seen.push(id);if(id==='b')throw Object.assign(Error('secret must not escape'),{status:429});return {ok:true};
  },{now:()=>now});
  assert.deepEqual(seen,['a','b']);assert.equal(result.complete,false);
  assert.equal(result.evidence.length,1);assert.match(result.blocker,/rate limit/);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(readAlphaStage(Array.from({length:26},(_,i)=>String(i)),async()=>null));
});
test('Stage cannot finish fresh if its final read exhausts time budget',async()=>{
  let clock=now;
  const result=await readAlphaStage(['a'],async()=>{clock=new Date(now.getTime()+MAX_EVIDENCE_AGE_MS+1);return {};},{now:()=>clock});
  assert.equal(result.complete,false);assert.equal(result.observedAt,now.toISOString());
});