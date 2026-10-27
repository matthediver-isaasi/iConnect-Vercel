import {createMemberAmendmentSettlementService,amendmentResult} from './memberAmendmentSettlement.js';
import {AMENDMENT_UUID} from './memberAmendments.js';

const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status,code:'change_execution_conflict'});};
// Called only after the existing finance-admin endpoint authorizes context.
export function createMemberChangeExecutionService({db,settlement=createMemberAmendmentSettlementService({db})}) {
  function validate(context,input) {
    if(context.actorKind!=='admin' || !context.actorId || !context.tenantId
      || !AMENDMENT_UUID.test(context.memberId||'') || !AMENDMENT_UUID.test(input?.authorityId||'')) {
      fail('Authenticated finance-admin execution context is required',403);
    }
  }
  async function load(context,input) {
    validate(context,input);
    const row=amendmentResult(await db.from('member_change_execution').select('*')
      .eq('tenant_id',context.tenantId).eq('member_id',context.memberId)
      .eq('authority_id',input.authorityId).maybeSingle());
    return row;
  }
  async function resume(context,input) {
    const execution=await load(context,input);
    if(!execution){
      const saved=amendmentResult(await db.from('member_change_authority').select('authority')
        .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',input.authorityId).maybeSingle());
      if(!saved || saved.authority?.version!==1 || saved.authority?.action!=='change'
        || saved.authority?.sourceSnapshot?.commitment_snapshot?.payment_frequency!=='upfront'){
        fail('No supported confirmed financial change exists',404);
      }
      // A confirmed preview is not a financial instruction. The browser must
      // collect a separate explicit approval; recovery never starts settlement.
      return {execution:null,settlement:null,application:null,notifications:[],nextAction:'execute'};
    }
    const args={amendmentId:execution.amendment_id};
    let life=await settlement.lifecycle(context.tenantId,execution.amendment_id);
    if(life.application) return {execution,...life};
    // No settlement exists after a crash between approval and reservation:
    // explicit execute may proceed; recovery itself never initiates money.
    if(!life.settlement) return {execution,...life,nextAction:'execute'};
    life=await settlement.reconcile(context.tenantId,context.actorId,args);
    if(life.settlement?.state==='settled') {
      // Existing apply re-verifies provider evidence, locks member/purchase/
      // settlement and commits application, state, history and notification
      // together. A failed transaction remains recoverable from settled state.
      life=await settlement.apply(context.tenantId,context.actorId,args);
    }
    return {execution,...life,...(life.settlement?.evidence?.kind==='awaiting_member_credit_backing'?{nextAction:'back_credit'}:{})};
  }
  async function execute(context,input) {
    validate(context,input);
    if(input.approve!==true || typeof input.reason!=='string' || !input.reason.trim()
      || input.reason.trim().length>2000 || !['collect','refund','none','credit'].includes(input.settlementChoice)) {
      fail('Explicit approval, reason and supported settlement choice are required',400);
    }
    if(input.settlementChoice==='credit'){
      const ready=await db.rpc('member_credit_execution_available',{});
      if(ready.error||ready.data!==true)fail('Member credit execution requires the reviewed migration.',503);
    }
    const execution=amendmentResult(await db.rpc('begin_member_change_execution',{
      p_tenant_id:context.tenantId,p_member_id:context.memberId,p_authority_id:input.authorityId,
      p_actor_id:context.actorId,p_choice:input.settlementChoice,p_reason:input.reason.trim(),
    }));
    const life=await settlement.settle(context.tenantId,context.actorId,{
      amendmentId:execution.amendment_id,settlementChoice:execution.settlement_choice,
    });
    if(execution.settlement_choice==='credit'&&!life.application
      &&life.settlement?.evidence?.kind==='awaiting_member_credit_backing'){
      await settlement.backCredit(context.tenantId,context.actorId,{amendmentId:execution.amendment_id});
    }
    return resume(context,input);
  }
  return {execute,resume};
}

export async function runMemberChangeExecutionRecovery({db,
  service=createMemberChangeExecutionService({db}),limit=30,budgetMs=15000}) {
  const start=Date.now();
  const result=await db.rpc('pending_member_change_executions',{p_limit:limit});
  // Deploying the code before the additive migration must not disable legacy
  // recovery. Report the absent new runner explicitly rather than claiming work.
  if(['PGRST202','42883'].includes(result.error?.code)) return {enabled:false,reason:'migration_required',outcomes:[]};
  const rows=amendmentResult(result),outcomes=[];
  for(const row of rows||[]) {
    if(Date.now()-start>=budgetMs) break;
    try {
      const life=await service.resume({tenantId:row.tenant_id,memberId:row.member_id,
        actorId:row.approved_by,actorKind:'admin'},{authorityId:row.authority_id});
      outcomes.push({authorityId:row.authority_id,state:life.application?'applied':life.settlement?.state||'not_started'});
    }catch(error){outcomes.push({authorityId:row.authority_id,code:error.code||'execution_recovery_failed'});}
  }
  return {enabled:true,outcomes,timedOut:Date.now()-start>=budgetMs};
}
