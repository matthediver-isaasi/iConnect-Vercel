import {amendmentResult} from './memberAmendmentSettlement.js';
import {createMemberCancellationAccounting} from './memberCancellationAccounting.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {inspectMemberCancellationBalance} from './memberCancellationBalance.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_execution_conflict'});};

/** Private journal executor. Its caller must resolve and approve the financial
 * plan separately; a recovery invocation never creates a different plan. */
export function createMemberCancellationFinancialExecution({db,accountingForTenant}){
 async function load(context,id){
  if(!context?.isAdmin||!context.actorId||!context.memberId||!context.tenantId)fail('Administrator context required.');
  const record=amendmentResult(await db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',id).maybeSingle());
  const financial=amendmentResult(await db.from('member_cancellation_finance').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('request_id',id).maybeSingle());
  if(!record?.access_ended_at||!financial||record.id!==id||financial.request_id!==id
   ||[record,financial].some(r=>r.tenant_id!==context.tenantId||r.member_id!==context.memberId)){
   fail('Owned applied cancellation and approved financial plan required.');
  }
  const steps=[];
  for(let offset=0;;offset+=500){
   const page=amendmentResult(await db.from('member_cancellation_finance_step').select('*')
    .eq('request_id',id).order('id').range(offset,offset+499));
   if(!Array.isArray(page))fail('Financial journal could not be loaded.');
   steps.push(...page);
   if(steps.length>2100)fail('Financial journal exceeds its bounded scope.');
   if(page.length<500)break;
  }
  if(steps.length!==financial.plan.steps.length
   ||steps.some(s=>s.request_id!==id||!financial.plan.steps.some(p=>
    p.key===s.step_key&&monthlyAmendmentFingerprint(p)===monthlyAmendmentFingerprint(s.descriptor)))){
   fail('Financial journal does not match its approved plan.');
  }
  const client=await accountingForTenant(context.tenantId);
  if(client.xeroTenantId!==financial.source_evidence.providerTenantId)fail('Accounting tenant changed.');
  return {record,financial,steps,client,adapter:createMemberCancellationAccounting({
   request:client.request,providerTenantId:client.xeroTenantId,
  })};
 }
 async function run(context,id,stepKey){
  const scope=await load(context,id),step=scope.steps.find(s=>s.step_key===stepKey);
  if(!step)fail('Approved financial step not found.');
  if(step.state==='observed')return step;
  let operation=step,claimed=false;
  if(step.state==='pending'){
   const claim=amendmentResult(await db.rpc('claim_member_cancellation_finance_step',{
    p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,p_step_key:stepKey,
   }));
   operation=claim.operation;claimed=claim.claimed===true;
   if(!claimed&&operation.state==='pending')return operation;
  }
  const dependencies=Object.fromEntries(scope.steps.filter(s=>s.state==='observed').map(s=>[s.step_key,s.evidence]));
  let evidence;
  try{
   if(claimed&&operation.descriptor.readOnly!==true){
    // A previous read is not fresh cash evidence. Recheck the source invoices
    // before every new external write, while allowing payments against earned
    // debt to increase the paid balance.
    try{
     for(const original of scope.financial.plan.steps.filter(s=>s.kind==='original_invoice')){
      await scope.adapter.inspect(original,dependencies);
     }
    }catch(error){
     error.replacementWriteRejected=true;
     throw error;
    }
   }
   evidence=claimed
    ?await scope.adapter.submitReservedStep(operation.descriptor,dependencies)
    :await scope.adapter.inspect(operation.descriptor,dependencies);
   if(evidence.state==='absent')evidence={...evidence,state:'missing'};
  }catch(error){
   // A recovery read that fails does not prove the earlier write failed.
   // Only this invocation's exclusive, provably unsubmitted attempt can retry.
   evidence=claimed&&(error.replacementWriteRejected===true||operation.descriptor.readOnly===true)
    ?{state:'not_submitted',provenNotSubmitted:true,retryAfter:Math.max(5,Math.min(Number(error.retryAfter)||60,86400))}
    :{state:'uncertain'};
  }
  return amendmentResult(await db.rpc('observe_member_cancellation_finance_step',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,
   p_step_key:stepKey,p_claim_token:operation.claim_token,p_evidence:evidence,
  }));
 }
 async function reconcileBalance(context,id){
  const scope=await load(context,id);
  const result=await inspectMemberCancellationBalance({
   plan:scope.financial.plan,steps:scope.steps,adapter:scope.adapter,request:scope.client.request,
  });
  if(result.state==='awaiting_reconciliation')return result;
  const record=amendmentResult(await db.rpc('record_member_cancellation_balance',{
   p_tenant_id:context.tenantId,p_member_id:context.memberId,p_id:id,p_actor_id:context.actorId,
   p_state:result.state,p_evidence:result.evidence,
  }));
  return {...result,record};
 }
 return {run,reconcileBalance};
}
