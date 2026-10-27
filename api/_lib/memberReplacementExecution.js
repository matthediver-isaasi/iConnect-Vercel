import {randomUUID} from 'node:crypto';
import {createMemberAmendmentFinance} from './memberAmendmentFinance.js';
import {amendmentResult} from './memberAmendmentSettlement.js';
import {planMemberReplacementFinance} from './memberReplacementFinancialPlan.js';
import {createMemberReplacementAccounting} from './memberReplacementAccounting.js';
import {inspectMemberReplacementSettlement} from './memberReplacementSettlement.js';
import {buildMemberReplacementHistory} from './memberReplacementHistory.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'replacement_execution_conflict'});};
/**
 * Recovery never initiates an external financial write. Verified settlement
 * and local application can be recovered without a second collection.
 */
export function createMemberReplacementExecutionService({
 db,finance=createMemberAmendmentFinance(),accountingFactory=createMemberReplacementAccounting,
 settlementInspector=inspectMemberReplacementSettlement,
}){
 const rpc=async(name,args)=>amendmentResult(await db.rpc(name,args));
 function authorize(context,input){
  if(context.actorKind!=='admin'||![context.tenantId,context.memberId,context.actorId,input?.authorityId].every(v=>uuid.test(v||''))){
   fail('An authenticated finance administrator and owned authority are required.');
  }
 }
 async function parent(context,input){
  authorize(context,input);
  return amendmentResult(await db.from('member_replacement_execution').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('authority_id',input.authorityId).maybeSingle());
 }
 async function accounting(context,execution){
   const saved=amendmentResult(await db.from('member_change_authority').select('authority')
    .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',execution.authority_id).maybeSingle());
   const authority=saved?.authority;
   if(!authority)fail('Confirmed replacement authority is unavailable.');
   const original=await finance.verifyOriginal({tenant_id:context.tenantId,member_id:context.memberId,
    quote:{sourceSnapshot:authority.sourceSnapshot,currency:authority.calculation.currency,
     originalFullTerm:authority.calculation.finance.original,fundingEvidence:authority.fundingEvidence.providerEvidence}});
   if(execution.plan.steps.some(step=>step.sourceInvoiceId!==original.sourceInvoiceId||step.contactId!==original.contactId)
    ||JSON.stringify([...(execution.plan.sourcePaymentIds||[])].sort())!==JSON.stringify([...(original.originalPaymentIds||[])].sort())
    ||execution.plan.steps.some(step=>step.kind==='credit_note'&&(step.accountCode!==original.accountCode||step.taxCode!==original.taxCode))){
    fail('Original payment or accounting classification changed after approval.');
   }
  const client=await finance.accountingClient(context.tenantId);
  if(execution.plan?.steps?.some(s=>s.providerTenantId!==client.xeroTenantId)){
   fail('Accounting organisation changed after approval.');
  }
   return {adapter:accountingFactory({request:client.request,providerTenantId:client.xeroTenantId}),client,authority};
 }
 async function observe(context,execution,step,evidence){
  return rpc('observe_member_replacement_step',{p_tenant_id:context.tenantId,p_execution_id:execution.id,
   p_step_key:step.key,p_actor_id:context.actorId,p_evidence:evidence});
 }
 async function rows(execution){
  const result=amendmentResult(await db.from('member_replacement_step').select('*')
   .eq('execution_id',execution.id).order('position'));
  if(!Array.isArray(result)||result.length!==execution.plan.steps.length
   ||result.some((row,i)=>row.step_key!==execution.plan.steps[i].key))fail('Financial journal is incomplete.');
  return result;
 }
 async function walk(context,execution,{write=false,reason}={}){
  const applied=amendmentResult(await db.from('member_replacement_application').select('*')
   .eq('tenant_id',context.tenantId).eq('execution_id',execution.id).maybeSingle());
  if(applied)return {execution,application:applied,nextAction:null,accountingComplete:true,entitlementApplied:true};
  const {adapter,client,authority}=await accounting(context,execution),steps=await rows(execution),dependencies={};
  for(const row of steps){
   const step=execution.plan.steps[row.position];
   let evidence=await adapter.inspect(step,dependencies);
   if(evidence.state==='observed'){
    await observe(context,execution,step,evidence);
    dependencies[step.key]=evidence;continue;
   }
   if(row.state==='observed')fail('Previously verified accounting evidence has disappeared.');
   const retryReady=row.state==='uncertain'&&row.retry_at&&Number.isFinite(Date.parse(row.retry_at))
    &&Date.parse(row.retry_at)<=Date.now();
   if(!write)return {execution,steps,nextAction:row.state==='pending'||retryReady?'execute':'reconcile',
    accountingComplete:false,entitlementApplied:false};
   const claim=await rpc('claim_member_replacement_step',{
    p_tenant_id:context.tenantId,p_execution_id:execution.id,p_step_key:step.key,
    p_actor_id:context.actorId,p_reason:reason,
   });
   if(!claim?.claimed)return {execution,steps,nextAction:'reconcile',accountingComplete:false,entitlementApplied:false};
   try{
    evidence=await adapter.submitReservedStep(step,dependencies);
    if(evidence.state!=='observed')fail('Submitted accounting document is not yet verified.');
    await observe(context,execution,step,evidence);
    dependencies[step.key]=evidence;
   }catch(error){
    const throttled=error?.replacementWriteRejected===true;
    await rpc('fail_member_replacement_step',{
     p_tenant_id:context.tenantId,p_execution_id:execution.id,p_step_key:step.key,
     p_actor_id:context.actorId,p_claim_token:claim.step.claim_token,
     p_failure:throttled?'throttled':'uncertain',
     p_delay_seconds:throttled?Math.max(1,Math.min(86400,Math.ceil(Number(error.retryAfter)||60))):null,
    });
    throw error;
   }
  }
  const settlement=await settlementInspector({plan:execution.plan,documents:dependencies,
   request:client.request,providerTenantId:client.xeroTenantId});
  if(settlement.state!=='settled'){
   if(execution.plan.choice==='collect'&&settlement.state==='awaiting_payment'&&settlement.evidence?.verified===true){
    await rpc('queue_member_replacement_payment',{p_tenant_id:context.tenantId,p_execution_id:execution.id,p_evidence:settlement.evidence});
   }
   return {execution,steps:await rows(execution),settlement,
    nextAction:'await_payment',accountingComplete:true,entitlementApplied:false};
  }
  const history=buildMemberReplacementHistory({execution,authority,settlement});
  const application=await rpc('apply_member_replacement',{p_tenant_id:context.tenantId,p_execution_id:execution.id,
   p_actor_id:context.actorId,p_evidence:settlement.evidence,p_history:history});
  return {execution,steps:await rows(execution),settlement,application,nextAction:null,
   accountingComplete:true,entitlementApplied:true};
 }
 async function resume(context,input){
  const execution=await parent(context,input);
  if(!execution)return {execution:null,nextAction:'execute',accountingComplete:false,entitlementApplied:false};
  return walk(context,execution);
 }
 async function execute(context,input){
  authorize(context,input);
  if(input.approve!==true||typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>2000){
   fail('Separate explicit financial approval and a reason are required.');
  }
  let execution=await parent(context,input);
  if(execution){
   if(execution.plan.choice!==input.choice)fail('Approved financial treatment is locked.');
  }else{
   const saved=amendmentResult(await db.from('member_change_authority').select('*')
    .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',input.authorityId).maybeSingle());
   if(!saved)fail('Confirmed replacement authority not found.');
   const a=saved.authority;
   const original=await finance.verifyOriginal({tenant_id:context.tenantId,member_id:context.memberId,
    quote:{sourceSnapshot:a.sourceSnapshot,currency:a.calculation.currency,originalFullTerm:a.calculation.finance.original,
     fundingEvidence:a.fundingEvidence.providerEvidence}});
   const plan=planMemberReplacementFinance({authority:a,executionId:randomUUID(),original,choice:input.choice});
   execution=await rpc('begin_member_replacement',{p_tenant_id:context.tenantId,p_member_id:context.memberId,
    p_authority_id:input.authorityId,p_actor_id:context.actorId,p_reason:input.reason.trim(),p_plan:plan});
  }
  return walk(context,execution,{write:true,reason:input.reason.trim()});
 }
 return {execute,resume};
}
