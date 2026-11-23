import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFunnelConfirmations} from './eventFunnelConfirmations.js';
const job={tenant_id:'tenant',order_id:'order',lease_token:'lease'};
function fixture(){
  const row={id:'11111111-1111-1111-1111-111111111111',receipt_token:'22222222-2222-2222-2222-222222222222',
    event_id:'event',booking:{attendee_email:'original@example.test'},template:{id:'template'}};
  let state='pending',payload;const calls=[];
  return {calls,get state(){return state;},db:{rpc:async(name,args)=>{
    assert.equal(name,'event_funnel_confirmation_operation');assert.equal(args.p_token,'lease');
    calls.push(args.p_action);
    if(args.p_action==='read')return {data:{status:state==='delivered'?'delivered':state==='pending'?'retry':'needs_review',
      jobs:state==='pending'?[row]:[]}};
    if(args.p_action==='begin'){
      if(state!=='pending')return {data:{status:state}};
      payload??=args.p_payload;state='writing';return {data:{status:'send',payload}};
    }
    state=args.p_payload.outcome==='delivered'?'delivered':args.p_payload.outcome==='not_submitted'?'pending':'needs_review';
    return {data:{saved:true}};
  }},render:async(event,booking,attendee,url,pricing,tenant,options)=>{
    assert.equal(event,'event');assert.deepEqual(options.emailConfigs,[row.template]);
    assert.equal(options.requireCheckin,true);
    return [await options.send({tenantId:tenant,to:booking.attendee_email,html:'original',
      attachments:[{data:Buffer.from('calendar')} ]})];
  }};
}
test('confirmation journals precede provider calls and completed retries do not send again',async()=>{
  const f=fixture();let sent=0;
  const send=async payload=>{assert.equal(f.state,'writing');assert.ok(Buffer.isBuffer(payload.attachments[0].data));
    assert.equal(payload.funnelReceipt.id,'11111111-1111-1111-1111-111111111111');
    assert.equal(payload.funnelReceipt.token,'22222222-2222-2222-2222-222222222222');
    sent++;return {success:true,messageId:'message'};};
  assert.equal((await deliverFunnelConfirmations({...f,job,send})).status,'delivered');
  assert.equal((await deliverFunnelConfirmations({...f,job,send})).status,'delivered');
  assert.equal(sent,1);assert.deepEqual(f.calls.slice(0,4),['read','begin','finish','read']);
});
test('known non-submission retries; ambiguous send is retained for review without another email',async()=>{
  for(const outcome of [{success:false,notSubmitted:true},{success:false},null]) {
    const f=fixture();let sent=0;
    const send=async()=>{sent++;if(outcome===null)throw new Error('connection lost');return outcome;};
    const first=await deliverFunnelConfirmations({...f,job,send});
    assert.equal(first.status,outcome?.notSubmitted?'retry':'needs_review');
    await deliverFunnelConfirmations({...f,job,send});
    assert.equal(sent,outcome?.notSubmitted?2:1);
  }
});
test('integration waits and exhausted budgets never render or send',async()=>{
  const f=fixture();
  assert.equal((await deliverFunnelConfirmations({...f,job,deadlineAt:100,now:()=>99,
    render:()=>assert.fail('deadline')})).status,'retry');
  assert.deepEqual(f.calls,['read','read']);
  assert.equal((await deliverFunnelConfirmations({job,db:{rpc:async()=>({data:{status:'retry',jobs:[]}})},
    render:()=>assert.fail('not ready')})).status,'retry');
});
