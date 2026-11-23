import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {receiveFunnelMailgunReceipt} from './eventFunnelMailgunReceipt.js';
import {sendEmail} from './emailService.js';
const id='11111111-1111-1111-1111-111111111111',nonce='22222222-2222-2222-2222-222222222222',key='fixture-only-signing-key';
function fixture(){
  const signature={timestamp:'1795435200',token:'fixture-token'};
  signature.signature=createHmac('sha256',key).update(signature.timestamp+signature.token).digest('hex');
  return {signature,'event-data':{event:'accepted',timestamp:1795435200,recipient:'attendee@example.test',
    message:{headers:{'message-id':'<fixture-message>'}},'user-variables':{iconn_funnel_confirmation:id,iconn_funnel_receipt:nonce}}};
}
test('receipt recovery requires a signature even when legacy webhook compatibility is permissive',async()=>{
  const db={rpc:()=>assert.fail('No database access before verification')};
  assert.equal((await receiveFunnelMailgunReceipt({body:fixture(),db})).status,503);
  const missing=fixture();delete missing.signature;
  assert.equal((await receiveFunnelMailgunReceipt({body:missing,db,signingKey:key})).status,401);
  assert.equal((await receiveFunnelMailgunReceipt({body:fixture(),db,signingKey:'wrong-key'})).status,401);
  assert.equal(await receiveFunnelMailgunReceipt({body:{'event-data':{}},db,signingKey:key}),null);
});
test('signed receipts normalize provider IDs and transient persistence failures remain retryable',async()=>{
  const calls=[],db={rpc:async(name,args)=>{calls.push({name,args});return {data:true};}};
  assert.equal((await receiveFunnelMailgunReceipt({body:fixture(),db,signingKey:key})).status,200);
  assert.equal(calls[0].args.p_message_id,'fixture-message');assert.equal(calls[0].args.p_nonce,nonce);
  assert.equal(calls[0].name,'event_funnel_confirmation_receipt');
  assert.equal((await receiveFunnelMailgunReceipt({body:fixture(),db:{rpc:async()=>({error:{code:'unavailable'}})},signingKey:key})).status,503);
});
test('the final Mailgun envelope carries receipt identity without changing ordinary messages',async()=>{
  const captured=[];
  const dependencies={client:{messages:{create:async(_domain,envelope)=>{captured.push(envelope);return {id:'fixture-message'};}}}};
  const message={to:'attendee@example.test',subject:'Ticket',html:'<p>Ticket</p>',skipFooter:true,resolveTransactionalPreferences:false};
  await sendEmail({...message,funnelReceipt:{id,token:nonce}},dependencies);
  assert.equal(captured.length,1);assert.equal(captured[0]['v:iconn_funnel_confirmation'],id);
  assert.equal(captured[0]['v:iconn_funnel_receipt'],nonce);
  await sendEmail(message,dependencies);
  assert.equal(captured[1]['v:iconn_funnel_confirmation'],undefined);
  const invalid=await sendEmail({...message,funnelReceipt:{id:'invalid',token:nonce}},dependencies);
  assert.equal(invalid.notSubmitted,true);assert.equal(captured.length,2);
  const simulated=await sendEmail({...message,testMode:true,funnelReceipt:{id,token:nonce}},dependencies);
  assert.equal(simulated.notSubmitted,true);assert.equal(captured.length,2);
});
