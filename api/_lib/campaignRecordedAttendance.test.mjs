import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedAudienceAttendance } from './campaignRecordedAttendance.js';

test('recorded attendance continues through capped pages and batches IDs without duplicates', async () => {
  const ids=Array.from({length:403},(_,i)=>`b${i}`);
  let calls=0;
  const db={from(table){
    assert.equal(table,'attendance_current_outcome');
    let batch=[],offset=0;
    return {
      select(){return this},eq(){return this},not(){return this},order(){return this},
      in(key,values){assert.equal(key,'booking_id');assert(values.length<=200);batch=values;return this},
      range(start){offset=start;return this},
      then(resolve){calls++;return Promise.resolve({data:batch.flatMap(booking_id=>[{booking_id},{booking_id}]).slice(offset,offset+7),error:null}).then(resolve)},
    };
  }};
  assert.deepEqual(await recordedAudienceAttendance(db,'tenant','booking',ids),new Set(ids));
  assert(calls>100);
});

test('recorded attendance fails closed on provider lookup failure and does not query empty selections',async()=>{
  const db={from(){return {select(){return this},eq(){return this},not(){return this},in(){return this},order(){return this},
    range(){return Promise.resolve({data:null,error:{message:'database unavailable'}})}}}};
  await assert.rejects(recordedAudienceAttendance(db,'tenant','booking',['b']),/Unable to verify/);
  assert.deepEqual(await recordedAudienceAttendance({},'tenant','booking',[]),new Set());
});

test('transient attendance failures retain retry classification',async()=>{
  const db={from(){return {select(){return this},eq(){return this},not(){return this},in(){return this},order(){return this},
    range(){return Promise.resolve({data:null,error:{message:'timeout',code:'57014',status:503}})}}}};
  await assert.rejects(recordedAudienceAttendance(db,'tenant','booking',['b']),error=>
    error.code==='57014' && error.status===503);
});
