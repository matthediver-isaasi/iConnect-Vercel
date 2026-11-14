import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAwardIntake, verifySavedAwardContext, finaliseAwardIntake } from './intake.js';
const id='11111111-1111-4111-8111-111111111111';
function database(row,error=null,rows={}){
  const calls=[];
  return {calls,from(table){calls.push(['table',table]);const q={
    select(){return q;},eq(...args){calls.push(args);return q;},
    maybeSingle:async()=>({data:Object.hasOwn(rows,table)?rows[table]:row,error}),
    single:async()=>({data:Object.hasOwn(rows,table)?rows[table]:row,error}),
  };return q;},async rpc(name,args){calls.push([name,args]);return{data:row,error};}};
}
test('ordinary form submissions perform no awards queries',async()=>{
  const db=database(null);
  assert.equal(await resolveAwardIntake(db,{tenantId:id,formId:id}),null);
  assert.equal(await finaliseAwardIntake(db,{binding:null}),null);
  assert.deepEqual(db.calls,[]);
});
test('explicit context requires matching tenant, award, form and active binding',async()=>{
  const db=database({id,award_id:id});
  const binding=await resolveAwardIntake(db,{tenantId:'tenant',formId:'form',awardId:id});
  assert.equal(binding.id,id);
  for(const pair of [['tenant_id','tenant'],['award_id',id],['form_id','form'],['active',true]])
    assert.ok(db.calls.some(call=>JSON.stringify(call)===JSON.stringify(pair)));
  await assert.rejects(resolveAwardIntake(database(null),{tenantId:id,formId:id,awardId:id}),/not accepting/);
});
test('replay cannot change award; failure is explicit and finalisation never accepts retry identity',async()=>{
  await assert.rejects(verifySavedAwardContext(database({binding_id:'other'}),{tenantId:id,submissionId:id,binding:{id}}),/different/);
  const db=database({id,status:'received'},null,{awards_application:null,awards_intake_capture:{form_snapshot:{fields:[],review_field_ids:[]},answer_snapshot:{}}});
  await finaliseAwardIntake(db,{tenantId:id,submissionId:id,binding:{id},memberId:'untrusted'});
  const payload=db.calls.find(call=>call[0]==='awards_finalise_intake')[1];
  assert.equal(payload.p_member,undefined);
  assert.equal(payload.p_binding,id);
  await assert.rejects(finaliseAwardIntake(database(null,{code:'bad'}),{tenantId:id,submissionId:id,binding:{id}}),/verified|retry/);
});
test('a completed application retry does not depend on original attachment availability',async()=>{
  const db=database({id,reference:'AW-1'});
  assert.equal((await finaliseAwardIntake(db,{tenantId:id,submissionId:id,binding:{id}})).reference,'AW-1');
  assert.equal(db.calls.some(call=>call[0]==='awards_finalise_intake'),false);
});
