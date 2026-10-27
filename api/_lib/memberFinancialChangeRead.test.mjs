import test from 'node:test';
import assert from 'node:assert/strict';
import {readMemberMonthlyChanges} from './memberMonthlyChangeRead.js';
import {createMemberChangeExecutionService} from './memberChangeExecution.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const authority={version:1,action:'change',sourceSnapshot:{commitment_snapshot:{payment_frequency:'upfront'}}};
 const tables={
   member_change_authority:[{id:id(3),tenant_id:id(1),member_id:id(2),authority,created_at:'2026-10-27'}],
   member_change_execution:[],
   member_membership_amendment_settlement:[],
   member_membership_amendment_application:[],
   member_membership_amendment_notification:[],
 };
 const db={rpc:async()=>({data:true}),from(table){
   let rows=tables[table]||[];
   return {select(){return this},eq(k,v){rows=rows.filter(r=>r[k]===v);return this},
     in(k,values){rows=rows.filter(r=>values.includes(r[k]));return this},
     order(){return this},async range(a,b){return {data:rows.slice(a,b+1)}},
     async maybeSingle(){return {data:rows[0]||null}},
     then(resolve,reject){return Promise.resolve({data:rows}).then(resolve,reject)}};
 }};
 return {db,tables};
}
test('financial history is tenant/member scoped and never exposes notification claim tokens',async()=>{
 const f=fixture();
 f.tables.member_change_execution.push({authority_id:id(3),amendment_id:id(4),tenant_id:id(1),member_id:id(2)});
 f.tables.member_membership_amendment_notification.push({amendment_id:id(4),tenant_id:id(1),
   kind:'applied',state:'sent',claim_token:'private-claim'});
 f.tables.member_change_authority.push({id:id(5),tenant_id:id(9),member_id:id(2),authority:{},created_at:'2026-10-28'});
 const result=await readMemberMonthlyChanges(f.db,id(1),id(2));
 assert.equal(result.financialExecutionAvailable,true);
 assert.equal(result.memberCreditExecutionAvailable,false);
 assert.equal(result.financialChanges.length,1);
 assert.equal(result.financialChanges[0].notifications[0].state,'sent');
 assert.equal(JSON.stringify(result).includes('private-claim'),false);
});
test('first recovery validates a saved authority but never starts financial execution',async()=>{
 const f=fixture();
 const service=createMemberChangeExecutionService({db:f.db,settlement:new Proxy({},{
   get(){throw Error('Recovery must not start a settlement without execution approval');},
 })});
 const context={tenantId:id(1),memberId:id(2),actorId:id(8),actorKind:'admin'};
 const result=await service.resume(context,{authorityId:id(3)});
 assert.equal(result.nextAction,'execute');assert.equal(result.execution,null);
 await assert.rejects(service.resume({...context,tenantId:id(9)},{authorityId:id(3)}),{status:404});
 await assert.rejects(service.execute(context,{authorityId:id(3),approve:true,reason:'Approve',settlementChoice:'credit'}),
   /supported settlement choice/);
});
