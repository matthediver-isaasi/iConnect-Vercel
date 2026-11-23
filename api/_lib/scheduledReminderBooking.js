// The email configuration owns the booking model. Never try the other table:
// simple and complex registrations can have the same UUID.
export async function loadScheduledReminderBooking(db,config,bookingId) {
  if(!config?.tenant_id||!config.event_id||!bookingId)throw new Error('Reminder scope unavailable');
  const source=config.is_complex_event?'complex_event_booking':'booking';
  // Keep inbox identity email-based: a group booking's purchasing member is
  // not necessarily this attendee or the authorized reminder recipient.
  const {data,error}=await db.from(source).select(
    'id,tenant_id,attendee_email,attendee_first_name,attendee_last_name,event_id,status,ticket_class_id,ticket_class_name')
    .eq('tenant_id',config.tenant_id).eq('event_id',config.event_id).eq('id',bookingId).maybeSingle();
  if(error)throw new Error('Reminder booking could not be verified');
  if(data&&(data.tenant_id!==config.tenant_id||data.event_id!==config.event_id||data.id!==bookingId))
    throw new Error('Reminder booking scope changed');
  return data;
}
export function reminderRecipientStillEligible(original,current,recipient) {
  return Boolean(current&&current.status!=='cancelled'&&original
    &&current.id===original.id&&current.tenant_id===original.tenant_id&&current.event_id===original.event_id
    &&typeof recipient==='string'&&recipient.trim()
    &&current.attendee_email===original.attendee_email&&current.attendee_email===recipient);
}
