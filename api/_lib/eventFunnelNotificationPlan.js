import {loadFunnelSessionScope} from './eventFunnelSessionScope.js';
import {calculateScheduledTimeMs,isAbsoluteReminder,pickDayAnchorSessions} from './complexEventReminders.js';
import {calculateScheduledTime} from './scheduleReminders.js';
import {trainingReminderTargets,trainingTargetSnapshot} from './trainingReminderTargets.js';
import {followUpTargets,followUpSnapshot} from './eventFollowUpTargets.js';

export async function readFunnelIntegrationRows(query) {
  const result=[],seen=new Set();
  for(let offset=0;offset<10000;offset+=500) {
    const page=await query.range(offset,offset+499);
    if(page.error||!Array.isArray(page.data))throw new Error('Integration metadata unavailable');
    for(const row of page.data){
      if(!row.id||seen.has(row.id))throw new Error('Integration metadata changed');
      seen.add(row.id);result.push(row);
    }
    if(page.data.length<500)return result;
  }
  throw new Error('Integration metadata exceeds safe batch size');
}

/** Uses the same original booking, timing policies and unique target keys as ordinary reminders. */
export async function planFunnelNotifications({db,tenantId,event,booking,source,now}) {
  if(event.tenant_id!==tenantId||booking.tenant_id!==tenantId||booking.event_id!==event.id
    || booking.status!=='confirmed'||!booking.attendee_email||!Number.isFinite(now?.getTime())) {
    throw new Error('Original registration scope unavailable');
  }
  if(['cancelled','cancelling','deleted','draft'].includes(event.status))throw new Error('Event notifications are not eligible');
  // event_email has no tenant_id: templates belong to the event, whose tenant
  // was verified above.
  const templates=await readFunnelIntegrationRows(db.from('event_email').select('*')
    .eq('event_id',event.id).eq('is_enabled',true)
    .in('email_type',['reminder','follow_up']).order('id'));
  if(!templates.length)return [];
  const complex=source==='complex_event_booking';
  const entries=await readFunnelIntegrationRows(db.from(complex?'complex_event_session':'event_agenda_item')
    .select('*').eq(complex?'complex_event_id':'event_id',event.id).order('id'));
  if(entries.some(e=>e.tenant_id&&e.tenant_id!==tenantId))throw new Error('Programme scope changed');
  const eligible=complex?await loadFunnelSessionScope({db,tenantId,eventId:event.id,ticketClassId:booking.ticket_class_id}):entries;
  const ids=new Set(eligible.map(s=>s.id));
  const ownedEvent={...event,is_complex:complex},rows=[];
  const add=(email,date,extra={})=>{
    if(!Number.isFinite(date?.getTime()))throw new Error('Invalid reminder time');
    if(date<=now)return;
    rows.push({event_email_id:email.id,booking_id:booking.id,attendee_email:booking.attendee_email,
      scheduled_send_time:date.toISOString(),status:'pending',session_id:null,...extra});
  };
  for(const email of templates) {
    if(email.email_type==='follow_up') {
      const targets=followUpTargets({event:ownedEvent,email,entries,accessibleIds:[...ids],now});
      if(targets.skipped.length)throw new Error('Follow-up programme requires attention');
      for(const target of targets.eligible)add(email,target.scheduledTime,{follow_up_target_key:target.key,
        follow_up_booking_table:source,follow_up_target_snapshot:followUpSnapshot(ownedEvent,email,target,booking)});
    } else if(complex) {
      if(isAbsoluteReminder(email))add(email,new Date(calculateScheduledTimeMs(0,email)));
      else for(const anchor of pickDayAnchorSessions(entries.filter(s=>ids.has(s.id)),event.timezone||'UTC'))
        add(email,new Date(calculateScheduledTimeMs(anchor.startMs,email)),{session_id:anchor.session.id});
    } else if(event.is_training) {
      const targets=trainingReminderTargets(event,email,entries,now);
      if(targets.skipped.length)throw new Error('Training reminder programme requires attention');
      for(const target of targets.eligible)add(email,target.scheduledTime,{session_id:target.sessionId,
        training_target_snapshot:trainingTargetSnapshot(event,email,target)});
    } else {
      // A missing ordinary event start date only permits absolute reminders.
      if(!isAbsoluteReminder(email)&&!event.start_date)continue;
      add(email,calculateScheduledTime(event.start_date?new Date(event.start_date):null,email));
    }
  }
  return rows;
}
