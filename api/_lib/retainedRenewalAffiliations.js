import { repeatableRowChildren } from '../../shared/formRepeatableRows.js';

// Request-local authority, never accepted from JSON or persisted with a form.
export const RETAINED_ORGANIZATIONS = Symbol('verified-current-renewal-organizations');
export const retainsOrganization = (field, id) =>
  field?.[RETAINED_ORGANIZATIONS]?.has(String(id)) === true;

export async function attachRetainedRenewalAffiliations({ db, form, tenantId, memberId }) {
  if (!form?.member_affiliation_enabled || !memberId || form.tenant_id !== tenantId
    || !form.require_authentication || form.mutation_access_policy?.mode !== 'authenticated_owner') return;
  const setting = await db.from('form_member_affiliation_config').select('config')
    .eq('tenant_id', tenantId).eq('form_id', form.id).maybeSingle();
  if (setting.error) throw setting.error;
  const cfg = setting.data?.config;
  if (!cfg?.enabled || cfg.purpose === 'profile') return;
  const result = await db.from('member').select('id,organization_id').eq('tenant_id', tenantId)
    .eq('id', memberId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return;
  for (const id of cfg.primaryOrganizationFieldIds || []) {
    const field = form.fields?.find(f => f.id === id);
    if (field) field[RETAINED_ORGANIZATIONS] = new Set(result.data.organization_id ? [String(result.data.organization_id)] : []);
  }
  if (!cfg.additionalSitesFieldId || !cfg.secondaryMemberDefinitionId || !cfg.secondaryOrganizationDefinitionId) return;
  const container = form.fields?.find(f => f.id === cfg.additionalSitesFieldId);
  const child = repeatableRowChildren(container || {}).find(f => f.id === cfg.secondaryOrganizationFieldId);
  if (!child) return;
  async function edges(definition, record) {
    const values = [];
    for (const side of ['source', 'target']) {
      for (let offset = 0; ; offset += 500) {
        const response = await db.from('custom_object_relationship')
          .select('source_record_id,target_record_id').eq('tenant_id', tenantId)
          .eq('relationship_definition_id', definition).eq(`${side}_record_id`, record)
          .is('archived_at', null).order('id').range(offset, offset + 499);
        if (response.error) throw response.error;
        for (const edge of response.data || []) values.push(String(edge[side === 'source' ? 'target_record_id' : 'source_record_id']));
        if ((response.data || []).length < 500) break;
      }
    }
    return [...new Set(values)];
  }
  const ids = [];
  for (const assignment of await edges(cfg.secondaryMemberDefinitionId, memberId)) {
    if (!cfg.secondaryObjectId) throw new Error('Secondary affiliation object is not configured');
    const record = await db.from('custom_object_record').select('id')
      .eq('tenant_id', tenantId).eq('id', assignment).eq('custom_object_id', cfg.secondaryObjectId)
      .is('archived_at', null).maybeSingle();
    if (record.error) throw record.error;
    if (!record.data) continue;
    const organizations = await edges(cfg.secondaryOrganizationDefinitionId, assignment);
    if (organizations.length !== 1) throw new Error('Existing affiliation requires review');
    ids.push(organizations[0]);
  }
  child[RETAINED_ORGANIZATIONS] = new Set(ids);
}
