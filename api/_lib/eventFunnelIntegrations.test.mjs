import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverFunnelIntegrations,funnelNeedsNoProvider} from './eventFunnelIntegrations.js';
import {planFunnelNotifications} from './eventFunnelNotificationPlan.js';
const job={tenant_id:'tenant',order_id:'order',lease_token:'lease'};
function queryDb(tables) {
  return {from(table){
    const filters=[];let range;
    const q={select:()=>q,order:()=>q,eq:(key,value)=>{filters.push([key,value]);return q;},
      in:(key,value)=>{filters.push([key,value]);return q;},range:(a,b)=>{range=[a,b];return q;},
      maybeSingle:async()=>({data:rows()[0]||null}),
      then:(resolve,reject)=>Promise.resolve(tables[table]===undefined?{error:{code:'unavailable'}}:{data:rows()}).then(resolve,reject)};
    function rows(){const found=(tables[table]||[]).filter(r=>filters.every(([k,v])=>Array.isArray(v)?v.includes(r[k]):r[k]===v));
      return range?found.slice(range[0],range[1]+1):found;}
    return q;
  }};
}
test('integration siblings retain independent progress and only verified stages complete',async()=>{
  const jobs=['checkin','providers','notifications'].map(step=>({id:step,step,booking_source:'booking',
    event:{id:'event'},booking:{id:'booking'}})),complete=new Set(),notifications=[];
  const db={rpc:async(_name,args)=>{
    assert.equal(args.p_token,'lease');
    if(args.p_action==='finish') {
      if(args.p_step==='notifications'&&!complete.has('providers'))return {error:{code:'PT409'}};
      complete.add(args.p_step);if(args.p_rows)notifications.push(args.p_rows);return {data:{saved:true}};
    }
    return {data:{serverNow:'2026-11-23T00:00:00Z',status:complete.size===3?'delivered':'retry',jobs:jobs.filter(j=>!complete.has(j.id))}};
  }};
  const args={db,job,simpleCheckin:async()=>{},notifications:async input=>{
    assert.equal(input.now.toISOString(),'2026-11-23T00:00:00.000Z');return [{event_email_id:'template'}];},
    providerReady:async()=>false};
  assert.equal((await deliverFunnelIntegrations(args)).status,'retry');
  assert.deepEqual([...complete],['checkin']);
  assert.equal((await deliverFunnelIntegrations({...args,simpleCheckin:()=>assert.fail('already done'),
    providerReady:async()=>true})).status,'delivered');
  assert.equal(notifications.length,1);
});
test('notification planning shares junction/direct/common session eligibility for reminders and follow-ups',async()=>{
  const event={id:'event',tenant_id:'tenant',timezone:'UTC',end_date:'2027-01-03T18:00:00Z'},
    booking={id:'booking',event_id:'event',tenant_id:'tenant',status:'confirmed',ticket_class_id:'ticket',attendee_email:'guest@example.test'};
  const sessions=['direct','junction','common','excluded'].map((id,i)=>({id,tenant_id:'tenant',complex_event_id:'event',
    title:id,start_time:`2027-01-0${i+1}T10:00:00Z`,end_time:`2027-01-0${i+1}T12:00:00Z`,
    complex_event_track_id:id==='direct'?'a':id==='excluded'?'b':null}));
  const db=queryDb({
    event_email:[{id:'reminder',tenant_id:'tenant',event_id:'event',is_enabled:true,email_type:'reminder',timing_type:'1_day_before'},
      {id:'follow',tenant_id:'tenant',event_id:'event',is_enabled:true,email_type:'follow_up',follow_up_scope:'session',
        follow_up_delay:1,follow_up_unit:'hours'}],
    complex_event_session:sessions,complex_event_ticket_class:[{id:'ticket',tenant_id:'tenant',complex_event_id:'event',
      all_tracks:false,linked_track_ids:['a']}],
    complex_event_session_track:[{complex_event_session_id:'junction',complex_event_track_id:'a'}],
    complex_event_track:['a','b'].map(id=>({id,name:id,tenant_id:'tenant',complex_event_id:'event'})),
  });
  const rows=await planFunnelNotifications({db,tenantId:'tenant',event,booking,source:'complex_event_booking',now:new Date('2026-12-01')});
  assert.deepEqual(rows.filter(r=>r.event_email_id==='reminder').map(r=>r.session_id),['direct','junction','common']);
  assert.deepEqual(rows.filter(r=>r.event_email_id==='follow').map(r=>r.follow_up_target_key),
    ['session:direct','session:junction','session:common']);
  assert.ok(rows.every(r=>r.booking_id==='booking'&&r.attendee_email===booking.attendee_email));
});
test('plain event reminders preserve timing and do not queue past messages',async()=>{
  const event={id:'event',tenant_id:'tenant',start_date:'2027-01-03T12:00:00Z'};
  const booking={id:'booking',event_id:'event',tenant_id:'tenant',status:'confirmed',attendee_email:'guest@example.test'};
  const db=queryDb({event_agenda_item:[],event_email:[
    {id:'future',tenant_id:'tenant',event_id:'event',is_enabled:true,email_type:'reminder',timing_type:'1_day_before'},
    {id:'past',tenant_id:'tenant',event_id:'event',is_enabled:true,email_type:'reminder',timing_type:'7_days_before'},
  ]});
  const rows=await planFunnelNotifications({db,tenantId:'tenant',event,booking,source:'booking',now:new Date('2027-01-01')});
  assert.equal(rows.length,1);assert.equal(rows[0].scheduled_send_time,'2027-01-02T12:00:00.000Z');
  await assert.rejects(planFunnelNotifications({db,tenantId:'other',event,booking,source:'booking',now:new Date()}),/scope/);
});
test('no-provider completion requires complete discovery and does not confuse online delivery with registration',async()=>{
  const input={tenantId:'tenant',event:{id:'event',tenant_id:'tenant',is_online:true},
    booking:{id:'booking'},source:'booking'};
  assert.equal(await funnelNeedsNoProvider({...input,db:queryDb({event_agenda_item:[]})}),true);
  assert.equal(await funnelNeedsNoProvider({...input,event:{...input.event,zoom_meeting_id:'meeting'},
    db:{from:()=>assert.fail('must not claim readiness')}}),false);
  assert.equal(await funnelNeedsNoProvider({...input,db:queryDb({event_agenda_item:[
    {id:'line',event_id:'event',zoom_webinar_id:'webinar'}]})}),false);
  await assert.rejects(funnelNeedsNoProvider({...input,db:queryDb({})}),/metadata unavailable/);
});
