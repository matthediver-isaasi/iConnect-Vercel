import test from 'node:test';
import assert from 'node:assert/strict';
import { planOccupationRepair } from './bnms-occupation-repair-core.mjs';
import { TENANT } from './bnms-job-title-repair-core.mjs';
const member={id:'member',tenant_id:TENANT,email:'person@example.test',job_title:'Original notes.\nVerbatim.'};
const source={legacyId:'123',email:member.email,occupation:'Clinical Scientist',notes:member.job_title,
  file:'pinned.csv',fingerprint:'a'.repeat(64),sheet:'CSV',row:2};
const plan=(m=member,s=[source],legacy=['123'],occupation=['Clinical Scientist'])=>
  planOccupationRepair(m,legacy,occupation,s);
test('exact source Notes becomes preserved note and Occupation becomes title',()=>{
  const {item}=plan();
  assert.equal(item.title,'Clinical Scientist');
  assert.equal(item.before,member);
  assert.equal(item.note.author_member_id,null);
  assert.ok(item.note.content.endsWith(member.job_title));
  assert.match(item.note.content,/not newly authored/);
  assert.equal(plan().item.note.id,item.note.id);
});
test('missing, conflicting or edited values are never overwritten',()=>{
  for(const result of [
    plan({...member,job_title:''}),
    plan({...member,job_title:'Edited title'}),
    plan({...member,tenant_id:'other'}),
    plan({...member,is_sample:true}),
    plan(member,[{...source,email:'other@example.test'}]),
    plan(member,[source,{...source,occupation:'Different occupation'}]),
    plan(member,[source,{...source,legacyId:'456'}]),
    plan(member,[{...source,occupation:''}]),
    plan(member,[source],['123','456']),
    plan(member,[source],['123'],['New occupation']),
  ])assert.equal(result.item,undefined);
});
test('identical duplicate sources do not create multiple actions or notes',()=>{
  const result=plan(member,[source,{...source,file:'other-pinned.csv'}]);
  assert.ok(result.item);
  assert.equal(result.evidence.length,2);
  assert.equal(result.item.title,source.occupation);
});
