export const MEMBER_REPLACEMENT_PROTOCOL='upfront-replacement-v1';

export function replacementLifecycle(authority,life={}){
 const e=life.execution,application=life.application;
 return {...life,
  execution:e?{...e,settlement_choice:e.plan.choice}:null,
  settlement:life.settlement?{...life.settlement,choice:e?.plan.choice}
   :e&&life.steps?.some(s=>['claimed','uncertain'].includes(s.state))?{
    choice:e.plan.choice,state:'awaiting_reconciliation',
    evidence:{reason:'An accounting request has not yet been verified. Recovery checks the existing request without issuing a second one.'},
   }:null,
  application:application?{...application,id:application.execution_id,
   effective_date:authority.calculation.newTerm.startDate,expires_on:authority.calculation.newTerm.renewalDate,
   purchaseSnapshot:application.snapshot,
   snapshot:{sourceSnapshot:authority.sourceSnapshot,targetSnapshot:{config:authority.targetSnapshot,band:authority.targetBandSnapshot}}}:null,
  notifications:life.notifications||[],
 };
}
export async function readMemberReplacements(db,tenantId,memberId,authorities){
 const ready=await db.rpc('member_replacement_execution_available',{p_protocol:MEMBER_REPLACEMENT_PROTOCOL});
 if(ready.error&& !['PGRST202','42883'].includes(ready.error.code)){
  throw Object.assign(new Error('Replacement execution readiness could not be checked.'),{status:503});
 }
 if(ready.error||ready.data!==true)return {replacementExecutionAvailable:false,records:new Map()};
 if(!authorities.some(a=>a.authority?.calculation?.behaviour==='new_term')){
  return {replacementExecutionAvailable:true,records:new Map()};
 }
 async function all(table,order){
  const rows=[];
  for(let offset=0;;offset+=500){
   const result=await db.from(table).select('*').eq('tenant_id',tenantId).eq('member_id',memberId)
    .order(order).range(offset,offset+499);
   if(result.error||!Array.isArray(result.data))throw Object.assign(new Error('Replacement history could not be read.'),{status:503});
   rows.push(...result.data);if(result.data.length<500)return rows;
  }
 }
 const [executions,applications]=await Promise.all([all('member_replacement_execution','id'),all('member_replacement_application','execution_id')]);
 const notifications=[];
 for(let offset=0;;offset+=500){
  const result=await db.from('member_replacement_job').select('execution_id,kind,state,evidence,updated_at')
   .eq('tenant_id',tenantId).eq('member_id',memberId).in('kind',['payment','confirmation'])
   .order('execution_id').order('kind').range(offset,offset+499);
  if(result.error||!Array.isArray(result.data))throw Object.assign(new Error('Replacement notification history could not be read.'),{status:503});
  notifications.push(...result.data);if(result.data.length<500)break;
 }
 const records=new Map();
 for(const row of authorities.filter(a=>a.authority?.calculation?.behaviour==='new_term')){
  const execution=executions.find(e=>e.authority_id===row.id);
  const application=applications.find(a=>a.execution_id===execution?.id);
  records.set(row.id,replacementLifecycle(row.authority,{execution,application,
   settlement:application?{state:'applied',evidence:application.evidence}:null,
   notifications:notifications.filter(n=>n.execution_id===execution?.id)
    .map(n=>({...n,kind:n.kind==='payment'?'Payment request':'Membership confirmation',
     state:n.state==='completed'?(n.evidence?.reason==='already_paid_and_applied'?'not needed':'sent'):n.state})),
  }));
 }
 return {replacementExecutionAvailable:true,records};
}
