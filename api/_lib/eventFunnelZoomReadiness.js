import {loadFunnelProviderTargets} from './eventFunnelIntegrations.js';
import {createEventEmailZoomResolver} from './eventEmailZoomLinks.js';
import {getFunnelZoomAuthority} from './zoomClient.js';
import {readZoomRegistration,zoomRequest} from './zoomRegistration.js';

/**
 * Adopt existing provider preparation through the same access checks as email.
 * This function only reads Zoom; absence never authorizes a registration POST.
 * New registrations still require the separate durable write/recovery adapter.
 */
export function selectFunnelZoomTargets(targets) {
  const zoom=[];
  for(const target of targets) {
    // Non-Zoom provisioning must have its own verified adapter.
    if(Object.entries(target).some(([key,value])=>value&&/^(teams_|backstage_|lms_)/i.test(key)))return null;
    if(target.zoom_meeting_id||target.zoom_webinar_id)zoom.push(target);
    else if(Object.entries(target).some(([key,value])=>value&&/^zoom_/i.test(key))
      || /zoom\.us|teams\.microsoft\.com|backstage\./i.test(String(target.location||''))
      || String(target.event_type||'').toLowerCase()==='zoom')return null;
  }
  return zoom;
}
export async function verifyExistingFunnelZoomAccess({db,tenantId,event,booking,source,deadlineAt,
  targetsFor=loadFunnelProviderTargets,getAuthority=getFunnelZoomAuthority,
  resolverFor=createEventEmailZoomResolver,request=zoomRequest}) {
  const zoom=selectFunnelZoomTargets(await targetsFor({db,tenantId,event,booking,source}));
  if(!zoom)return false;
  if(!zoom.length)return true;
  if(deadlineAt-Date.now()<2000)return false;
  const authority=await getAuthority(tenantId,{deadlineAt});
  const boundedRequest=(token,path,options={})=>request(token,path,{...options,deadlineAt,redirect:'error'});
  const resolve=resolverFor(db,tenantId,booking.attendee_email,{
    getToken:async()=>authority.token,
    readSettings:(token,kind,id)=>readZoomRegistration(token,kind,id,{request:boundedRequest}),
    request:boundedRequest,
  });
  for(const target of zoom) {
    if(deadlineAt-Date.now()<2000)return false;
    if(!await resolve(target))return false;
  }
  return true;
}
