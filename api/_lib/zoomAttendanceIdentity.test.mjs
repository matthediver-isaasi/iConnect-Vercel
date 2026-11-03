import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoomAttendanceMatcher,fetchZoomAttendanceRegistrants} from './zoomAttendanceIdentity.js';
const b={id:'b',member_id:'m',attendee_email:'old@example.test',zoom_registrant_id:'r'};
const r={id:'r',email:'registered@example.test'};
test('explicit registrant ID resolves booking even if report and booking emails differ',()=>{
  const match=createZoomAttendanceMatcher([b],[r])({registrant_id:'r',user_email:'different@example.test'});
  assert.equal(match.candidates[0].booking_id,'b');assert.equal(match.matchedBy,'registrant_id');
});
test('registration-email bridge resolves stored registrant id without report id',()=>{
  assert.equal(createZoomAttendanceMatcher([b],[r])({user_email:' REGISTERED@example.test '}).candidates[0].booking_id,'b');
});
test('unknown explicit registration cannot fall through to coincidental email',()=>{
  assert.deepEqual(createZoomAttendanceMatcher([b],[r])({registrant_id:'foreign',user_email:b.attendee_email}).candidates,[]);
});
test('participant user IDs are not registrant IDs; email fallback remains supported',()=>{
  assert.equal(createZoomAttendanceMatcher([b],[])({id:'r',user_email:'unknown@example.test'}).candidates.length,0);
  assert.equal(createZoomAttendanceMatcher([b],[])({user_email:b.attendee_email}).matchedBy,'email');
});
test('duplicate bookings are not resolved by registration email',()=>{
  const bookings=[{id:'a',attendee_email:r.email},{id:'b',attendee_email:r.email}];
  assert.equal(createZoomAttendanceMatcher(bookings,[r])({user_email:r.email}).candidates.length,2);
});
test('multiple registrants sharing email remain ambiguous unless report provides explicit ID',()=>{
  const same=[r,{id:'s',email:r.email}];
  const bookings=[b,{id:'c',attendee_email:'third@example.test',zoom_registrant_id:'s'}];
  const matcher=createZoomAttendanceMatcher(bookings,same);
  assert.equal(matcher({user_email:r.email}).ambiguous,true);
  assert.equal(matcher({user_email:r.email}).candidates.length,2);
  assert.equal(matcher({registrant_id:'r',user_email:r.email}).candidates.length,1);
});
test('conflicting saved registration is never overridden by email',()=>{
  assert.equal(createZoomAttendanceMatcher([{...b,attendee_email:r.email,zoom_registrant_id:'other'}],[r])({registrant_id:'r'}).candidates.length,0);
});
test('registrants pagination retains Authorization and returns no join links',async()=>{
  let calls=0;
  const result=await fetchZoomAttendanceRegistrants('fixture','123','meeting',async(url,init)=>{
    assert.equal(init.headers.Authorization,'Bearer fixture');calls++;
    return {ok:true,json:async()=>({registrants:[{...r,join_url:'private'}],next_page_token:calls===1?'next':''})};
  });
  assert.equal(calls,2);assert.equal(result.length,2);assert.equal(result[0].join_url,undefined);
});
test('unavailable or partial registration evidence is not silently treated as empty',async()=>{
  await assert.rejects(()=>fetchZoomAttendanceRegistrants('fixture','123','meeting',async()=>({ok:false,status:403,json:async()=>({})})),/unavailable/);
  await assert.rejects(()=>fetchZoomAttendanceRegistrants('fixture','123','meeting',async()=>({ok:true,json:async()=>({registrants:[],next_page_token:'forever'})})),/page limit/);
});
test('explicit registration-disabled response supports ordinary non-registered meetings',async()=>{
  assert.deepEqual(await fetchZoomAttendanceRegistrants('fixture','123','meeting',async()=>({ok:false,status:400,json:async()=>({message:'Registration has not been enabled for this meeting.'})})),[]);
});
