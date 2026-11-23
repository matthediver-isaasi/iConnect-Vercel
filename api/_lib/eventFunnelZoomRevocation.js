import {getFunnelZoomAuthority} from './zoomClient.js';
import {readZoomRegistration,listZoomRegistrations,zoomRequest} from './zoomRegistration.js';
export async function recoverFunnelZoomRevocation({db,context,deadlineAt=Date.now()+30000,
  getAuthority=getFunnelZoomAuthority,readSettings=readZoomRegistration,list=listZoomRegistrations,request=zoomRequest}){
  const {order,operation}=context;
  const call=async(action,id=null,epoch=null)=>{
    const result=await db.rpc('event_funnel_zoom_revoke',{p_tenant:order.tenant_id,p_order:order.id,
      p_reversal:operation.id,p_lease:operation.lease_id,p_action:action,p_registration:id,p_epoch:epoch});
    if(['42883','PGRST202'].includes(result.error?.code))return {jobs:[{status:'needs_review'}]};
    if(result.error||!result.data)throw new Error('Provider revocation journal unavailable');
    return result.data;
  };
  const plan=await call('read');if(!Array.isArray(plan.jobs))throw new Error('Provider cleanup plan unavailable');
  let authority;
  const bounded=(token,path,options={})=>request(token,path,{...options,deadlineAt,redirect:'error'});
  for(const job of plan.jobs){
    if(!['pending','writing'].includes(job.status))continue;
    if(Date.now()+2500>=deadlineAt)return {status:'retry'};
    authority||=await getAuthority(order.tenant_id,{deadlineAt});
    const original=job.snapshot;
    if(original?.authorityHash!==authority.authorityHash)return {status:'needs_review'};
    const settings=await readSettings(authority.token,original.kind,original.numericId,{request:bounded});
    if(String(settings.numericId)!==original.numericId
      ||(original.kind==='meetings'?settings.type!==2:settings.type!==5))return {status:'needs_review'};
    const records=await list(authority.token,original.kind,original.numericId,{request:bounded});
    const existing=records.get(original.email);
    if(!existing||existing.status==='denied'){
      // A pending job still needs a durable admission barrier before attesting
      // absence; an in-flight job is reconciled by read, never by another PUT.
      if(job.status==='pending'&&!(await call('begin',job.id,job.epoch)).write)continue;
      await call('complete',job.id,job.epoch);continue;
    }
    if((existing.registrant_id||existing.id)!==original.registrantId)return {status:'needs_review'};
    if(job.status==='writing')continue;
    if(!(await call('begin',job.id,job.epoch)).write)continue;
    try{
      await bounded(authority.token,`${original.kind}/${encodeURIComponent(original.numericId)}/registrants/status`,{
        method:'PUT',body:JSON.stringify({action:'cancel',registrants:[{id:original.registrantId,email:original.email}]})});
      await call('complete',job.id,job.epoch);
    }catch{
      // Leave the durable write marker. A later exhaustive provider read is
      // the only permission to finish an unknown cancellation.
    }
  }
  const final=await call('read');
  if(!Array.isArray(final.jobs))throw new Error('Provider cleanup result unavailable');
  return {status:final.jobs.some(j=>['pending','writing'].includes(j.status))?'retry':
    final.jobs.some(j=>j.status==='needs_review')?'needs_review':'complete'};
}
