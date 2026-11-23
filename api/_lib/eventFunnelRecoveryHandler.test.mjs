import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFunnelRecoveryHandler } from './eventFunnelRecoveryHandler.js';
function fixture(secret='fixture-only-secret') {
  const calls=[];
  const options={getSecret:()=>secret,db:{rpc:async name=>{calls.push(name);return {data:{expired:1}};}},
    paymentFor:()=>{},recover:async input=>{calls.push(input);return {checked:0};}};
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  return {calls,options,res,req:{method:'GET',headers:{authorization:'Bearer fixture-only-secret'}}};
}
test('recovery fails closed without a secret and before any database or provider access',async()=>{
  for(const secret of [undefined,'','wrong']) {
    const f=fixture();f.options.getSecret=()=>secret;
    await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
    assert.equal(f.res.code,401);assert.deepEqual(f.calls,[]);
  }
});
test('authorized recovery is bounded and independent of new-purchase activation',async()=>{
  const f=fixture();await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
  assert.equal(f.res.code,200);assert.equal(f.calls[0],'event_funnel_maintenance');
  assert.equal(f.calls[1].budgetMs,20000);assert.equal(f.calls[1].limit,8);
});
test('accounting failures do not erase successful payment recovery',async()=>{
  const f=fixture();f.options.deliverInvoices=async()=>{throw new Error('private provider error');};
  await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
  assert.equal(f.res.code,200);
  assert.deepEqual(f.res.body.invoices,{status:'retry'});
  assert.deepEqual(f.res.body.recovery,{checked:0});
  assert.equal(JSON.stringify(f.res.body).includes('private provider'),false);
});
test('confirmation failures are independent of accounting and never change payment recovery',async()=>{
  const f=fixture();f.options.deliverInvoices=async()=>({delivered:1});
  f.options.deliverConfirmations=async()=>{throw new Error('private email error');};
  await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
  assert.equal(f.res.code,200);assert.deepEqual(f.res.body.invoices,{delivered:1});
  assert.deepEqual(f.res.body.confirmations,{status:'retry'});assert.deepEqual(f.res.body.recovery,{checked:0});
  assert.equal(JSON.stringify(f.res.body).includes('private email'),false);
});
test('retention failure remains visible while payment recovery continues',async()=>{
  const f=fixture();f.options.pruneConfirmations=async()=>{throw new Error('private snapshot');};
  await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
  assert.equal(f.res.code,200);assert.deepEqual(f.res.body.recovery,{checked:0});
  assert.deepEqual(f.res.body.confirmationRetention,{status:'retry'});
  assert.equal(JSON.stringify(f.res.body).includes('private snapshot'),false);
});
test('integrations run before confirmations and their failure preserves financial recovery',async()=>{
  const f=fixture(),order=[];
  f.options.deliverIntegrations=async({deadlineAt})=>{
    assert.ok(deadlineAt>Date.now());order.push('integrations');throw new Error('private resource failure');
  };
  f.options.deliverConfirmations=async({deadlineAt})=>{assert.ok(deadlineAt>Date.now());order.push('confirmations');return {checked:0};};
  await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
  assert.deepEqual(order,['integrations','confirmations']);
  assert.deepEqual(f.res.body.integrations,{status:'retry'});assert.deepEqual(f.res.body.recovery,{checked:0});
});
test('slow early recovery does not launch work beyond the invocation budget',async()=>{
  const original=Date.now;let now=100000;
  Date.now=()=>now;
  try {
    const f=fixture();
    f.options.recover=async()=>{now+=56000;return {checked:1};};
    for(const key of ['deliverInvoices','deliverIntegrations','deliverConfirmations'])
      f.options[key]=()=>assert.fail('Deadline expired');
    await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
    assert.deepEqual(f.res.body.recovery,{checked:1});
    for(const key of ['invoices','integrations','confirmations'])assert.deepEqual(f.res.body[key],{status:'retry'});
  } finally {Date.now=original;}
});
test('missing schema and provider failures expose no private error payload',async()=>{
  for(const missingSchema of [false,true]) {
    const f=fixture();
    if(missingSchema) f.options.db.rpc=async()=>({error:{message:'private'}});
    else f.options.recover=async()=>{throw new Error('private');};
    await createEventFunnelRecoveryHandler(f.options)(f.req,f.res);
    assert.equal(f.res.code,503);assert.ok(!JSON.stringify(f.res.body).includes('private'));
  }
});
