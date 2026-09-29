import { applicantConfigurationDigest, FormApplicantContinuationError } from './formApplicantContinuation.js';
import { assessFormMutationAccess } from '../../shared/formMutationContract.js';

export const isLegacyPublicApplication = form =>
  form?.require_authentication !== true
  && form?.mutation_access_policy?.version === 1
  && form.mutation_access_policy.mode === 'legacy_public_application';

const denied = () => new FormApplicantContinuationError('Application record is unavailable for this form.');

// Explicit administrator opt-in for historical public applications. IDs are
// intentionally bearer references here, never a session or global ownership.
export async function createLegacyApplicationScope({ db, form, organizationId, memberId }) {
  if (!isLegacyPublicApplication(form)) return null;
  if (!assessFormMutationAccess(form).ok) throw denied();
  const scope = {
    version: 1, tenant_id: form.tenant_id, form_id: form.id,
    configuration_digest: applicantConfigurationDigest(form),
    organization_id: null, primary_member_id: null, member_ids: [],
  };
  for (const [entity, id] of [['organization', organizationId], ['member', memberId]]) {
    if (!id) continue;
    const { data, error } = await db.from(entity).select('id, tenant_id')
      .eq('tenant_id', form.tenant_id).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw denied();
    if (entity === 'organization') scope.organization_id = data.id;
    else {
      scope.primary_member_id = data.id;
      scope.member_ids.push(data.id);
    }
  }
  if (scope.organization_id) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from('member').select('id')
        .eq('tenant_id', form.tenant_id).eq('organization_id', scope.organization_id)
        .order('id').range(offset, offset + 499);
      if (error) throw error;
      scope.member_ids.push(...(data || []).map(row => row.id));
      if ((data || []).length < 500) break;
    }
  }
  scope.member_ids = [...new Set(scope.member_ids)];
  return scope;
}

export async function loadLegacyApplicationScope({ db, form, submission }) {
  if (!isLegacyPublicApplication(form)) return null;
  const scope = submission.legacy_application_scope;
  if (!scope || scope.version !== 1 || scope.tenant_id !== form.tenant_id
    || submission.tenant_id !== form.tenant_id || scope.form_id !== form.id
    || submission.form_id !== form.id
    || scope.configuration_digest !== applicantConfigurationDigest(form)
    || !Array.isArray(scope.member_ids)) throw denied();
  const current = await createLegacyApplicationScope({
    db, form, organizationId: scope.organization_id, memberId: scope.primary_member_id,
  });
  current.member_ids = current.member_ids.filter(id => scope.member_ids.includes(id));
  return current;
}