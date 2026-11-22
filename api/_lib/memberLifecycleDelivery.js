import { queueLifecycleNotice } from './memberLifecycleNotifications.js';
import { triggerWorkflows } from './workflows.js';
import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

export async function deliverLifecycleOperations(db, { dispatch = triggerWorkflows, queue = queueLifecycleNotice } = {}) {
  const deadline=Date.now()+45000;
  const result = await db.from('member_lifecycle_operation').select('*')
    .or('notice_prepared.eq.false,role_delivery.in.(pending,needs_review)')
    .lte('delivery_next_at',new Date().toISOString()).order('delivery_next_at').order('id').limit(3);
  if(result.error || !Array.isArray(result.data))throw result.error || new Error('Operation outbox unavailable');
  for(const operation of result.data){
    if(Date.now()>=deadline)break;
    try{
    const saved=await db.from('member_lifecycle_policy').select('policy,revision,enabled').eq('tenant_id',operation.tenant_id).single();
    if(saved.error)throw saved.error;
    if(!operation.notice_prepared){
      if(saved.data.enabled && saved.data.revision===operation.policy_revision){
        await queue(db,{tenantId:operation.tenant_id,memberId:operation.member_id,saved:saved.data,
          proposal:{action:operation.action,reason:operation.reason}});
      }
      const savedNotice=await db.rpc('member_lifecycle_operation_delivery',{p_id:operation.id,
        p_tenant_id:operation.tenant_id,p_kind:'notice',p_state:'prepared'});
      if(savedNotice.error)throw savedNotice.error;
    }
    if(!['pending','needs_review'].includes(operation.role_delivery)){
      const finished=await db.rpc('member_lifecycle_operation_delivery',{p_id:operation.id,p_tenant_id:operation.tenant_id,p_kind:'outbox',p_state:'complete'});
      if(finished.error)throw finished.error;
      continue;
    }
    const key=`member-lifecycle-role:${operation.tenant_id}:${operation.id}`;
    const claim=await db.from('workflow_delivery_claim').select('status').eq('tenant_id',operation.tenant_id).eq('delivery_key',key).maybeSingle();
    if(claim.error)throw claim.error;
    let state=claim.data?.status==='completed'?'completed':claim.data || operation.role_delivery==='needs_review'?'needs_review':'pending';
    if(state==='pending'){
      const member=await db.from('member').select('*').eq('id',operation.member_id).maybeSingle();
      if(member.error)throw member.error;
      let owner=member.data?.tenant_id;
      if(!owner && member.data?.organization_id){
        const organization=await db.from('organization').select('tenant_id').eq('id',member.data.organization_id).maybeSingle();
        if(organization.error)throw organization.error;
        owner=organization.data?.tenant_id;
      }
      if(!member.data || owner!==operation.tenant_id || member.data.role_id!==operation.role_after || ['archived','minimised','deleted'].includes(member.data.lifecycle_state)){
        state='completed'; // Superseded changes must not execute old effects.
      }else{
        const tenant=await db.from('tenant').select('*').eq('id',operation.tenant_id).single();
        if(tenant.error || !tenant.data)throw tenant.error || new Error('Tenant unavailable');
        try{
          const after={...member.data,tenant_id:operation.tenant_id}, before={...after,role_id:operation.role_before};
          const outcome=await dispatch('member',operation.member_id,before,after,'field_change',
            getTenantTrustedBaseUrl(null,tenant.data),{systemInitiated:true,deliveryKey:key});
          state=outcome?.delivery?.status==='completed'?'completed':'needs_review';
        }catch{
          const check=await db.from('workflow_delivery_claim').select('status').eq('tenant_id',operation.tenant_id).eq('delivery_key',key).maybeSingle();
          if(check.error)throw check.error;
          state=check.data?.status==='completed'?'completed':check.data?'needs_review':'pending';
        }
      }
    }
    const finished=await db.rpc('member_lifecycle_operation_delivery',{p_id:operation.id,p_tenant_id:operation.tenant_id,p_kind:'role',p_state:state});
    if(finished.error)throw finished.error;
    const cadence=await db.rpc('member_lifecycle_operation_delivery',{p_id:operation.id,p_tenant_id:operation.tenant_id,
      p_kind:'outbox',p_state:state==='completed'?'complete':'retry'});
    if(cadence.error)throw cadence.error;
    }catch{
      const retry=await db.rpc('member_lifecycle_operation_delivery',{p_id:operation.id,p_tenant_id:operation.tenant_id,p_kind:'outbox',p_state:'retry'});
      if(retry.error)throw retry.error;
    }
  }
  return {processed:result.data.length};
}
