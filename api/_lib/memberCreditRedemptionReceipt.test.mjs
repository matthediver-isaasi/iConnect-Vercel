import test from 'node:test';
import assert from 'node:assert/strict';
import {recordMemberCreditRedemption as record,claimMemberCreditFunding as claim,postMemberCreditFunding as post} from './memberCreditRedemptionReceipt.js';
const input={tenantId:'tenant',allocation:{id:'allocation',amountMinor:500},
 proofs:[{allocationId:'allocation',binding:{providerTenantId:'books',accountId:'liability'}}],
 invoiceId:'invoice',reference:'funding:allocation',result:{payment_recorded:true,payment_id:'payment'}};
test('receipt requires independent provider verification before immutable persistence',async()=>{
 const calls=[];
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'saved'}}}};
 await record(db,{...input,verifyPayment:async()=>({verified:true,activeMinor:500})});
 assert.equal(calls.length,1);assert.equal(calls[0].name,'record_member_credit_redemption');
 assert.equal(calls[0].args.p_evidence.accountId,'liability');
 await assert.rejects(record(db,{...input,verifyPayment:async()=>({verified:false,activeMinor:500})}),/independently/);
 await assert.rejects(record(db,{...input,verifyPayment:async()=>({verified:true,activeMinor:499})}),/independently/);
 assert.equal(calls.length,1);
});
test('only a documented payment throttle grants a delayed retry',async()=>{
 const calls=[],args={tenantId:'tenant',allocation:{id:'allocation'},
  claim:{attempt:'initial',context:{reference:'ref'}},
  db:{rpc:async(name,values)=>{calls.push({name,values});return {data:{id:'retry'}}}}};
 await assert.rejects(post({...args,post:async observer=>{
  observer.state='rate_limited';observer.retryAfter='120';return {payment_recorded:false};
 }}),e=>e.status===429&&e.retryAfter===120&&e.retry===true);
 assert.equal(calls.length,1);assert.equal(calls[0].values.p_attempt,'initial');
 await assert.rejects(post({...args,post:async observer=>{
  observer.state='unknown';throw new Error('Lost POST response');
 }}),/Lost POST/);
 await assert.rejects(post({...args,post:async observer=>{
  observer.state='posted';throw Object.assign(new Error('Readback throttle'),{status:429});
 }}),/Readback throttle/);
 assert.equal(calls.length,1);
 await assert.rejects(claim({rpc:async(name,a)=>({data:{existing:true,context:a.p_context,retryAfter:60}})},input),
  e=>e.status===429&&e.retryAfter===60);
});
test('pre-payment throttle is retryable but other pre-payment errors do not grant a write',async()=>{
 const calls=[],args={tenantId:'tenant',allocation:{id:'allocation'},
  claim:{attempt:'initial',context:{reference:'ref'}},
  db:{rpc:async(name,values)=>{calls.push(values);return {data:{id:'retry'}}}}};
 await assert.rejects(post({...args,post:async()=>{
  throw Object.assign(new Error('Invoice read throttled'),{status:429,retryAfter:'180'});
 }}),e=>e.status===429&&e.retryAfter===180);
 assert.equal(calls.length,1);
 await assert.rejects(post({...args,post:async()=>{throw new Error('Invalid input');}}),/Invalid input/);
 assert.equal(calls.length,1);
});
test('lost persistence response is explicit; ordinary vouchers require no extra writes',async()=>{
 await assert.rejects(record({rpc:async()=>({error:{code:'timeout'}})},
  {...input,verifyPayment:async()=>({verified:true,activeMinor:500})}),/retry the original/);
 await record({rpc(){assert.fail('Legacy voucher must not create backing evidence')}},
  {...input,proofs:[]});
});
test('claims distinguish initial execution from read-only recovery and fail closed on uncertainty',async()=>{
 for(const existing of [false,true]){
  const result=await claim({rpc:async(name,args)=>({data:{existing,context:args.p_context}})},input);
  assert.equal(result.existing,existing);
 }
 await assert.rejects(claim({rpc:async()=>({error:{code:'timeout'}})},input),/no accounting payment/);
 await assert.rejects(claim({rpc:async()=>({data:{context:{},existing:false}})},input),/context differs/);
});
