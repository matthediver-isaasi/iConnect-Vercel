import {selectFunnelZoomTargets} from './eventFunnelZoomReadiness.js';
import {loadFunnelProviderTargets} from './eventFunnelIntegrations.js';
import {getFunnelZoomAuthority} from './zoomClient.js';
import {readZoomRegistration,listZoomRegistrations,zoomRequest} from './zoomRegistration.js';
import {personalisedZoomUrl,createEventEmailZoomResolver} from './eventEmailZoomLinks.js';

/** Persist intent before POST; uncertain attempts may only be reconciled by reads. */
export async function recoverFunnelZoomRegistrations({db,tenantId,event,booking,source,deadlineAt,job,stepId,
  targetsFor=loadFunnelProviderTargets,getAuthority=getFunnelZoomAuthority,request=zoomRequest,
  readSettings=readZoomRegistration,list=listZoomRegistrations,resolverFor=createEventEmailZoomResolver}) {
  const zoom=selectFunnelZoomTargets(await targetsFor({db,tenantId,event,booking,source}));
  if(!zoom)return false;
  const operation=async(action,id=null,payload=null)=>{
    const response=await db.rpc('event_funnel_zoom_operation',{p_tenant:tenantId,p_order:job.order_id,
      p_token:job.lease_token,p_step:stepId,p_action:action,p_id:id,p_payload:payload});
    if(response.error||!response.data)throw new Error('Provider recovery journal unavailable');
    return response.data;
  };
  if(deadlineAt-Date.now()<2000)return false;
  // Verify installed schema and the live parent lease before authentication or
  // any external request; partial rollout must remain retryable and inert.
  await operation('read');
  const authority=zoom.length?await getAuthority(tenantId,{deadlineAt}):null;
  const targets=[];
  for(const target of zoom) {
    // Email's existing authority gives webinar links precedence over meetings.
    const webinar=!!target.zoom_webinar_id,localId=target.zoom_webinar_id||target.zoom_meeting_id;
    const kind=webinar?'webinars':'meetings',field=webinar?'zoom_webinar_id':'zoom_meeting_id';
    if(targets.some(t=>t.kind===kind&&t.localId===localId))continue;
    const row=await db.from(webinar?'zoom_webinar':'zoom_meeting').select(field)
      .eq('tenant_id',tenantId).eq('id',localId).maybeSingle();
    if(row.error||!row.data?.[field])throw new Error('Provider resource unavailable');
    targets.push({kind,localId,numericId:String(row.data[field]),authorityHash:authority.authorityHash});
  }
  targets.sort((a,b)=>`${a.kind}:${a.localId}`.localeCompare(`${b.kind}:${b.localId}`));
  await operation('plan',null,targets);
  const pending=await operation('read');
  if(pending.ready)return true;
  const bounded=(token,path,options={})=>request(token,path,{...options,deadlineAt,redirect:'error'});
  const resolve=resolverFor(db,tenantId,booking.attendee_email,{
    getToken:async()=>authority.token,readSettings:(...args)=>readSettings(...args,{request:bounded}),request:bounded});
  for(const item of pending.jobs) {
    if(deadlineAt-Date.now()<2000)break;
    if(item.authority_hash!==authority.authorityHash)throw new Error('Provider authority changed');
    const settings=await readSettings(authority.token,item.kind,item.numeric_id,{request:bounded});
    if(String(settings.numericId)!==item.numeric_id)throw new Error('Provider resource identity changed');
    if(typeof settings.registration_required!=='boolean')throw new Error('Provider registration requirements unavailable');
    if(settings.registration_required===false) {
      if(!settings.join_url)continue;
      await operation('observed',item.id,{outcome:'not_required'});continue;
    }
    const records=await list(authority.token,item.kind,item.numeric_id,{request:bounded});
    const existing=records.get(booking.attendee_email.trim().toLowerCase());
    if(existing) {
      if(existing.status==='approved'&&(existing.id||existing.registrant_id)) {
        const target=targets.find(t=>t.kind===item.kind&&t.numericId===item.numeric_id);
        if(!target)throw new Error('Provider plan changed');
        await resolve({[item.kind==='meetings'?'zoom_meeting_id':'zoom_webinar_id']:target.localId});
        await operation('observed',item.id,{outcome:'approved',registrantId:existing.registrant_id||existing.id});
      }
      continue;
    }
    // Existing access can be adopted for recurring resources, but creating
    // occurrence-specific registrations requires separately captured authority.
    if((item.kind==='meetings'&&settings.type!==2)||(item.kind==='webinars'&&settings.type!==5))continue;
    if(item.state!=='pending'||deadlineAt-Date.now()<4000)continue;
    if(!(await operation('begin',item.id)).write)continue;
    if(deadlineAt-Date.now()<2000) {await operation('not_submitted',item.id);continue;}
    let receipt;
    try {
      const names=String(booking.attendee_name||'Guest Attendee').trim().split(/\s+/);
      receipt=await bounded(authority.token,`${item.kind}/${encodeURIComponent(item.numeric_id)}/registrants`,{
        method:'POST',body:JSON.stringify({email:booking.attendee_email.trim().toLowerCase(),
          first_name:names.shift()||'Guest',last_name:names.join(' ')||'Attendee'})});
    } catch {continue;} // May have succeeded: never reset the persisted write marker.
    if(personalisedZoomUrl(receipt?.join_url)&&(receipt.registrant_id||receipt.id))
      await operation('observed',item.id,{outcome:'approved',registrantId:receipt.registrant_id||receipt.id});
  }
  return (await operation('read')).ready===true;
}
