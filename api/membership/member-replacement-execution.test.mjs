import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberAmendmentsHandler} from './member-amendments.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(overrides={}){
 const calls=[],filters=[];
 const authority={sourceSnapshot:{commitment_snapshot:{payment_frequency:'upfront'}},calculation:{behaviour:'new_term'}};
 const db={
  from(table){assert.equal(table,'member_change_authority');const q={
   select(){return q},eq(k,v){filters.push([k,v]);return q},
   maybeSingle:async()=>({data:overrides.missing?null:{authority}}),
  };return q},
  async rpc(name,args){assert.equal(name,'member_replacement_execution_available');assert.equal(args.p_protocol,'upfront-replacement-v1');
   return overrides.ready===false?{error:{code:'PGRST202'}}:{data:true}},
 };
 const handler=createMemberAmendmentsHandler({db,
  getContext:async()=>({isAuthenticated:true,tenantId:id(1),tenantUserId:id(2),roleId:id(8),...overrides.context}),
  isAdmin:async()=>overrides.admin!==false,hasFinance:async()=>overrides.finance!==false,
  service:{},replacementExecutionService:{
   async execute(actor,input){calls.push({actor,input});return {execution:{id:id(5),plan:{choice:input.choice}},
    settlement:{state:'awaiting_payment'},application:null,nextAction:'await_payment'}},
   async resume(actor,input){calls.push({actor,input});return {execution:null,nextAction:'execute'}},
  }});
 async function invoke(action='execute_change'){
  const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
  await handler({method:'POST',body:{action,memberId:id(3),authorityId:id(4),approve:true,reason:'Approved replacement',
   settlementChoice:'collect',choice:'credit',tenantId:id(99)}},res);
  return res;
 }
 return {invoke,calls,filters};
}
test('replacement routing binds tenant, member, actor and approved treatment on the server',async()=>{
 const f=fixture(),res=await f.invoke();
 assert.equal(res.statusCode,200);
 assert.deepEqual(f.calls[0].actor,{tenantId:id(1),memberId:id(3),actorId:id(2),actorKind:'admin'});
 assert.equal(f.calls[0].input.choice,'collect');
 assert.ok(f.filters.some(([k,v])=>k==='tenant_id'&&v===id(1)));
 assert.ok(f.filters.some(([k,v])=>k==='member_id'&&v===id(3)));
 assert.equal(res.body.execution.settlement_choice,'collect');
 assert.equal(res.body.settlement.choice,'collect');
 assert.deepEqual(res.body.notifications,[]);
});
test('replacement recovery routes only to read-only financial recovery',async()=>{
 const f=fixture(),res=await f.invoke('resume_change');
 assert.equal(res.body.nextAction,'execute');assert.equal(res.body.application,null);
 assert.equal(f.calls.length,1);
});
test('replacement routing fails closed on missing migration, authority or financial permission',async()=>{
 for(const [options,status] of [[{ready:false},503],[{missing:true},404],[{admin:false},403],
  [{finance:false},403],[{context:{isAuthenticated:false}},401],[{context:{tenantMismatch:true}},409]]){
  const f=fixture(options),res=await f.invoke();assert.equal(res.statusCode,status);
  assert.equal(f.calls.length,0);
 }
});
