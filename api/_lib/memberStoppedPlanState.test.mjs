import test from 'node:test';
import assert from 'node:assert/strict';
import {applyStatusTransition,STATUS} from './gocardlessState.js';
function fixture({stopped=false,race=false}={}){
 const row={id:'plan',tenant_id:'tenant',status:STATUS.FIRST_PAYMENT_PENDING,
  collection_stopped_at:stopped?'2026-10-28T00:00:00Z':null},audit=[];
 const db={from(table){
  const filters=[],q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},
   is(k,v){filters.push(r=>r[k]===v);return q;},update(v){q.updateValue=v;return q;},
   insert(v){audit.push(v);return Promise.resolve({error:null});},
   maybeSingle(){return Promise.resolve({data:{...row},error:null});},
   then(resolve,reject){
    if(race)row.collection_stopped_at='2026-10-28T00:00:01Z';
    const matched=filters.every(f=>f(row));
    if(matched)Object.assign(row,q.updateValue);
    return Promise.resolve({data:matched?[{id:row.id}]:[],error:null}).then(resolve,reject);
   }};return q;
 }};
 return {db,row,audit};
}
const args={entityType:'payment_plan',entityId:'plan',toStatus:STATUS.ACTIVE};
test('stopped collection cannot be reactivated by a late receipt',async()=>{
 const f=fixture({stopped:true});
 const result=await applyStatusTransition(args,{db:f.db});
 assert.equal(result.skippedReason,'collections-stopped');
 assert.equal(f.row.status,STATUS.FIRST_PAYMENT_PENDING);
 assert.equal(f.audit.length,0);
});
test('a concurrent stop fences the status write even if the status itself did not change',async()=>{
 const f=fixture({race:true});
 const result=await applyStatusTransition(args,{db:f.db});
 assert.equal(result.skippedReason,'concurrent-update');
 assert.equal(f.row.status,STATUS.FIRST_PAYMENT_PENDING);
 assert.equal(f.audit.length,0);
});
test('ordinary first payment activation retains its status audit',async()=>{
 const f=fixture();
 const result=await applyStatusTransition(args,{db:f.db});
 assert.equal(result.applied,true);assert.equal(f.row.status,STATUS.ACTIVE);
 assert.equal(f.audit.length,1);
});
