import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScheduledReminderBooking,reminderRecipientStillEligible} from './scheduledReminderBooking.js';
const booking={id:'booking',tenant_id:'tenant',event_id:'event',attendee_email:'fixture@example.test',status:'confirmed'};
function fixture(result={data:booking}){
  const calls=[],query={select(){return this;},eq(...args){calls.push(args);return this;},async maybeSingle(){return result;}};
  return {calls,db:{from(table){calls.push(table);return query;}}};
}
test('reminders use the configured model and full tenant/event identity',async()=>{
  for(const complex of [false,true]){
    const f=fixture();
    assert.equal(await loadScheduledReminderBooking(f.db,{tenant_id:'tenant',event_id:'event',is_complex_event:complex},'booking'),booking);
    assert.deepEqual(f.calls,[complex?'complex_event_booking':'booking',['tenant_id','tenant'],['event_id','event'],['id','booking']]);
  }
});
test('missing or failed complex lookups never fall back to a simple registration',async()=>{
  for(const result of [{data:null},{error:new Error('unavailable')},{data:{...booking,tenant_id:'foreign'}}]){
    const f=fixture(result),load=()=>loadScheduledReminderBooking(f.db,{tenant_id:'tenant',event_id:'event',is_complex_event:true},'booking');
    if(result.error||result.data)await assert.rejects(load);else assert.equal(await load(),null);
    assert.equal(f.calls.filter(x=>typeof x==='string').length,1);
  }
});
test('late cancellation, deletion, transfer or scope changes suppress delivery',()=>{
  assert.equal(reminderRecipientStillEligible(booking,booking,booking.attendee_email),true);
  for(const current of [null,{...booking,status:'cancelled'},{...booking,attendee_email:'other@example.test'},
    {...booking,tenant_id:'other'},{...booking,event_id:'other'}])
    assert.equal(reminderRecipientStillEligible(booking,current,booking.attendee_email),false);
});
