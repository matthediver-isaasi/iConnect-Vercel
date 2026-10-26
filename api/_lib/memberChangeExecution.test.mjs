import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberChangeExecutionService,runMemberChangeExecutionRecovery} from './memberChangeExecution.js';
import {createMemberAmendmentRecoveryHandler} from '../cron/member-amendments.js';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const context={tenantId:uuid(1),memberId:uuid(2),actorId:uuid(3),actorKind:'admin'};
 const input={authorityId:uuid(4),approve:true,reason:'Approve',settlementChoice:'collect'};
 const execution={authority_id:uuid(4),amendment_id:uuid(5),settlement_choice:'collect'};
 const calls=[];let life={settlement:null,application:null};let failApply=false;
 const db={from(){const q={select(){return q},eq(){return q},async maybeSingle(){return {data:execution}}};return q},
   async rpc(name){calls.push(name);return {data:execution}}};
 const settlement={
   async lifecycle(){return life},
   async settle(){calls.push('settle');life={settlement:{state:'awaiting_payment'}};return life},
   async reconcile(){calls.push('reconcile');return life},
   async apply(){calls.push('apply');if(failApply)throw Error('Persistence interrupted');
     life={settlement:{state:'applied'},application:{id:'application'}};return life},
 };
 return {context,input,calls,service:createMemberChangeExecutionService({db,settlement}),
   setLife:value=>life=value,setFailure:value=>failApply=value};
}
test('explicit approval reserves execution before settlement; unpaid never applies',async()=>{
 const f=fixture();await assert.rejects(f.service.execute(f.context,{...f.input,approve:false}),/Explicit/);
 await f.service.execute(f.context,f.input);
 assert.deepEqual(f.calls,['begin_member_change_execution','settle','reconcile']);
});
test('recovery never starts money; only verified settled state applies',async()=>{
 const f=fixture();assert.equal((await f.service.resume(f.context,f.input)).nextAction,'execute');
 assert.deepEqual(f.calls,[]);
 for(const state of ['reserved','awaiting_payment','uncertain','conflict']){
   f.setLife({settlement:{state}});await f.service.resume(f.context,f.input);
 }
 assert.ok(!f.calls.includes('settle'));assert.ok(!f.calls.includes('apply'));
 f.setLife({settlement:{state:'settled'}});f.setFailure(true);
 await assert.rejects(f.service.resume(f.context,f.input),/interrupted/);
 f.setFailure(false);assert.ok((await f.service.resume(f.context,f.input)).application);
 const count=f.calls.length;await f.service.resume(f.context,f.input);assert.equal(f.calls.length,count);
});
test('scheduled recovery reports missing migration and isolates individual failures',async()=>{
 const absent=await runMemberChangeExecutionRecovery({db:{rpc:async()=>({error:{code:'PGRST202'}})}});
 assert.equal(absent.reason,'migration_required');assert.equal(absent.enabled,false);
 const rows=[1,2].map(n=>({authority_id:uuid(n),tenant_id:uuid(4),member_id:uuid(5),approved_by:uuid(6)}));
 const seen=[];
 const result=await runMemberChangeExecutionRecovery({db:{rpc:async()=>({data:rows})},service:{
   async resume(context,input){seen.push(context);if(input.authorityId===uuid(1))throw Object.assign(Error(),{code:'conflict'});
     return {application:{id:'done'}};}
 }});
 assert.deepEqual(result.outcomes.map(r=>r.code||r.state),['conflict','applied']);
 assert.equal(seen[0].actorId,uuid(6));
});
test('cron retains authentication and includes execution recovery within its budget',async()=>{
 const calls=[];
 const handler=createMemberAmendmentRecoveryHandler({db:{},secret:()=> 'fixture-secret',
   run:async args=>{calls.push(['legacy',args.budgetMs]);return {outcomes:[]}},
   runExecutions:async args=>{calls.push(['execution',args.budgetMs]);return {enabled:true,outcomes:[]}}});
 const res={setHeader(){},status(value){this.code=value;return this},json(value){this.body=value;return this}};
 await handler({method:'POST',headers:{}},res);assert.equal(res.code,401);assert.equal(calls.length,0);
 await handler({method:'POST',headers:{authorization:'Bearer fixture-secret'}},res);
 assert.equal(calls[0][0],'legacy');assert.equal(calls[1][0],'execution');
 assert.ok(calls[1][1]<=40000);assert.equal(res.body.executionRecovery.enabled,true);
});
