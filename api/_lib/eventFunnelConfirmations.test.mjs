import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFunnelConfirmations} from './eventFunnelConfirmations.js';
const job={tenant_id:'tenant',order_id:'order',lease_token:'lease'};
const entitlementTable=(benefits,reads=[])=>table=>{
  assert.equal(table,'event_funnel_membership_entitlement');
  const q={select:()=>q,eq:(column,value)=>{reads.push([column,value]);return q;},order:()=>q,
    then:resolve=>resolve(benefits instanceof Error?{error:{code:'XX000'}}:{data:benefits})};
  return q;
};
function fixture(benefits=[]){
  const row={id:'11111111-1111-1111-1111-111111111111',receipt_token:'22222222-2222-2222-2222-222222222222',
    event_id:'event',booking_id:'booking-1',booking:{id:'booking-1',attendee_email:'original@example.test'},template:{id:'template'}};
  let state='pending',payload;const calls=[];
  return {calls,get state(){return state;},get payload(){return payload;},db:{from:entitlementTable(benefits),rpc:async(name,args)=>{
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

const benefit=(over={})=>({id:'e1',node_id:'n1',scope:'member',withdrawn_at:null,withdrawn_by_reversal:null,
  benefit_snapshot:{scheduleName:'Associate <Member>',recipientMode:'attendees',qualifyingBookingIds:['booking-1']},...over});
test('confirmation lists each granted benefit for this booking without promising activation or dates',async()=>{
  const f=fixture([benefit(),
    benefit({id:'e2',scope:'organization',benefit_snapshot:{scheduleName:'Corporate',qualifyingBookingIds:['booking-1','booking-2']}}),
    benefit({id:'e3',benefit_snapshot:{scheduleName:'Other attendee',recipientMode:'attendees',qualifyingBookingIds:['booking-2']}}),
    benefit({id:'e4',withdrawn_at:'2026-11-25T00:00:00Z',benefit_snapshot:{scheduleName:'Withdrawn',qualifyingBookingIds:['booking-1']}})]);
  let html;
  await deliverFunnelConfirmations({...f,job,send:async payload=>{html=payload.html;return {success:true};}});
  assert.match(html,/^original/);
  assert.match(html,/Complimentary membership included/);
  assert.match(html,/Associate &lt;Member&gt;<\/strong> — Individual membership for you, as the named attendee/);
  assert.match(html,/Corporate<\/strong> — Organisation membership/);
  assert.doesNotMatch(html,/Other attendee|Withdrawn/);
  assert.match(html,/base fee for one membership period, waived once/);
  assert.match(html,/has not been started/);
  assert.doesNotMatch(html,/\b(activated|starts on|valid from|\d{4}-\d{2}-\d{2})\b/i);
  assert.equal(f.payload.html,html);
});
test('confirmation without benefits is unchanged and a benefit read failure sends nothing',async()=>{
  const f=fixture();let html;
  await deliverFunnelConfirmations({...f,job,send:async payload=>{html=payload.html;return {success:true};}});
  assert.equal(html,'original');
  const g=fixture(new Error('down'));
  await assert.rejects(deliverFunnelConfirmations({...g,job,send:async()=>assert.fail('sent')}));
  assert.deepEqual(g.calls,['read']);
});
