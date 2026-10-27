import {amendmentResult} from './memberAmendmentSettlement.js';
import {createMemberReplacementExecutionService} from './memberReplacementExecution.js';
const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rpc=async(db,name,args)=>amendmentResult(await db.rpc(name,args));

export async function runMemberReplacementRecovery({
 db,service=createMemberReplacementExecutionService({db}),sendEmail,
 budgetMs=2500,limit=10,now=()=>Date.now(),
}){
 if(!Number.isFinite(budgetMs)||budgetMs<0||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid replacement recovery limits');
 const started=now(),outcomes=[];
 if(budgetMs>0){
  let rows;
  try{rows=await rpc(db,'pending_member_replacement_jobs',{p_kind:'all',p_limit:limit});}
  catch(error){
   if(['PGRST202','42883'].includes(error.code))return {enabled:false,reason:'migration_required',outcomes};
   throw error;
  }
  for(const row of rows||[]){
   if(now()-started>=budgetMs)break;
   const kind=row.kind;
   let claim,attempted=false;
   const finish=(state,evidence,delay=300)=>rpc(db,'finish_member_replacement_job',{
    p_tenant_id:row.tenant_id,p_execution_id:row.execution_id,p_kind:kind,
    p_claim_token:claim.claim_token,p_state:state,p_evidence:evidence,p_delay:delay,
   });
   try{
    claim=await rpc(db,'claim_member_replacement_job',{
     p_tenant_id:row.tenant_id,p_execution_id:row.execution_id,p_kind:kind,
    });
    if(!claim)continue;
    const execution=amendmentResult(await db.from('member_replacement_execution').select('*')
     .eq('tenant_id',row.tenant_id).eq('member_id',row.member_id).eq('id',row.execution_id).maybeSingle());
    if(!execution?.actor_id||execution.member_id!==row.member_id)throw new Error('Saved replacement approval missing');
    // Reconciliation can verify and atomically apply an approved, paid change,
    // but can NEVER call execute or initiate another provider financial write.
    const life=await service.resume({
     tenantId:row.tenant_id,memberId:row.member_id,actorId:execution.actor_id,actorKind:'admin',
    },{authorityId:execution.authority_id});
    if(kind==='reconcile'){
     await finish(life.entitlementApplied?'completed':'pending',{
      reason:life.entitlementApplied?'application_verified':life.nextAction||'awaiting_evidence',
     });
     outcomes.push({executionId:row.execution_id,kind,state:life.entitlementApplied?'completed':'pending'});continue;
    }
    if(kind==='payment'&&life.entitlementApplied){
     await finish('completed',{reason:'already_paid_and_applied'});
     outcomes.push({executionId:row.execution_id,kind,state:'completed'});continue;
    }
    if(kind==='confirmation'&&!life.entitlementApplied)throw new Error('Application not verified');
    const member=amendmentResult(await db.from('member').select('id,email')
     .eq('tenant_id',row.tenant_id).eq('id',row.member_id).maybeSingle());
    if(!member?.email||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(member.email)){
     await finish('blocked',{reason:'member_email_unavailable'});
     outcomes.push({executionId:row.execution_id,kind,state:'blocked'});continue;
    }
    let text,html,subject;
    if(kind==='payment'){
     const settlement=life.settlement,evidence=settlement?.evidence;
     if(settlement?.state!=='awaiting_payment'||evidence?.verified!==true||!evidence.paymentUrl){
      await finish('pending',{reason:'verified_payment_link_unavailable',notSubmitted:true});
      outcomes.push({executionId:row.execution_id,kind,state:'pending'});continue;
     }
     const url=new URL(evidence.paymentUrl);
     if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='xero.com'||url.hostname.endsWith('.xero.com'))){
      throw new Error('Payment link is not trusted');
     }
     subject='Payment for your membership change';
     text='Your membership change is awaiting payment. Open your invoice to check the amount and pay securely:\n'
      +url.href+'\nYour new membership will be confirmed after payment has been verified.';
     html=`<p>Your membership change is awaiting payment.</p><p><a href="${escape(url.href)}">View and pay your membership invoice</a></p><p>Your new membership will be confirmed after payment has been verified.</p>`;
    }else{
     subject='Your membership change';
     text=`Your new membership term has been confirmed, starting ${execution.plan.newTerm.startDate}.\n`
      +`Your renewal date is ${execution.plan.newTerm.renewalDate}.\n`
      +'Your membership team can help if you have any questions about your payment, refund or member credit.';
     html=`<p>${escape(text).replace(/\n/g,'<br>')}</p>`;
    }
    const deliver=sendEmail||(await import('./emailService.js')).sendSystemEmail;
    attempted=true;
    const delivered=await deliver({tenantId:row.tenant_id,to:member.email,subject,text,html,
     disableTracking:true,confidentialDiagnostics:true});
    const state=delivered?.success?'completed':delivered?.notSubmitted===true?'pending':'uncertain';
    await finish(state,{messageId:delivered?.messageId||delivered?.id||null,
     ...(state==='pending'?{notSubmitted:true}:{}),reason:state==='completed'?'accepted':'delivery_not_confirmed'});
    outcomes.push({executionId:row.execution_id,kind,state});
   }catch(error){
    if(claim){
     try{await finish(attempted?'uncertain':'pending',{
      reason:attempted?'delivery_outcome_unknown':'pre_delivery_read_failed',
      ...(!attempted?{notSubmitted:true}:{}),
     },Math.min(86400,Math.max(300,Math.ceil(Number(error?.retryAfter)||0))));}catch{/* A lost acknowledgement keeps the durable claim; never resend. */}
    }
    outcomes.push({executionId:row.execution_id,kind,state:attempted?'uncertain':'pending'});
   }
  }
 }
 return {enabled:true,outcomes};
}
