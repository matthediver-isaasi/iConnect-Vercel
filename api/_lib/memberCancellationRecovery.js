import {createMemberCancellationRequests} from './memberCancellationRequests.js';
import {amendmentResult} from './memberAmendmentSettlement.js';

// Financial writes and provider stops have their own durable operation claims.
// Reclaiming this orchestration job never grants a second financial write.
export function createMemberCancellationRecovery({
 db,requests=createMemberCancellationRequests({db}),finance,notify,
 now=()=>Date.now(),
 claimRpc='claim_member_cancellation_jobs',allowedKinds=null,
}){
 async function finish(job,state,message=null,delay=60,result={}){
  return amendmentResult(await db.rpc('finish_member_cancellation_job',{
   p_id:job.id,p_claim_token:job.claim_token,p_state:state,p_error:message,p_delay_seconds:delay,p_result:result,
  }));
 }
 async function run({budgetMs=20000,limit=5}={}){
  const started=now(),outcomes=[];
  // Claim only one at a time: do not hold unsent notification claims while
  // another provider consumes the invocation budget.
  while(outcomes.length<Math.max(1,Math.min(limit,20))&&now()-started<budgetMs){
   const claim=await db.rpc(claimRpc,{p_limit:1});
   if(claim.error?.code==='PGRST202')return {available:false,outcomes};
   const jobs=amendmentResult(claim)||[];
   if(!jobs.length)break;
   const job=jobs[0];
   let outcome;
   try{
    if(allowedKinds&&!allowedKinds.includes(job.kind))throw Error('Recovery job kind is not enabled');
    const record=amendmentResult(await db.from('member_cancellation_request').select('*')
     .eq('id',job.request_id).maybeSingle());
    if(!record?.authority||record.id!==job.request_id)throw Error('Approved cancellation unavailable');
    const context={tenantId:record.tenant_id,memberId:record.member_id,actorId:record.actor_id,
     actorKind:'admin',origin:'scheduled_recovery'};
    if(job.kind==='lifecycle'){
     if(record.withdrawn_at)outcome={state:'done'};
     else{
      const result=await requests.recover(context,record.id);
      outcome={state:result.record.access_ended_at
       &&(!result.record.authority.providerPrepared||result.provider?.state==='stopped')?'done':'pending'};
     }
    }else if(job.kind==='finance'){
     if(!finance)outcome={state:'pending',message:'Financial reconciliation is not connected'};
     else outcome=await finance.recover(context,record.id);
    }else{
     if(!notify)outcome={state:'manual_review',message:'Notification delivery is not connected'};
     else outcome=await notify.send(context,record,job);
    }
    const accepted=await finish(job,outcome.state,outcome.message,outcome.delaySeconds,outcome.evidence||{});
    outcomes.push({id:job.id,kind:job.kind,state:accepted?outcome.state:'claim_lost'});
   }catch(error){
    const state=job.kind.startsWith('notify_')?'uncertain':'pending';
    const delay=Number.isFinite(Number(error?.retryAfter))
     ?Math.max(5,Math.min(86400,Math.ceil(Number(error.retryAfter)))):60;
    try{await finish(job,state,'Cancellation recovery requires another observation',delay);}catch{}
    outcomes.push({id:job.id,kind:job.kind,state});
   }
  }
  return {available:true,outcomes};
 }
 return {run};
}
