export async function readRenewalExceptions(db, tenantId) {
  const {data,error}=await db.from('membership_renewal_exceptions').select('revision,rules').eq('tenant_id',tenantId).maybeSingle();
  if(error) {
    if(['42P01','PGRST205'].includes(error.code))return {revision:0,rules:[],available:false};
    throw new Error('Renewal exceptions could not be verified.');
  }
  return {...(data||{revision:0,rules:[]}),available:true};
}

export async function resolveRenewalException(db,tenantId,memberId) {
  const settings=await readRenewalExceptions(db,tenantId);
  if(!settings.rules.length)return null;
  if(!memberId)throw new Error('Membership identity is required to verify renewal exceptions.');
  const {data,error}=await db.rpc('resolve_membership_renewal_exception',{p_tenant_id:tenantId,p_member_id:memberId});
  if(error)throw new Error(error.message||'Renewal exceptions could not be verified.');
  return data;
}

export async function assertRenewalCategory(db,tenantId,memberId,configId) {
  const rule=await resolveRenewalException(db,tenantId,memberId);
  if(!rule?.restrictToClass)return;
  const {data,error}=await db.from('membership_tier_config').select('id,tenant_id,structure_scope_type,structure_field_id,structure_match_value')
    .eq('tenant_id',tenantId).eq('id',configId).maybeSingle();
  if(error||!data||data.structure_scope_type!=='member'||data.structure_field_id!==rule.purchasedFieldId
    ||data.structure_match_value!==rule.purchasedClassValue) {
    throw new Error('Your membership must renew in its existing category. Please use your renewal link or contact the membership team.');
  }
}
