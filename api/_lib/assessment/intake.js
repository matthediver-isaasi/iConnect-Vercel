import {captureReviewAttachments} from './attachments.js';
import {buildReviewDisplaySnapshot} from './displaySnapshot.js';
export class AwardsIntakeError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; this.code = 'AWARDS_INTAKE_UNAVAILABLE'; }
}
export async function resolveAwardIntake(database, { tenantId, formId, awardId }) {
  if (awardId === undefined || awardId === null) return null;
  if (typeof awardId !== 'string' || !/^[0-9a-f-]{36}$/i.test(awardId)) throw new AwardsIntakeError('Invalid award application link',400);
  const {data,error}=await database.from('awards_form_binding').select('id,award_id')
    .eq('tenant_id',tenantId).eq('award_id',awardId).eq('form_id',formId).eq('active',true).maybeSingle();
  if(error)throw new AwardsIntakeError('Award applications are temporarily unavailable',503);
  if(!data)throw new AwardsIntakeError('This form is not accepting applications for that award',404);
  return data;
}
export async function verifySavedAwardContext(database, { tenantId, submissionId, binding }) {
  if(!binding)return;
  const {data,error}=await database.from('awards_intake_capture').select('binding_id')
    .eq('tenant_id',tenantId).eq('submission_id',submissionId).maybeSingle();
  if(error)throw new AwardsIntakeError('Saved application context could not be verified',503);
  if(!data||data.binding_id!==binding.id)throw new AwardsIntakeError('This submission key belongs to a different application context');
}
export async function finaliseAwardIntake(database, { tenantId, submissionId, binding }) {
  if(!binding)return null;
  const existing=await database.from('awards_application').select('id,reference')
    .eq('tenant_id',tenantId).eq('submission_id',submissionId).eq('binding_id',binding.id).maybeSingle();
  if(existing.error)throw new AwardsIntakeError('Saved application could not be verified',503);
  if(existing.data)return{...existing.data,status:'received'};
  try{await captureReviewAttachments(database,{tenantId,submissionId});}
  catch(error){throw new AwardsIntakeError(error.message,503);}
  const {data,error}=await database.rpc('awards_finalise_intake',{
    p_tenant:tenantId,p_submission:submissionId,p_binding:binding.id,
    p_display:await buildReviewDisplaySnapshot(database,{tenantId,submissionId}),
  });
  if(error)throw new AwardsIntakeError('Your form was saved, but award registration needs a retry',503);
  return data;
}
