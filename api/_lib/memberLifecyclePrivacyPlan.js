// Field names, not values, form the review/audit contract. Unknown/custom
// fields require a documented decision instead of guessing legal retention.
const protectedFields = new Set([
  'id','tenant_id','created_at','updated_at','created_date','updated_date','created_on','updated_on',
  'lifecycle_state','lifecycle_generation','role_id','role_effective_from',
  'membership_paused','membership_cancelled','membership_paused_at','membership_cancelled_at',
  'login_enabled','show_in_directory','is_guest','guest_expires_at',
]);
const profileFields = new Set([
  'email','first_name','last_name','full_name','handle','job_title','biography','profile_photo_url',
  'phone','telephone','mobile','mobile_phone','date_of_birth','address','address_line_1','address_line_2',
  'address_line_3','city','county','state','postcode','postal_code','country','linkedin_url','twitter_url',
  'facebook_url','website','supplied_organization_name','identity_id','department_ids','departments',
  'page_tours_seen',
]);
export function lifecyclePrivacyPlan(fields, decisions = {}) {
  if (!Array.isArray(fields) || !decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw Object.assign(new Error('Invalid field retention decisions'), { status: 400 });
  }
  const known = new Set(fields.map(field => field.name));
  if (Object.keys(decisions).some(key => !known.has(key))) throw Object.assign(new Error('Unknown retention field'), { status: 400 });
  const fieldsRemoved=[], fieldsRetained=[], unresolvedFields=[], blockers=[];
  for (const field of fields) {
    if (typeof field.name !== 'string' || typeof field.hasValue !== 'boolean') throw new Error('Field inventory unavailable');
    const decision = decisions[field.name];
    if (decision && (!['retain','remove'].includes(decision.disposition) || typeof decision.reason !== 'string'
      || !decision.reason.trim() || decision.reason.length > 2000)) {
      throw Object.assign(new Error('Every field decision requires a documented reason'), { status: 400 });
    }
    if (protectedFields.has(field.name)) {
      if (decision?.disposition === 'remove') throw Object.assign(new Error('Protected lifecycle fields cannot be removed'), { status: 400 });
      fieldsRetained.push({ field: field.name, reason: 'Internal identity, lifecycle or access control' });
      continue;
    }
    if (!field.hasValue) continue;
    const disposition = decision?.disposition || (profileFields.has(field.name) ? 'remove' : null);
    if (!disposition) {
      unresolvedFields.push({ name: field.name, label: field.label || field.name, canRemove: field.canRemove !== false });
      blockers.push(`retention_decision_required:${field.name}`);
    } else if (disposition === 'retain') {
      fieldsRetained.push({ field: field.name, reason: decision.reason.trim() });
    } else if (field.canRemove === false) {
      blockers.push(`field_requires_source_remediation:${field.name}`);
    } else fieldsRemoved.push(field.name);
  }
  return { fieldsRemoved, fieldsRetained, unresolvedFields, blockers };
}
