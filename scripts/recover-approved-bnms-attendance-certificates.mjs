// Approved recovery scope only. Default is read-only eligibility; --send delivers.
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { supabase: db } = await import('../api/_lib/database.js');
const { handleAttendeeCertificate } = await import('../api/reports/attendee-cpd-certificate.js');
const { sendAutomaticAttendanceCertificate } = await import('../api/_lib/automaticAttendanceCertificate.js');
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const eventId = '4a21aa95-0c72-4317-a8eb-638ec73c96b0';
const targets = await db.from('attendance_target').select('id')
  .eq('tenant_id',tenantId).eq('event_id',eventId);
if(targets.error)throw targets.error;
if(targets.data.length!==1)throw new Error('Expected exactly one event attendance target');
const eligible = await db.from('attendance_current_outcome').select('booking_id,booking_type')
  .eq('tenant_id',tenantId).eq('attendance_target_id',targets.data[0].id).eq('status','attended');
if(eligible.error)throw eligible.error;
if(eligible.data.length!==39)throw new Error('Approved attendance cohort changed; review before sending');
const counts = {};
for (const booking of eligible.data) {
  let result;
  if(process.argv.includes('--send')) {
    try { result = await sendAutomaticAttendanceCertificate(db,{...booking,tenant_id:tenantId,trigger_type:'attendance'}); }
    catch(error){result={status:'error',reason:error.message};}
  } else {
    let httpStatus=200;
    const res={setHeader(){},status(code){httpStatus=code;return this;},json(body){
      result={status:httpStatus===200&&body.can_send&&!body.award_required?'ready':'blocked',
        reason:body.send_reason||body.reason||(body.award_required?'Member CPD award requires review':null)};
    }};
    await handleAttendeeCertificate({method:'GET',query:{booking_id:booking.booking_id,booking_source:'standard'}},res,
      {db,contextFor:async()=>({tenantId,isAuthenticated:true}),adminAccess:async()=>true});
  }
  counts[result.status]=(counts[result.status]||0)+1;
  console.log(JSON.stringify({bookingId:booking.booking_id,...result}));
}
console.log(JSON.stringify({mode:process.argv.includes('--send')?'send':'preview',counts}));
