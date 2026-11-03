import test from 'node:test';
import assert from 'node:assert/strict';
import {sendAutomaticAttendanceCertificate} from './automaticAttendanceCertificate.js';
const row={tenant_id:'tenant',booking_id:'booking',booking_type:'booking',trigger_type:'attendance'};
function fixture({attended=true,accepted=false,info={},failSend=false}={}) {
  const calls=[];
  const db={from(table){const q={select(){return q;},eq(){return q;},limit(){return Promise.resolve({
    data:table==='attendance_current_outcome'?(attended?[{status:'attended'}]:[]):accepted?[{id:'sent'}]:[],error:null});}};return q;}};
  const handler=async(req,res,deps)=>{
    calls.push(req);
    assert.equal(deps.actor,'system:attendance-certificate');
    res.status(req.method==='POST'&&failSend?502:200).json(req.method==='GET'
      ? {can_send:true,available:true,fingerprint:'fingerprint',...info}
      : {success:!failSend,error:failSend?'provider failure':undefined});
  };
  return {db,handler,calls};
}
test('qualifying certificate sends without award override or deliberate resend',async()=>{
  const f=fixture();assert.equal((await sendAutomaticAttendanceCertificate(f.db,row,f.handler)).status,'accepted');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.deliberate_resend,false);
  assert.equal(f.calls[1].body.award_confirmed,undefined);
});
test('registration and nonqualifying rows cannot send',async()=>{
  const f=fixture({attended:false});
  await sendAutomaticAttendanceCertificate(f.db,row,f.handler);
  await sendAutomaticAttendanceCertificate(f.db,{...row,trigger_type:'registration'},f.handler);
  assert.equal(f.calls.length,0);
});
test('any prior accepted attendee delivery prevents automatic resend',async()=>{
  const f=fixture({accepted:true});assert.equal((await sendAutomaticAttendanceCertificate(f.db,row,f.handler)).status,'already_sent');
  assert.equal(f.calls.length,0);
});
test('unknown and pending deliveries require reconciliation',async()=>{
  for(const status of ['pending','unknown']){const f=fixture({info:{latest_delivery:{status}}});
    await assert.rejects(()=>sendAutomaticAttendanceCertificate(f.db,row,f.handler),/reconciliation/);
    assert.equal(f.calls.length,1);}
});
test('missing member award and ineligible certificates are not overridden',async()=>{
  for(const info of [{award_required:true},{can_send:false}]){const f=fixture({info});
    assert.equal((await sendAutomaticAttendanceCertificate(f.db,row,f.handler)).status,'ineligible');assert.equal(f.calls.length,1);}
});
test('provider failures remain retryable; concurrent attempts share request identity',async()=>{
  const a=fixture({failSend:true}),b=fixture();
  await assert.rejects(()=>sendAutomaticAttendanceCertificate(a.db,row,a.handler),/provider failure/);
  await sendAutomaticAttendanceCertificate(b.db,row,b.handler);
  assert.equal(a.calls[1].body.request_id,b.calls[1].body.request_id);
});
