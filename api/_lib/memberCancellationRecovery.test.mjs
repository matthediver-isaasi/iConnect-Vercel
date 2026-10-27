import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemberCancellationRecovery} from './memberCancellationRecovery.js';
function fixture(kind='lifecycle'){
 const job={id:'job',request_id:'request',claim_token:'claim',kind},jobs=[job],finishes=[];
 const record={id:'request',tenant_id:'tenant',member_id:'member',actor_id:'approved-actor',
  authority:{providerPrepared:{fingerprint:'owned'}},access_ended_at:'2026-07-01'};
 const db={async rpc(name,args){
  if(name==='claim_member_cancellation_jobs')return {data:jobs.splice(0,1)};
  if(name==='finish_member_cancellation_job'){finishes.push(args);return {data:true};}
  throw Error(name);
 },from(){const q={select(){return q},eq(){return q},async maybeSingle(){return {data:record}}};return q}};
 return {db,finishes,record};
}
test('recovery does not mark lifecycle complete until the provider stop is observed',async()=>{
 const f=fixture();
 const worker=createMemberCancellationRecovery({db:f.db,requests:{async recover(context,id){
  assert.equal(context.origin,'scheduled_recovery');assert.equal(id,'request');
  return {record:f.record,provider:{state:'uncertain'}};
 }}});
 await worker.run();
 assert.equal(f.finishes[0].p_state,'pending');
});
test('provider throttles defer reconciliation without exhausting genuine attempts',async()=>{
 const f=fixture('finance');
 const worker=createMemberCancellationRecovery({db:f.db,finance:{async recover(){
  throw Object.assign(Error('rate limit'),{retryAfter:900});
 }}});
 await worker.run();
 assert.equal(f.finishes[0].p_state,'pending');
 assert.equal(f.finishes[0].p_delay_seconds,900);
});
test('an uncertain notification is not returned to the automatic send queue',async()=>{
 const f=fixture('notify_access');
 const worker=createMemberCancellationRecovery({db:f.db,notify:{async send(){throw Error('lost delivery response')}}});
 await worker.run();
 assert.equal(f.finishes[0].p_state,'uncertain');
});
test('missing private recovery migration is an explicit unavailable result',async()=>{
 const worker=createMemberCancellationRecovery({db:{async rpc(){return {error:{code:'PGRST202'}}}}});
 assert.deepEqual(await worker.run(),{available:false,outcomes:[]});
});
