import {createMemberDdCancellationEvidence,DD_CANCELLATION_MESSAGES} from './memberDdCancellationEvidence.js';
import {createMemberCancellationProvider} from './memberCancellationProvider.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_.:-]{8,128}$/;
const MAX_REASON=1000;
const SUCCESS=new Set(['confirmed','paid_out']);
const IN_FLIGHT=new Set(['pending_customer_approval','pending_submission','submitted']);
const fail=(message,status=409,code='member_cancellation_conflict')=>{
 throw Object.assign(new Error(message),{status,code});
};
const result=({data,error})=>{
 if(error)throw Object.assign(new Error(error.message||'Database operation failed'),{code:error.code,dbError:true});
 return data;
};
const missingContract=error=>['PGRST202','PGRST204','PGRST205','42883','42P01','42703'].includes(error?.code);

/**
 * Public shape of a member-mode request. Administrator-only detail (actor,
 * financial journal, raw snapshots) is never returned to the member.
 */
export function memberCancellationView(record,stop){
 if(!record)return null;
 let providerState='not_required';
 if(record.authority?.providerPrepared)providerState=stop?.state||'unknown';
 return {
  id:record.id,state:record.access_ended_at?'cancelled':'scheduled',
  effectiveDate:record.effective_date,paidThroughDate:record.paid_through_date,
  requestedAt:record.created_at,accessEndedAt:record.access_ended_at||null,
  fallbackRoleName:record.authority?.fallbackRoleName||null,
  collectionsStopped:!!record.collections_fenced_at,
  // "stopped" is the only state presented as proof future collections stopped.
  providerState:providerState==='claimed'?'uncertain':providerState,
  needsReview:['uncertain','claimed','unknown'].includes(providerState)||record.financial_state==='manual_review',
 };
}

export function createMemberDdCancellation({
 db,evidence=createMemberDdCancellationEvidence({db}),
 provider=createMemberCancellationProvider(),now=()=>new Date(),
}){
 function self(context){
  // Member actions are strictly self-scoped: the actor is the member.
  if(context?.actorKind!=='member'||![context.tenantId,context.memberId].every(v=>uuid.test(v||''))
   ||context.actorId!==context.memberId)fail('Sign in with your member account.',403,'member_required');
 }
 async function available(){
  const {data,error}=await db.rpc('member_dd_cancellation_available',{});
  if(error){if(missingContract(error))return false;throw Object.assign(new Error('readiness'),{code:error.code});}
  return data===true;
 }
 async function latestRequest(tenantId,memberId){
  const rows=result(await db.from('member_cancellation_request').select('*')
   .eq('tenant_id',tenantId).eq('member_id',memberId).eq('mode','member_paid_period')
   .is('withdrawn_at',null).is('cleared_at',null).order('created_at',{ascending:false}).limit(1));
  return rows?.[0]||null;
 }
 async function stopFor(record){
  if(!record?.authority?.providerPrepared)return null;
  return result(await db.from('member_cancellation_provider_stop').select('id,state,updated_at')
   .eq('tenant_id',record.tenant_id).eq('member_id',record.member_id).eq('id',record.id).maybeSingle());
 }
 // Only the latest, still-relevant request is shown; an old completed one
 // after a genuine restart (new purchase) is cleared or superseded.
 async function existingView(tenantId,memberId){
  const record=await latestRequest(tenantId,memberId);
  if(!record)return null;
  if(record.access_ended_at){
   const ended=new Date(record.access_ended_at).getTime();
   if(now().getTime()-ended>1000*60*60*24*90)return null;
  }
  return memberCancellationView(record,await stopFor(record));
 }

 async function status(context){
  self(context);
  try{
   if(!await available())return {available:false,eligible:false,blocker:'not_installed',
    message:DD_CANCELLATION_MESSAGES.not_installed,request:null};
   const request=await existingView(context.tenantId,context.memberId);
   if(request)return {available:true,eligible:false,blocker:request.state==='scheduled'?'cancellation_scheduled':'already_cancelled',
    message:null,request};
   const found=await evidence.evaluate(context);
   return {available:true,eligible:found.eligible,blocker:found.blocker,message:found.message||null,request:null,
    // A reason-free summary only. Detailed figures come from preview.
    ...(found.evidence?{progress:{successfulCollections:found.evidence.successfulCollections,
     threshold:found.evidence.threshold}}:{})};
  }catch{
   return {available:false,eligible:false,blocker:'evidence_unavailable',
    message:DD_CANCELLATION_MESSAGES.evidence_unavailable,request:null};
  }
 }

 function authorityFrom(context,found,reason){
  const e=found.evidence;
  return {
   version:1,mode:'member_paid_period',tenantId:context.tenantId,memberId:context.memberId,actorId:context.memberId,
   reason,threshold:e.threshold,successfulCollections:e.successfulCollections,collectionsInFlight:e.collectionsInFlight,
   sequenceStartAgreementId:e.sequenceStartAgreementId,sequenceLength:e.sequenceLength,
   lineageAgreementIds:e.lineageAgreementIds||[e.agreementId].filter(Boolean),
   effectiveDate:e.effectiveDate,paidThroughDate:e.paidThroughDate,
   fallbackRoleId:e.fallbackRole.id,fallbackRoleName:e.fallbackRole.name,
   sourceSnapshot:found.snapshots.source,agreementSnapshot:found.snapshots.agreement,planSnapshot:found.snapshots.plan,
  };
 }
 function normaliseReason(reason){
  if(typeof reason!=='string')fail('Please tell us why you are cancelling.',400,'reason_required');
  const text=reason.replace(/\s+/g,' ').trim();
  if(!text||text.length>MAX_REASON)fail(`Please give a reason of up to ${MAX_REASON} characters.`,400,'reason_required');
  return text;
 }

 async function preview(context,{reason}={}){
  self(context);
  const text=normaliseReason(reason);
  if(!await available())fail(DD_CANCELLATION_MESSAGES.not_installed,503,'not_installed');
  const existing=await existingView(context.tenantId,context.memberId);
  if(existing)return {eligible:false,blocker:'cancellation_scheduled',request:existing};
  const found=await evidence.evaluate(context);
  if(!found.eligible)return {eligible:false,blocker:found.blocker,message:found.message};
  const authority=authorityFrom(context,found,text);
  const e=found.evidence;
  return {
   eligible:true,fingerprint:monthlyAmendmentFingerprint(authority),
   summary:{
    paidThroughDate:e.paidThroughDate,effectiveDate:e.effectiveDate,
    fallbackRoleName:e.fallbackRole.name,tierLabel:e.tierLabel,
    successfulCollections:e.successfulCollections,threshold:e.threshold,
    collectionsInFlight:e.collectionsInFlight,
    futureCollections:'stopped_at_confirmation',
   },
  };
 }

 async function submitStop(context,record){
  // The member cannot choose or retry the destructive call: only the journal's
  // exclusive claim authorises the first attempt.
  const claim=result(await db.rpc('claim_member_dd_cancellation_provider_stop',{
   p_tenant_id:record.tenant_id,p_member_id:record.member_id,p_id:record.id,p_actor_id:context.actorId,
  }));
  const row=result(await db.from('member_cancellation_provider_stop').select('*')
   .eq('tenant_id',record.tenant_id).eq('member_id',record.member_id).eq('id',record.id).maybeSingle());
  if(!row||row.prepared?.fingerprint!==row.fingerprint)fail('Provider stop journal is unavailable.');
  let observation;
  if(claim?.claimed){
   if(row.claim_token!==claim.operation?.claim_token||row.state!=='claimed')fail('Provider stop claim changed.');
   try{observation=await provider.submitReservedStop(row.prepared,row);}
   catch{observation={state:'uncertain',subscriptionId:row.prepared.authority.subscriptionId};}
  }else if(row.state==='stopped'||row.state==='pending'){
   return row;
  }else{
   if(!row.claim_token)return row;
   try{observation=await provider.reconcile(row.prepared);}
   catch{return row;}
  }
  return result(await db.rpc('record_member_dd_cancellation_provider_stop',{
   p_tenant_id:record.tenant_id,p_member_id:record.member_id,p_id:record.id,p_actor_id:context.actorId,
   p_claim_token:row.claim_token,p_evidence:observation,
  }));
 }

 async function confirm(context,{key,fingerprint,reason,approve}={}){
  self(context);
  if(approve!==true||typeof key!=='string'||!KEY.test(key)||!/^[a-f0-9]{64}$/.test(fingerprint||'')){
   fail('Explicit confirmation, a confirmation key and the preview are required.',400,'confirmation_required');
  }
  const text=normaliseReason(reason);
  if(!await available())fail(DD_CANCELLATION_MESSAGES.not_installed,503,'not_installed');
  const replay=result(await db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('request_key',key).maybeSingle());
  if(replay){
   if(replay.mode!=='member_paid_period'||replay.authority?.previewFingerprint!==fingerprint)fail('This confirmation belongs to another request.');
   return recover(context,{id:replay.id});
  }
  const found=await evidence.evaluate(context);
  if(!found.eligible)fail(found.message||'Your membership can no longer be cancelled online.',409,found.blocker||'ineligible');
  const authority=authorityFrom(context,found,text);
  if(monthlyAmendmentFingerprint(authority)!==fingerprint)fail('Your membership details changed. Please review the cancellation again.',409,'preview_changed');
  const plan=found.snapshots.plan;
  let providerPrepared=null;
  if(found.evidence.planCompleted){
   // Every instalment was collected and the subscription finished: there is
   // nothing to stop at the provider, and no destructive call is made.
  }else if(plan.gocardless_subscription_id){
   try{
    providerPrepared=await provider.prepareOwnedSubscription({
     provider:'gocardless',environment:plan.environment,tenantId:context.tenantId,memberId:context.memberId,
     agreementId:found.snapshots.agreement.id,subscriptionId:plan.gocardless_subscription_id,
     mandateId:plan.gocardless_mandate_id||found.snapshots.agreement.gocardless_mandate_id,payerId:found.snapshots.agreement.gocardless_customer_id,
    });
   }catch{
    fail('We could not verify your Direct Debit with the bank right now. Nothing has changed; please try again later.',503,'provider_unavailable');
   }
   // "finished" means collections completed naturally; the reserved stop
   // re-reads the provider first and records it without cancelling anything.
   const obs=providerPrepared.observation;
   if(!(obs?.state==='active'||(obs?.state==='stopped'&&obs.providerStatus==='finished'))){
    fail('Your Direct Debit needs review before it can be cancelled online. Please contact your membership team.',409,'provider_review');
   }
  }else if(plan.metadata?.collection_mode!=='dynamic'){
   fail(DD_CANCELLATION_MESSAGES.agreement_unverified,409,'agreement_unverified');
  }
  const stored={...authority,previewFingerprint:fingerprint,
   providerPrepared:providerPrepared&&{version:providerPrepared.version,kind:providerPrepared.kind,
    authority:providerPrepared.authority,fingerprint:providerPrepared.fingerprint}};
  const record=result(await db.rpc('begin_member_dd_paid_period_cancellation',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_key:key,
   p_fingerprint:monthlyAmendmentFingerprint(stored),p_authority:stored,
  }));
  return finishConfirm(context,record);
 }

 async function finishConfirm(context,record){
  let stop=null;
  if(record.authority?.providerPrepared&&!record.access_ended_at){
   try{stop=await submitStop(context,record);}
   catch{stop={state:'uncertain'};}
  }else stop=await stopFor(record).catch(()=>null);
  return {request:memberCancellationView(record,stop)};
 }

 // Applies the boundary when due and reconciles provider state. Safe to call
 // repeatedly from the browser (self only) and from scheduled recovery.
 async function recoverRecord(context,record){
  if(record.mode!=='member_paid_period')fail('Not a member cancellation.');
  let current=record;
  if(!current.access_ended_at&&!current.withdrawn_at&&current.effective_date<=now().toISOString().slice(0,10)){
   current=result(await db.rpc('apply_member_dd_paid_period_cancellation',{
    p_tenant_id:current.tenant_id,p_member_id:current.member_id,p_id:current.id,p_actor_id:context.actorId,
   }));
  }
  let stop=null;
  if(current.authority?.providerPrepared&&!current.withdrawn_at){
   try{stop=await submitStop(context,current);}catch{stop={state:'uncertain'};}
  }
  return {record:current,stop};
 }
 async function recover(context,{id}={}){
  self(context);
  if(!uuid.test(id||''))fail('A valid cancellation is required.',400,'invalid_request');
  const record=result(await db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',id).maybeSingle());
  if(!record||record.mode!=='member_paid_period')fail('Cancellation not found.',404,'not_found');
  const {record:current,stop}=await recoverRecord(context,record);
  return {request:memberCancellationView(current,stop)};
 }

 // Member-mode finance observation. The paid period was fully funded at
 // confirmation, so nothing is charged or refunded automatically. Any payment
 // in flight at confirmation, or created/settled after the fence, is routed to
 // the existing manual reconciliation policy instead of changing the dates.
 async function recoverFinance(context,record){
  if(record.mode!=='member_paid_period'||!record.access_ended_at)return {state:'pending'};
  const planIds=result(await db.from('membership_payment_plans').select('id')
   .eq('tenant_id',record.tenant_id).eq('member_id',record.member_id)
   .eq('billing_agreement_id',record.source_snapshot?.billing_agreement_id)).map(p=>p.id);
  const payments=planIds.length?result(await db.from('gocardless_payments')
   .select('gocardless_payment_id,status,charge_date,created_at,confirmed_at,refund_status')
   .eq('tenant_id',record.tenant_id).in('plan_id',planIds).limit(1000)):[];
  const fence=record.collections_fenced_at;
  const late=payments.filter(p=>(p.created_at&&p.created_at>fence)
   ||(SUCCESS.has(p.status)&&p.confirmed_at&&p.confirmed_at>fence));
  const inFlight=payments.filter(p=>IN_FLIGHT.has(p.status));
  const review=late.length||inFlight.length||Number(record.calculation?.collectionsInFlight||0)>0;
  if(review&&inFlight.length){
   // Wait for in-flight payments to resolve before recording the outcome.
   return {state:'pending',delaySeconds:3600,message:'Collections submitted before cancellation are still in flight'};
  }
  await db.rpc('record_member_dd_cancellation_finance',{
   p_tenant_id:record.tenant_id,p_member_id:record.member_id,p_id:record.id,p_actor_id:context.actorId,
   p_state:review?'manual_review':'settled',
   p_evidence:{latePayments:late.map(p=>p.gocardless_payment_id),noAutomaticRefund:true},
  }).then(result);
  return review?{state:'manual_review',message:'Late Direct Debit receipts need reconciliation'}
   :{state:'done',evidence:{noBalanceChange:true}};
 }

 return {status,preview,confirm,recover,recoverRecord,recoverFinance};
}
