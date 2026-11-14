import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
const {__setRoleAccessOverlayForTests}=await import('../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const {default:handler}=await import('./assessment-history.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(excluded_features=[]){
  const calls=[];
  const q={select(){return q;},eq(){return q;},async maybeSingle(){return{data:{excluded_features}};}};
  const db={from(){return q;},async rpc(name,args){calls.push({name,args});return{data:{id:id(4),form_snapshot:{
    fields:[{id:'research',type:'text'}],review_field_ids:['research']},answer_snapshot:{research:'Retained evidence',secret:'Private'},attachment_manifest:[]}};}};
  return{calls,req:{method:'GET',query:{scope:'review',roundId:id(2),applicationId:id(3),versionId:id(4)},headers:{}},
    res:{statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}},
    dependencies:{supabase:db,getTenantContext:async()=>({isAuthenticated:true,tenantId:id(1),memberId:id(5),roleId:id(6)})}};
}
test('report-only access does not authorize application evidence',async()=>{
  const f=fixture(['awards.management.moderate','awards.management.approve']);
  await handler(f.req,f.res,f.dependencies);assert.equal(f.res.statusCode,403);assert.equal(f.calls.length,0);
});
test('staff evidence forwards exact tenant, actor, round and historical version',async()=>{
  const f=fixture();await handler(f.req,f.res,f.dependencies);
  assert.equal(f.res.statusCode,200);assert.deepEqual(f.calls[0].args,{p_tenant:id(1),p_round:id(2),p_application:id(3),p_actor_kind:'member',p_actor:id(5),p_version:id(4)});
  assert.equal(JSON.stringify(f.res.body).includes('Private'),false);
  assert.equal(f.res.body.applicationVersionId,id(4));
});
