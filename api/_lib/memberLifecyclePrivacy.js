import { lifecycleStableDetail, lifecycleSourceStamp } from './memberLifecycleSnapshot.js';
import { lifecyclePrivacyPlan } from './memberLifecyclePrivacyPlan.js';
import { lifecycleUuid } from './memberLifecycleReview.js';
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export async function previewLifecyclePrivacy(db, { tenantId, actor, saved, body }, deps = {}) {
  const action = body.action?.replace(/_preview$/, '');
  if (!['minimise','delete'].includes(action) || !lifecycleUuid(body.memberId)
    || !Number.isSafeInteger(body.expectedRevision) || typeof body.reason !== 'string'
    || !body.reason.trim() || body.reason.length>2000) fail('A current member, action and documented reason are required',400);
  const detail = await (deps.detail || lifecycleStableDetail)(db,tenantId,body.memberId,saved.policy,deps);
  if (detail.revision!==body.expectedRevision) fail('Member changed; reload');
  if (detail.blockers.length) fail('Resolve evidence, financial and retention blockers first');
  if (action==='minimise' && detail.state!=='archived') fail('Only an intact archived member can be minimised');
  if (action==='delete' && detail.proposal.action!=='deletion_review') fail('The record is not eligible for deletion review');
  const {data:fields,error} = await db.rpc('member_lifecycle_privacy_fields',{p_tenant_id:tenantId,p_member_id:body.memberId});
  if(error)throw error;
  const plan=lifecyclePrivacyPlan(fields,body.retentionDecisions);
  if(action==='delete' && plan.fieldsRetained.some(field=>field.reason!=='Internal identity, lifecycle or access control')) {
    plan.blockers.push('Documented retained personal fields must remain in minimised review until their retention ends');
  }
  if(detail.sourceStamp!==await lifecycleSourceStamp(db))fail('Sources changed; generate a fresh preview');
  let token={impactToken:null};
  if(!plan.blockers.length){
    const result=await db.rpc('member_lifecycle_save_impact',{
      p_tenant_id:tenantId,p_member_id:body.memberId,p_revision:detail.revision,p_policy_revision:saved.revision,
      p_stamp:detail.sourceStamp,p_action:action,p_actor:actor,p_reason:body.reason.trim(),
      p_plan:plan,p_financial_refs:detail.evidence.financialReferences || {},
    });
    if(result.error)throw result.error;
    token=result.data;
  }
  return {...plan,...token,revision:detail.revision};
}
export async function applyLifecyclePrivacy(db,{tenantId,actor,body}){
  if(!lifecycleUuid(body.memberId)||!lifecycleUuid(body.impactToken)||!['minimise','delete'].includes(body.action)
    ||body.confirmation!==body.action.toUpperCase()||typeof body.reason!=='string')fail('A matching impact and explicit confirmation are required',400);
  const {data,error}=await db.rpc('member_lifecycle_apply_impact',{
    p_tenant_id:tenantId,p_member_id:body.memberId,p_token:body.impactToken,p_actor:actor,
    p_action:body.action,p_confirmation:body.confirmation,p_reason:body.reason.trim(),
  });
  if(error)throw error;
  if(!data||data.memberId!==body.memberId)throw new Error('Privacy operation result unavailable');
  return data;
}
