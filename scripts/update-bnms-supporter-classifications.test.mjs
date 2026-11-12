import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { TENANT, parseWorkbook, plan, digest, verifyDigest, verifyAfter, applyChanges, main } from './update-bnms-supporter-classifications.mjs';
const ids=Array.from({length:48},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
function fixture() {
  const role={id:'target',name:'Supporter',tenant_id:TENANT,is_admin:false,is_tenant_admin:false,excluded_features:['admin']};
  const field={id:'class',name:'member_class',tenant_id:TENANT,entity_scope:'member',is_active:true,
    field_type:'dropdown',options:[{label:'Supporter',value:'Supporter'}]};
  return {roles:[role,{...role,id:'prior',name:'CPD Guest'}],fields:[field],
    members:ids.map(id=>({id,tenant_id:TENANT,role_id:'prior',survey_invitation_revision:10,updated_at:'before',login_enabled:true})),
    values:ids.map((id,i)=>({id:`value-${i}`,member_id:id,field_id:'class',value:'CPD Guest'})),
    secondaryTable:null,secondary:[],groups:[],
    constraints:[{relation:'member_preference_value',definition:'UNIQUE (member_id, field_id)'}]};
}
function workbook() {
  return {SheetNames:['Sheet1'],Sheets:{Sheet1:XLSX.utils.aoa_to_sheet([
    ['member_id','role_name','Member class'],...ids.map(id=>[id,'Supporter','Supporter'])])}};
}
test('exact workbook shape, typed values and IDs; rejects formulas and coercion',()=>{
  assert.deepEqual(parseWorkbook(workbook()),ids);
  for(const mutate of [
    w=>w.Sheets.Sheet1.A2.f='1+1',
    w=>w.Sheets.Sheet1.A2.v=123,
    w=>w.Sheets.Sheet1.A2.v='not-uuid',
    w=>w.Sheets.Sheet1.A2.v=ids[1],
    w=>w.Sheets.Sheet1.B2.v='supporter',
    w=>w.Sheets.Sheet1.C1.v='other',
    w=>w.SheetNames.push('Other'),
    w=>w.Sheets.Sheet1['!ref']='A1:C48',
  ]) {const w=workbook();mutate(w);assert.throws(()=>parseWorkbook(w));}
});
test('rejects missing/duplicate/cross-tenant/deleted/privileged members and definitions',()=>{
  for(const mutate of [
    s=>s.members.pop(),
    s=>s.members[0]=s.members[1],
    s=>s.members[0].tenant_id='foreign',
    s=>s.members[0].email='deleted_abc@deleted.local',
    s=>s.members[0].role_effective_from='2026-01-01',
    s=>s.roles[1].is_admin=true,
    s=>s.roles[0].max_members=3,
    s=>s.roles[0].is_tenant_admin=true,
    s=>s.roles[0].excluded_features=[],
    s=>s.roles.shift(),
    s=>s.roles.push(s.roles[0]),
    s=>s.fields=[],
    s=>s.fields.push(s.fields[0]),
    s=>s.fields[0].entity_scope='organization',
    s=>s.fields[0].options=[],
    s=>s.values.push(s.values[0]),
    s=>s.constraints=[],
    s=>s.secondaryTable='member_role',
    s=>s.groups=[{automatic_membership_filter_groups:[{conditions:[{entity_scope:'member',field_key:'role_id'}]}]}],
  ]) {const s=fixture();mutate(s);assert.throws(()=>plan(ids,s));}
});
test('digest rejects mismatch and concurrent member/preference/definition drift',()=>{
  const s=fixture(),sha=digest(s);
  verifyDigest(sha,structuredClone(s));
  assert.throws(()=>verifyDigest('0'.repeat(64),s),/snapshot changed/);
  for(const mutate of [s=>s.members[0].login_enabled=false,s=>s.values[0].value='Other',
    s=>s.roles[0].name='Other']) {
    const changed=structuredClone(s);mutate(changed);
    assert.throws(()=>verifyDigest(sha,changed),/snapshot changed/);
  }
});
test('mixed plan preserves input and includes missing values without creating members',()=>{
  const s=fixture();s.members[0].role_id='target';s.values[0].value='Supporter';s.values.pop();
  const original=structuredClone(s),p=plan(ids,s);
  assert.deepEqual(p.summary,{total:48,updated:47,alreadyCorrect:1,blocked:0,roleUpdates:47,classUpdates:46,classInserts:1});
  assert.deepEqual(s,original);
});
test('post-read validates allowed effects and zero-write replay; rejects unrelated mutation',async()=>{
  const s=fixture(),p=plan(ids,s),after=structuredClone(s);
  after.members.forEach(m=>{m.role_id='target';m.survey_invitation_revision+=2;m.updated_at='after';});
  after.values.forEach(v=>v.value='Supporter');
  verifyAfter(s,after,p);
  assert.equal(plan(ids,after).summary.updated,0);
  for(const mutate of [s=>s.members[0].login_enabled=false,s=>s.members[0].survey_invitation_revision++,
    s=>s.values[0].id='replaced',s=>s.members[0].role_id='prior']) {
    const bad=structuredClone(after);mutate(bad);assert.throws(()=>verifyAfter(s,bad,p));
  }
  let queries=0;
  await applyChanges({query:async()=>{queries++;throw Error('No writes expected');}},plan(ids,after));
  assert.equal(queries,0);
});
test('conditional write counts fail closed; SQL binds scope and does not create members',async()=>{
  const p=plan(ids,fixture());
  await assert.rejects(applyChanges({query:async()=>({rowCount:47})},p),/role write count/);
  const calls=[];
  await applyChanges({query:async(sql,args)=>{calls.push({sql,args});return {rowCount:48};}},p);
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.args.includes(TENANT) && /IS NOT DISTINCT FROM/.test(c.sql)));
  assert.ok(calls.every(c=>!/INSERT INTO public.member\b/.test(c.sql)));
  let n=0;
  await assert.rejects(applyChanges({query:async()=>({rowCount:++n===1?48:47})},p),/class write count/);
});
test('apply without approval and exact digest cannot connect',async()=>{
  await assert.rejects(main(['--apply']),/requires reviewed digest/);
  await assert.rejects(main(['--apply','--approve-metadata-effects']),/requires reviewed digest/);
  await assert.rejects(main(['--arbitrary']),/Invalid arguments/);
});
