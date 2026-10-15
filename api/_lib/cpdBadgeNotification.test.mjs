import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBadgeNotification} from './cpdBadgeNotification.js';
const identity={tenantId:'t',bookingId:'b',bookingSource:'standard'};
function db(awards,member={email:'attendee@example.test'}){
  const filters=[];
  return {filters,from(table){
    const q={select(){return q;},eq(k,v){filters.push([table,k,v]);return q;},
      is(k,v){filters.push([table,k,v]);return q;},order(){return q;},maybeSingle(){return q;},
      then(resolve){return Promise.resolve({data:table==='member_badge'?awards:member,error:null}).then(resolve);}};
    return q;
  }};
}
const certificate={available:true,can_send:true,recipient:'attendee@example.test',event_id:'e',email_template_id:'configured-event-template',fingerprint:'base'};
test('badge notification uses the event email and pins active booking-owned awards',async()=>{
  const database=db([{id:'award',member_id:'m',badge_id:'badge'}]);
  const result=await resolveBadgeNotification(database,identity,async(_,args)=>{
    assert.equal(args.emailOnly,true);return certificate;
  });
  assert.equal(result.can_send,true);
  assert.notEqual(result.fingerprint,certificate.fingerprint);
  for(const pair of [['tenant_id','t'],['booking_id','b'],['booking_type','booking'],['event_id','e'],['revoked_at',null]]){
    assert.ok(database.filters.some(([table,k,v])=>table==='member_badge'&&k===pair[0]&&v===pair[1]));
  }
});
test('missing awards, changed attendee identity and a missing event template block sends',async()=>{
  for(const [database,base,reason] of [
    [db([]),certificate,/No unrevoked/],
    [db([{id:'a',member_id:'m'}],{email:'purchaser@example.test'}),certificate,/no longer matches/],
    [db([{id:'a',member_id:'m'}]),{...certificate,email_template_id:null},/Select an email template/],
  ]){
    const result=await resolveBadgeNotification(database,identity,async()=>base);
    assert.equal(result.can_send,false);assert.match(result.send_reason,reason);
  }
});
