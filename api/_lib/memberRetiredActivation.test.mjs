import test from 'node:test';
import assert from 'node:assert/strict';
import {activateMembershipForCardAgreement,recordCardPaymentProgress} from './stripeMonthlyCard.js';
import {activateMembershipForAgreement,recordDdPaymentProgress} from './gocardlessDirectDebit.js';

function database(status,{race=false,error=null}={}){
 const row={id:'history',status,payment_status:'unpaid'},writes=[];
 return {row,writes,from(){
  let update=null;const filters={};
  const q={select(){return q;},eq(k,v){filters[k]=v;return q;},
   update(value){update=value;return q;},
   async maybeSingle(){
    if(!update)return {data:{...row},error:null};
    if(race)row.status='cancelled_by_request';
    if(error)return {data:null,error};
    if(filters.status&&row.status!==filters.status)return {data:null,error:null};
    writes.push(update);Object.assign(row,update);return {data:{id:row.id},error:null};
   },
   then(resolve,reject){return q.maybeSingle().then(resolve,reject);}};
  return q;
 }};
}
for(const [provider,activate,progress] of [
 ['card',activateMembershipForCardAgreement,recordCardPaymentProgress],
 ['dd',activateMembershipForAgreement,recordDdPaymentProgress],
]){
 const agreement={id:'agreement',member_id:'member',tenant_id:'tenant',
  metadata:{[provider]:{activation_rule:'first_payment'}}};
 test(`${provider}: retired purchases keep receipt progress without restoring access`,async()=>{
  for(const state of ['cancelled_by_request','replaced']){
   const db=database(state);
   const result=await activate(agreement,{db,trigger:'first_payment_confirmed'});
   assert.equal(result.activated,false);assert.equal(db.writes.length,0);
   await progress(agreement,{db});
   assert.equal(db.row.payment_status,'partial');
   assert.equal(db.row.status,state);
  }
 });
 test(`${provider}: concurrent retirement cannot produce false activation evidence`,async()=>{
  const db=database('pending_activation',{race:true});
  const result=await activate(agreement,{db,trigger:'first_payment_confirmed'});
  assert.equal(result.updated,false);assert.equal(result.activated,false);
  assert.equal(db.writes.length,0);
 });
 test(`${provider}: real activation succeeds and database failures remain retryable`,async()=>{
  const db=database('pending_activation');
  const result=await activate(agreement,{db,trigger:'first_payment_confirmed'});
  assert.equal(result.activated,true);assert.equal(db.row.status,'active');
  await assert.rejects(activate(agreement,{db:database('pending_activation',{error:{message:'unavailable'}}),
   trigger:'first_payment_confirmed'}),/unavailable/);
 });
}
