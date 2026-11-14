// Compatibility applies only to the specifically absent additive column.
// Provider failures and permission errors must not permit business actions.
export async function assertNotAwardAmendment(db,tenantId,submissionId){
  const {data,error}=await db.from('form_submission').select('awards_amendment_application_id')
    .eq('tenant_id',tenantId).eq('id',submissionId).maybeSingle();
  if(error){
    if(error.code==='42703'&&String(error.message).includes('awards_amendment_application_id'))return;
    throw Object.assign(new Error('Submission processing authority could not be verified'),{status:503});
  }
  if(!data)throw Object.assign(new Error('Submission unavailable'),{status:404});
  if(data.awards_amendment_application_id)throw Object.assign(new Error('Award amendments update review evidence only'),{
    status:409,code:'AWARDS_EVIDENCE_ONLY',
  });
}
