import {createMemberCancellationAuthority} from './memberCancellationAuthority.js';
import {createMemberCancellationExecution} from './memberCancellationExecution.js';
import {amendmentResult} from './memberAmendmentSettlement.js';
import {readMembershipChangePolicy} from './membershipChangePolicy.js';

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
 async function records(context,{after}={}){
  check(context);
  if(after&&!uuid.test(after))fail('Invalid cancellation history cursor.');
  let q=db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).order('id').limit(51);
  if(after)q=q.gt('id',after);
  const rows=amendmentResult(await q);
  if(!Array.isArray(rows))fail('Cancellation history could not be loaded.');
  return {records:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null};
 }
 async function recoverKey(context,{key,fingerprint}){
  check(context);
  if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)
   ||!/^[a-f0-9]{64}$/.test(fingerprint||''))fail('Original confirmation key and fingerprint required.');
  const record=await owned(context,{request_key:key});
  if(!record)return {record:null,provider:null};
  if(record.fingerprint!==fingerprint)fail('The confirmation belongs to a different preview.');
  return recover(context,record.id);
 }
 async function withdraw(context,{id,reason}){
  check(context);
  if(!uuid.test(id||'')||typeof reason!=='string'||!reason.trim()||reason.trim().length>2000){
   fail('A valid cancellation and withdrawal reason are required.');
  }
  const record=amendmentResult(await db.rpc('withdraw_member_cancellation',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,p_reason:reason.trim(),
  }));
  return {record};
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
 // Read-only summary for the CRM "Cancel membership" action. It decides only
 // whether to offer the action; preview/confirm re-verify everything.
 async function status(context){
  check(context);
  const today=now().toISOString().slice(0,10);
  const read=async query=>{
   const {data,error}=await query;
   if(error)fail('Cancellation status could not be verified.');
   return data;
  };
  const member=await read(db.from('member').select('id,membership_cancelled')
   .eq('tenant_id',context.tenantId).eq('id',context.memberId).maybeSingle());
  if(!member)fail('Member not found.');
  const histories=await read(db.from('member_membership_history')
   .select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('status','active')
   .lte('term_start_date',today).gt('membership_renewal_date',today).limit(5));
  const requests=await read(db.from('member_cancellation_request')
   .select('id,effective_date,timing,access_ended_at,withdrawn_at,created_at,financial_state,authority')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId)
   .order('created_at',{ascending:false}).limit(5));
  const latestRow=(requests||[]).find(row=>!row.withdrawn_at)||null;
  let latest=null;
  if(latestRow){
   let providerState=latestRow.authority?.providerPrepared?'not_started':'not_required';
   if(latestRow.authority?.providerPrepared&&latestRow.access_ended_at){
    const {data:stop,error}=await db.from('member_cancellation_provider_stop').select('state')
     .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',latestRow.id).maybeSingle();
    providerState=error?'unknown':stop?.state||'not_started';
   }
   const {authority,...record}=latestRow;
   latest={...record,provider:authority?.providerPrepared?.authority?.provider||null,providerState};
  }
  const current=Array.isArray(histories)?histories:[];
  const source=current.length===1?current[0]:null;
  let blocker=null;
  if(latest&&!latest.access_ended_at)blocker='cancellation_scheduled';
  else if(member.membership_cancelled)blocker='already_cancelled';
  else if(!current.length)blocker='no_current_membership';
  else if(current.length>1)blocker='multiple_current_memberships';
  else if(source.organization_id||source.membership_source==='organisation')blocker='organisation_funded';
  let timing=null;
  try{timing=(await readMembershipChangePolicy(db,context.tenantId))?.policy?.cancellationTiming||null;}catch{timing=null;}
  return {
   eligible:!blocker,blocker,timing,latest,
   current:source&&{id:source.id,tierLabel:source.tier_label||null,termStartDate:source.term_start_date,
    renewalDate:source.membership_renewal_date,paymentMethod:source.payment_method||null,
    billingPeriod:source.billing_period||null,recurring:!!source.billing_agreement_id},
  };
 }
 return {preview,confirm,recover,recoverKey,withdraw,records,status};
}
