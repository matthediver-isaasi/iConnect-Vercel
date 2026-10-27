import {createMemberCancellationAuthority} from './memberCancellationAuthority.js';
import {createMemberCancellationExecution} from './memberCancellationExecution.js';
import {amendmentResult} from './memberAmendmentSettlement.js';

export const MEMBER_CANCELLATION_PROTOCOL='cancellation-v1';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_request_conflict'});};

export function createMemberCancellationRequests({
 db,authority=createMemberCancellationAuthority({db}),
 execution=createMemberCancellationExecution({db}),now=()=>new Date(),
}){
 function check(context){
  if(context.actorKind!=='admin'||![context.tenantId,context.memberId,context.actorId].every(v=>uuid.test(v||''))){
   fail('An authenticated finance administrator is required.');
  }
 }
 async function owned(context,filters){
  check(context);
  let query=db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId);
  for(const [key,value] of Object.entries(filters))query=query.eq(key,value);
  return amendmentResult(await query.maybeSingle());
 }
 async function preview(context,selection){
  check(context);return authority.preview(context,selection);
 }
 async function recover(context,id){
  if(!uuid.test(id||''))fail('A valid cancellation request is required.');
  let record=await owned(context,{id});
  if(!record)fail('Cancellation request not found.');
  if(!record.access_ended_at&&!record.withdrawn_at
   &&record.effective_date<=now().toISOString().slice(0,10)){
   record=amendmentResult(await db.rpc('apply_member_cancellation_access',{
    p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,
   }));
  }
  let provider=null;
  if(record.access_ended_at&&record.authority?.providerPrepared){
   try{
    provider=await execution.recover(context,id);
    // A scheduled cancellation has never submitted its stop. The journal's
    // exclusive claim, not a retry counter, authorizes that first attempt.
    if(provider.state==='pending')provider=await execution.execute(context,id);
   }
   catch{provider={state:'requires_reconciliation'};}
  }
  return {record,provider};
 }
 async function confirm(context,{key,fingerprint,selection,approve}){
  check(context);
  if(approve!==true||typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)
   ||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)){
   fail('Explicit approval, confirmation key and preview fingerprint are required.');
  }
  const existing=await owned(context,{request_key:key});
  if(existing){
   if(existing.actor_id!==context.actorId||existing.fingerprint!==fingerprint
    ||existing.reason!==(typeof selection?.reason==='string'?selection.reason.trim():'')
    ||(selection.timing&&selection.timing!==existing.timing)){
    fail('This cancellation key belongs to another approval.');
   }
   // A lost response must recover the stored approval even though its source
   // purchase is no longer active. Never resolve a new quote on this path.
   return recover(context,existing.id);
  }
  const fresh=await preview(context,selection);
  if(fresh.fingerprint!==fingerprint)fail('Membership, policy or billing evidence changed. Preview again.');
  const record=amendmentResult(await db.rpc('begin_member_cancellation',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_actor_id:context.actorId,
   p_key:key,p_fingerprint:fingerprint,p_authority:fresh.authority,
  }));
  let provider=null;
  if(record.access_ended_at&&record.authority?.providerPrepared){
   try{provider=await execution.execute(context,record.id);}
   catch{provider={state:'requires_reconciliation'};}
  }
  return {record,provider};
 }
 return {preview,confirm,recover};
}
