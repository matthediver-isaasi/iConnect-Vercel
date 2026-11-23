import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunnelCancellationMessage,deliverFunnelCancellationNotifications} from './eventFunnelCancellationNotifications.js';
const context={order:{id:'order',tenant_id:'tenant'},operation:{id:'operation',lease_id:'lease'}};
const job={id:'message',tenant_id:'tenant',booking_id:'booking',booking_source:'booking',
  recipient:'fixture@example.test',booking:{booking_reference:'<script>unsafe</script>'}};
function fixture(){
  let state='pending',payload;const calls=[];
  return {calls,db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_cancellation_message_operation');calls.push(args.p_action);
    if(args.p_action==='read')return {data:{status:state==='delivered'?'complete':state==='pending'?'retry':'needs_review',
      jobs:state==='pending'?[job]:[]}};
    if(args.p_action==='begin'){
      if(state!=='pending')return {data:{status:'needs_review'}};
      payload||=args.p_payload;state='writing';return {data:{status:'send',payload}};
    }
    state=args.p_payload.outcome==='accepted'?'delivered':args.p_payload.outcome==='not_submitted'?'pending':'needs_review';
    return {data:{status:state}};
  }}};
}
test('cancellation messages escape original references and never claim refunds completed',()=>{
  const message=buildFunnelCancellationMessage(job,'tenant');
  assert.doesNotMatch(message.html,/<script>/);
  assert.match(message.html,/&lt;script&gt;/);
  assert.match(message.html,/does not confirm that a refund has completed/);
  assert.equal(message.to,job.recipient);
  assert.throws(()=>buildFunnelCancellationMessage(job,'foreign'));
});
test('accepted messages are never resent when cleanup is retried',async()=>{
  const f=fixture();let sends=0;
  const send=async()=>{sends++;return {success:true,messageId:'provider-message'};};
  assert.equal((await deliverFunnelCancellationNotifications({...f,context,send})).status,'complete');
  await deliverFunnelCancellationNotifications({...f,context,send});
  assert.equal(sends,1);
});
test('uncertain delivery is retained without automatic resend',async()=>{
  const f=fixture();let sends=0;
  const send=async()=>{sends++;throw new Error('Response lost');};
  assert.equal((await deliverFunnelCancellationNotifications({...f,context,send})).status,'needs_review');
  await deliverFunnelCancellationNotifications({...f,context,send});assert.equal(sends,1);
});
test('known non-submission can retry and insufficient time does not begin a write',async()=>{
  const f=fixture();let sends=0;
  const send=async()=>{sends++;return {notSubmitted:true};};
  assert.equal((await deliverFunnelCancellationNotifications({...f,context,send})).status,'retry');
  await deliverFunnelCancellationNotifications({...f,context,send});assert.equal(sends,2);
  const g=fixture();
  assert.equal((await deliverFunnelCancellationNotifications({...g,context,send,deadlineAt:100,now:()=>99})).status,'retry');
  assert.deepEqual(g.calls,['read','read']);
});
