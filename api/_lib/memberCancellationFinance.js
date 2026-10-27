import {amendmentResult} from './memberAmendmentSettlement.js';
import {createMemberAmendmentFinance} from './memberAmendmentFinance.js';
import {createMemberCancellationFinancialPreparation} from './memberCancellationFinancialPreparation.js';
import {createMemberCancellationFinancialExecution} from './memberCancellationFinancialExecution.js';
const fail=message=>{throw Object.assign(new Error(message),{status:409,code:'cancellation_finance_conflict'});};

/** The worker resumes only explicitly approved immutable plans. Ending access
 * is not blanket permission to choose a refund/credit or fabricate a balance. */
export function createMemberCancellationFinance({
 db,finance=createMemberAmendmentFinance(),resolveMonthly,
 preparation=createMemberCancellationFinancialPreparation({db,finance,resolveMonthly}),
 execution=createMemberCancellationFinancialExecution({db,accountingForTenant:finance.accountingClient}),
 now=()=>Date.now(),
}){
 function actor(context){
  if(context?.actorKind!=='admin'||!context.tenantId||!context.memberId||!context.actorId){
   fail('An authenticated membership finance administrator is required.');
  }
  return {...context,isAdmin:true};
 }
 async function owned(context,id){
  const record=amendmentResult(await db.from('member_cancellation_request').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',id).maybeSingle());
  if(!record||record.id!==id||record.tenant_id!==context.tenantId||record.member_id!==context.memberId){
   fail('Owned cancellation not found.');
  }
  return record;
 }
 async function recover(context,id,{budgetMs=15000,maxSteps=3}={}){
  const a=actor(context),record=await owned(a,id),started=now();
  if(record.financial_state==='settled')return {state:'done',record};
  if(!record.access_ended_at)return {state:'pending',message:'Membership cancellation has not taken effect.'};
  const financial=amendmentResult(await db.from('member_cancellation_finance').select('*')
   .eq('tenant_id',a.tenantId).eq('member_id',a.memberId).eq('request_id',id).maybeSingle());
  if(!financial)return {state:'pending',needsApproval:true,message:'Review and approve the financial outcome.'};
  if(financial.request_id!==id||financial.tenant_id!==a.tenantId||financial.member_id!==a.memberId
   ||!Array.isArray(financial.plan?.steps))fail('Owned approved financial plan required.');
  const rows=[];
  for(let offset=0;;offset+=500){
   const page=amendmentResult(await db.from('member_cancellation_finance_step').select('step_key,state')
    .eq('request_id',id).order('id').range(offset,offset+499));
   if(!Array.isArray(page)||rows.length+page.length>2100)fail('Complete bounded financial journal required.');
   rows.push(...page);if(page.length<500)break;
  }
  if(rows.length!==financial.plan.steps.length
   ||new Set(rows.map(s=>s.step_key)).size!==rows.length
   ||rows.some(s=>!financial.plan.steps.some(p=>p.key===s.step_key)))fail('Financial journal differs from its approval.');
  let attempted=0;
  for(const step of financial.plan.steps){
   if(rows.find(s=>s.step_key===step.key).state==='observed')continue;
   if(attempted>=Math.max(1,Math.min(maxSteps,5))||now()-started>=Math.max(1000,Math.min(budgetMs,20000))){
    return {state:'pending',message:'Approved financial operations are continuing.'};
   }
   const operation=await execution.run(a,id,step.key);attempted++;
   if(operation.state!=='observed'){
    return {state:'pending',needsReview:operation.state==='uncertain',
     message:operation.state==='uncertain'?'An accounting operation needs read-only reconciliation.':'An accounting operation is waiting to retry.'};
   }
  }
  const result=await execution.reconcileBalance(a,id);
  return {state:result.state==='settled'?'done':'pending',balanceState:result.state,
   evidence:result.evidence,record:result.record,
   message:result.state==='awaiting_payment'?'Waiting for payment of the remaining earned balance.':
    result.state==='awaiting_refund'?'Waiting for the recorded bank-reconciled refund.':undefined};
 }
 return {
  preview:(context,id,selection={})=>preparation.preview(actor(context),id,selection),
  confirm:async(context,id,approval)=>{
   await preparation.confirm(actor(context),id,approval);
   return recover(context,id);
  },
  recover,
 };
}
