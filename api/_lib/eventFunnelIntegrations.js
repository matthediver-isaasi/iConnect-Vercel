import {ensureBookingToken,ensureComplexSessionTokens} from './checkinService.js';
import {planFunnelNotifications,readFunnelIntegrationRows} from './eventFunnelNotificationPlan.js';
import {loadFunnelSessionScope} from './eventFunnelSessionScope.js';

function hasProviderTarget(row) {
  return Object.entries(row).some(([key,value])=>
    value && /^(zoom_|teams_|backstage_|lms_)/i.test(key))
    || /zoom\.us|teams\.microsoft\.com|backstage\./i.test(String(row.location||''));
}
// Explicitly established absence is the only no-op. Configured providers await
// their own durable adapters; they must never be silently treated as completed.
export async function funnelNeedsNoProvider({db,tenantId,event,booking,source}) {
  if(hasProviderTarget(event))return false;
  return !(await loadFunnelProviderTargets({db,tenantId,event,booking,source})).some(hasProviderTarget);
}
export async function loadFunnelProviderTargets({db,tenantId,event,booking,source}) {
  let entries;
  if(source==='complex_event_booking') {
    const permitted=await loadFunnelSessionScope({db,tenantId,eventId:event.id,ticketClassId:booking.ticket_class_id});
    const ids=new Set(permitted.map(s=>s.id));
    entries=(await readFunnelIntegrationRows(db.from('complex_event_session').select('*')
      .eq('tenant_id',tenantId).eq('complex_event_id',event.id).order('id'))).filter(s=>ids.has(s.id));
  } else {
    entries=await readFunnelIntegrationRows(db.from('event_agenda_item').select('*').eq('event_id',event.id).order('id'));
    if(entries.some(row=>row.tenant_id&&row.tenant_id!==tenantId))throw new Error('Agenda scope changed');
  }
  return [event,...entries];
}
async function verifyProviders(input) {
  const {recoverFunnelZoomRegistrations}=await import('./eventFunnelZoomRecovery.js');
  return recoverFunnelZoomRegistrations(input);
}
export async function deliverFunnelIntegrations({db,job,deadlineAt=Date.now()+10000,
  notifications=planFunnelNotifications,providerReady=verifyProviders,
  simpleCheckin=ensureBookingToken,complexCheckin=ensureComplexSessionTokens,now=()=>Date.now()}) {
  const operation=async(action,step=null,rows=null)=>{
    const response=await db.rpc('event_funnel_integration_operation',{p_tenant:job.tenant_id,
      p_order:job.order_id,p_token:job.lease_token,p_action:action,p_step:step,p_rows:rows});
    if(response.error||!response.data)throw new Error('Integration progress unavailable');
    return response.data;
  };
  const plan=await operation('read');
  if(!Array.isArray(plan.jobs))throw new Error('Integration plan unavailable');
  for(const item of plan.jobs) {
    if(deadlineAt-now()<2000)break;
    const input={db,job,stepId:item.id,tenantId:job.tenant_id,event:item.event,booking:item.booking,source:item.booking_source,deadlineAt,
      now:new Date(plan.serverNow)};
    let rows=null;
    try {
      if(item.step==='checkin') {
        if(item.booking_source==='booking')await simpleCheckin(item.booking.id,job.tenant_id,{db,strict:true});
        else await complexCheckin(item.booking,job.tenant_id,{db,strict:true});
      } else if(item.step==='notifications') rows=await notifications(input);
      else if(item.step==='providers') {if(!await providerReady(input))continue;}
      else throw new Error('Unsupported integration step');
      await operation('finish',item.id,rows);
    } catch {
      // Failed siblings retain their progress independently. No booking, charge
      // or successful prior step is recreated in order to retry this one.
    }
  }
  return {status:(await operation('read')).status};
}
