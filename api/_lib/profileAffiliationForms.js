import { allAffiliationRows, originalAffiliationProposal } from './formAffiliationReview.js';
import { assertAffiliationFormCompatibility } from './formMemberAffiliationConfig.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import { repeatableRowChildren } from '../../shared/formRepeatableRows.js';

export const emptyProfileFormPolicy = () => ({
  version: 1, enabled: false, fieldId: null, mappings: [], fallbackFormId: null,
  linkText: 'Update my affiliations', helpText: 'Update your organisations and departments using this form.',
});
export const profileCoreFields = [
  ['job_title', 'Job title'], ['status', 'Member status'], ['role_id', 'Member role'],
].map(([key, label]) => ({ id: `core:${key}`, label }));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function profileFormEligibility(form, config) {
  try {
    assertAffiliationFormCompatibility(form);
    if (config?.purpose !== 'profile' || !config.enabled || !form.member_affiliation_enabled) {
      throw new Error('Configure this standalone form for profile affiliations first.');
    }
    const fields = form.fields || [];
    const mustFind = (id, types, candidates = fields) => {
      if (id && !candidates.some(f => f.id === id && types.includes(f.type))) {
        throw new Error('A mapped affiliation field was removed or changed type. Restore it in Form Builder before enabling this form.');
      }
    };
    for (const id of config.primaryOrganizationFieldIds || []) mustFind(id, ['organisation_dropdown', 'organization_dropdown']);
    mustFind(config.organizationGroupFieldId, ['organisation_group_dropdown']);
    mustFind(config.primaryDepartmentsFieldId, ['relationship_dropdown']);
    mustFind(config.additionalSitesFieldId, ['repeatable_rows']);
    if (config.additionalSitesFieldId) {
      const children = repeatableRowChildren(fields.find(f => f.id === config.additionalSitesFieldId));
      mustFind(config.secondaryOrganizationFieldId, ['organisation_dropdown', 'organization_dropdown'], children);
      mustFind(config.secondaryDepartmentsFieldId, ['relationship_dropdown'], children);
    }
    if (form.form_type !== 'standard' || form.is_application_form || form.is_contract || form.is_event_related
      || form.auto_create_entity || form.is_due_diligence_enabled
      || Object.values(form.entity_pipelines || {}).some(v => Array.isArray(v) && v.length)
      || (form.field_mappings || []).length || (form.additional_member_creations || []).length
      || (form.fields || []).some(f => ['payment', 'membership_payment', 'communication_preferences'].includes(f.type))) {
      throw new Error('Use a standalone form without registration, payment, consent or record-creation actions.');
    }
    return null;
  } catch (error) { return error.message; }
}
export function validateProfileFormPolicy(input, metadata) {
  if (input?.version !== 1 || typeof input.enabled !== 'boolean' || !Array.isArray(input.mappings)
    || input.mappings.length > 100) throw new Error('Invalid form routing configuration.');
  const config = { ...emptyProfileFormPolicy(), ...input };
  if (config.fieldId && !metadata.fields.some(f => f.id === config.fieldId)) throw new Error('Select an available member field.');
  if (config.mappings.length && !config.fieldId) throw new Error('Select a member field for these mappings.');
  config.mappings = config.mappings.map(mapping => {
    if (typeof mapping.value !== 'string' || mapping.value.length > 500 || !uuid(mapping.formId)) {
      throw new Error('Each mapping needs a value and a form.');
    }
    return { value: mapping.value, formId: mapping.formId };
  });
  const targets = [...config.mappings.map(m => m.formId), ...(config.fallbackFormId ? [config.fallbackFormId] : [])];
  if (config.enabled && !targets.length) throw new Error('Choose at least one form before enabling.');
  for (const id of targets) {
    const form = metadata.forms.find(f => f.id === id);
    if (!form || !form.eligible) throw new Error(form?.reason || 'A mapped form is unavailable.');
  }
  for (const key of ['linkText', 'helpText']) {
    if (typeof config[key] !== 'string' || config[key].length > 1000) throw new Error('Invalid member-facing text.');
  }
  return Object.fromEntries(Object.keys(emptyProfileFormPolicy()).map(key => [key, config[key]]));
}
export function matchProfileForm(config, value) {
  // Equality only; arrays match individual saved values, not substrings.
  const values = (Array.isArray(value) ? value : [value]).map(v => String(v ?? ''));
  return config.mappings.find(mapping => values.includes(mapping.value))?.formId || config.fallbackFormId || null;
}
export async function loadProfileFormPolicy(db, tenantId) {
  const { data, error } = await db.from('profile_affiliation_form_policy').select('*').eq('tenant_id', tenantId).maybeSingle();
  // A not-yet-installed optional feature must not break existing tenants.
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
  return data || { version: 0, config: emptyProfileFormPolicy() };
}
export async function profileFormMetadata(db, tenantId) {
  const [fields, forms, configs] = await Promise.all([
    allAffiliationRows(() => db.from('preference_field').select('id,label,options,entity_scope,custom_object_id,is_active', { count: 'exact' }).eq('tenant_id', tenantId),
      10000, { operation: 'forms.preference_fields' }),
    allAffiliationRows(() => db.from('form').select('*', { count: 'exact' }).eq('tenant_id', tenantId),
      10000, { operation: 'forms.forms' }),
    allAffiliationRows(() => db.from('form_member_affiliation_config').select('form_id,config', { count: 'exact' }).eq('tenant_id', tenantId),
      10000, { orderBy: 'form_id', operation: 'forms.affiliation_configs' }),
  ]);
  return {
    fields: [...profileCoreFields, ...fields.filter(f => f.is_active !== false && !f.custom_object_id
      && (!f.entity_scope || f.entity_scope === 'member')).map(f => ({ id: `custom:${f.id}`, label: f.label, options: f.options }))],
    forms: forms.map(form => {
      const reason = profileFormEligibility(form, configs.find(c => c.form_id === form.id)?.config)
        || (!form.is_active || !isFormScheduleAvailable(form) ? 'Publish and activate the verified form before assigning it.' : null);
      return { id: form.id, name: form.name, slug: form.slug, eligible: !reason, reason };
    }),
  };
}
export async function resolveProfileForm(db, tenantId, member, policy) {
  policy ||= await loadProfileFormPolicy(db, tenantId);
  if (!policy.config.enabled) return { policy, form: null, unavailableMessage: null };
  let value;
  const fieldId = policy.config.fieldId;
  if (fieldId?.startsWith('core:')) {
    if (!profileCoreFields.some(f => f.id === fieldId)) throw new Error('The configured member field is unavailable.');
    const key = fieldId.slice(5);
    const { data, error } = await db.from('member').select(key).eq('tenant_id', tenantId).eq('id', member.id).single();
    if (error) throw error;
    value = data[key];
  } else if (fieldId?.startsWith('custom:')) {
    const id = fieldId.slice(7);
    const { data: field, error: fieldError } = await db.from('preference_field')
      .select('id,entity_scope,custom_object_id,is_active').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (fieldError || !field || field.custom_object_id || field.is_active === false
      || (field.entity_scope && field.entity_scope !== 'member')) throw new Error('The configured member field is unavailable.');
    const { data, error } = await db.from('member_preference_value').select('value')
      .eq('member_id', member.id).eq('field_id', id).maybeSingle();
    if (error) throw error;
    value = data?.value;
  }
  const id = matchProfileForm(policy.config, value);
  const unavailableMessage = 'Your affiliation form is unavailable. Contact your administrator to check the form mapping and publication settings.';
  if (!id) return { policy, form: null, unavailableMessage };
  const [{ data: form, error }, { data: cfg, error: cfgError }] = await Promise.all([
    db.from('form').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle(),
    db.from('form_member_affiliation_config').select('config').eq('tenant_id', tenantId).eq('form_id', id).maybeSingle(),
  ]);
  if (error || cfgError) throw error || cfgError;
  if (!form || !form.is_active || !isFormScheduleAvailable(form) || profileFormEligibility(form, cfg?.config)) {
    return { policy, form: null, unavailableMessage };
  }
  return { policy, form, config: cfg.config, unavailableMessage: null };
}
export async function assertProfileFormRoute(db, tenantId, memberId, formId, version) {
  const resolved = await resolveProfileForm(db, tenantId, { id: memberId });
  if (!resolved.form || resolved.form.id !== formId || (version != null && resolved.policy.version !== version)) {
    throw new Error('Your affiliation form selection changed or is unavailable. Return to your profile and reopen it.');
  }
  return resolved;
}
export async function profileFormSummary(db, tenantId, captured) {
  const proposal = originalAffiliationProposal(captured);
  const ids = [proposal.primary, ...proposal.secondary].filter(Boolean);
  const { data: organizations, error } = ids.length
    ? await db.from('organization').select('id,name').eq('tenant_id', tenantId).in('id', ids)
    : { data: [], error: null };
  if (error) throw error;
  const names = new Map(organizations.map(o => [o.id, o.name]));
  let group = null;
  if (captured.profile_group_id) {
    const { data, error } = await db.from('organization_group').select('name').eq('tenant_id', tenantId).eq('id', captured.profile_group_id).maybeSingle();
    if (error) throw error;
    group = data?.name || 'Unavailable group';
  }
  return { primary: proposal.primary ? names.get(proposal.primary) || 'Unavailable organisation' : null,
    group, secondary: proposal.secondary.map(id => names.get(id) || 'Unavailable organisation'),
    departments: proposal.departments.map(id => {
      const record = captured.graph.records.find(r => r.id === id);
      return String(record?.data?.name || record?.data?.department_name || 'Department');
    }) };
}
