import { allAffiliationRows } from './formAffiliationReview.js';
import { repeatableRowChildren, isRepeatableRowField } from '../../shared/formRepeatableRows.js';
import { getCustomObjectFieldMetadata } from './customObjectDomain.js';

export async function discoverMemberAffiliations(db, tenantId) {
  const [objects, fieldRows, relationships] = await Promise.all([
    allAffiliationRows(() => db.from('custom_object_definition').select('*', { count: 'exact' }).eq('tenant_id', tenantId)),
    allAffiliationRows(() => db.from('preference_field').select('*', { count: 'exact' }).eq('tenant_id', tenantId).not('custom_object_id', 'is', null)),
    allAffiliationRows(() => db.from('custom_object_relationship_definition').select('*', { count: 'exact' }).eq('tenant_id', tenantId)),
  ]);
  const fields = {};
  for (const field of fieldRows) (fields[field.custom_object_id] ||= []).push(field);
  return { complete: true, objects, fields, relationships };
}

export function assertAffiliationFormCompatibility(form) {
  if (form.require_authentication !== true || form.mutation_access_policy?.mode !== 'authenticated_owner') {
    throw new Error('Require member sign-in and authenticated-owner access before enabling affiliation updates.');
  }
  if (form.due_diligence_required === true) {
    throw new Error('Use a renewal form without join/application Due Diligence. Affiliation reviews get their own workflow.');
  }
  if ((form.fields || []).some(field => field.type === 'payment')) {
    throw new Error('Use a Membership payment field for this renewal copy, rather than a join Payment field.');
  }
  if (Object.entries(form.entity_pipelines || {}).some(([kind, pipelines]) => kind !== 'members' && Array.isArray(pipelines) && pipelines.length)) {
    throw new Error('Remove organisation and other creation pipelines from this renewal copy before enabling affiliation updates.');
  }
  const actions = form.structured_actions;
  if (actions && (Array.isArray(actions) ? actions.length
    : Array.isArray(actions.actions) ? actions.actions.length : Object.keys(actions).length)) {
    throw new Error('Remove structured creation/link actions from this renewal copy; affiliation updates replace them.');
  }
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (value.related_records && (Array.isArray(value.related_records) ? value.related_records.length : Object.keys(value.related_records).length)) {
      throw new Error('Remove add-only related-record mappings from the member pipeline before enabling affiliation updates.');
    }
    if (['organization_id', 'organisation_id', 'organization_name', 'organisation_name', 'organization', 'organisation', 'login_enabled'].includes(value.target_field)
      && value.target_type !== 'custom') {
      throw new Error('Remove member organisation core-field mappings; the affiliation transaction owns these changes.');
    }
    if (value.login_enabled === false) throw new Error('Remove the join-only login-disabled setting from this renewal copy.');
    Object.values(value).forEach(inspect);
  }
  inspect(form.entity_pipelines); inspect(form.field_mappings);
}

export function validateMemberAffiliationConfig(form, input, metadata) {
  if (!input || input.version !== 1 || typeof input.enabled !== 'boolean') throw new Error('Invalid affiliation configuration.');
  const cfg = { version: 1, enabled: input.enabled };
  const keys = ['primaryDepartmentsFieldId', 'memberDepartmentDefinitionId', 'departmentOrganizationDefinitionId',
    'additionalSitesFieldId', 'secondaryOrganizationFieldId', 'secondaryDepartmentsFieldId', 'secondaryObjectId',
    'secondaryMemberDefinitionId', 'secondaryOrganizationDefinitionId', 'secondaryLabelFieldId'];
  for (const key of keys) cfg[key] = typeof input[key] === 'string' && input[key] ? input[key] : null;
  if (!Array.isArray(input.primaryOrganizationFieldIds) || input.primaryOrganizationFieldIds.some(id => typeof id !== 'string')
    || new Set(input.primaryOrganizationFieldIds).size !== input.primaryOrganizationFieldIds.length) throw new Error('Select valid organisation fields.');
  cfg.primaryOrganizationFieldIds = [...input.primaryOrganizationFieldIds];
  if (!cfg.enabled) return cfg;
  assertAffiliationFormCompatibility(form);
  if (metadata?.complete !== true) throw new Error('Complete relationship discovery is required.');
  const fields = form.fields || [];
  const field = (id, candidates, types) => {
    const found = candidates.find(f => f.id === id);
    if (!found || (types && !types.includes(found.type))) throw new Error('A configured affiliation field is unavailable or has changed type.');
    return found;
  };
  cfg.primaryOrganizationFieldIds.forEach(id => field(id, fields, ['organization_dropdown', 'organisation_dropdown']));
  const definition = id => {
    const found = metadata.relationships.find(d => d.id === id && d.status === 'active');
    if (!found) throw new Error('Select an active relationship definition.');
    return found;
  };
  const linkedObject = (d, kind) => d.source_kind === kind && d.target_kind === 'custom_object' ? d.target_custom_object_id
    : d.target_kind === kind && d.source_kind === 'custom_object' ? d.source_custom_object_id : null;
  let departmentObject;
  if (cfg.primaryDepartmentsFieldId || cfg.secondaryDepartmentsFieldId || cfg.memberDepartmentDefinitionId) {
    departmentObject = linkedObject(definition(cfg.memberDepartmentDefinitionId), 'member');
    if (!departmentObject || linkedObject(definition(cfg.departmentOrganizationDefinitionId), 'organization') !== departmentObject) {
      throw new Error('Member and organisation department relationships must reference the same department object.');
    }
    if (cfg.primaryDepartmentsFieldId) field(cfg.primaryDepartmentsFieldId, fields, ['relationship_dropdown']);
  }
  if (cfg.additionalSitesFieldId) {
    const container = field(cfg.additionalSitesFieldId, fields);
    if (!isRepeatableRowField(container)) throw new Error('Additional affiliations require a repeatable-row field.');
    const children = repeatableRowChildren(container);
    field(cfg.secondaryOrganizationFieldId, children, ['organization_dropdown', 'organisation_dropdown']);
    if (cfg.secondaryDepartmentsFieldId) field(cfg.secondaryDepartmentsFieldId, children, ['relationship_dropdown']);
    if (!metadata.objects.some(o => o.id === cfg.secondaryObjectId)
      || linkedObject(definition(cfg.secondaryMemberDefinitionId), 'member') !== cfg.secondaryObjectId
      || linkedObject(definition(cfg.secondaryOrganizationDefinitionId), 'organization') !== cfg.secondaryObjectId) {
      throw new Error('Secondary assignment relationships must use the selected assignment object.');
    }
    const assignmentFields = metadata.fields[cfg.secondaryObjectId] || [];
    if (cfg.secondaryLabelFieldId && !assignmentFields.some(f => f.id === cfg.secondaryLabelFieldId)) {
      throw new Error('Choose a valid assignment label field.');
    }
    const labelDefinition = assignmentFields.find(f => f.id === cfg.secondaryLabelFieldId);
    cfg.secondaryLabelFieldKey = labelDefinition ? getCustomObjectFieldMetadata(labelDefinition).key : null;
    if (assignmentFields.some(f => getCustomObjectFieldMetadata(f).required && f.id !== cfg.secondaryLabelFieldId)) {
      throw new Error('This assignment object has additional required fields that cannot be safely populated by this form.');
    }
  } else if (keys.filter(k => k.startsWith('secondary')).some(k => cfg[k])) {
    throw new Error('Configure an additional-affiliations container before selecting secondary mappings.');
  }
  if (!cfg.primaryOrganizationFieldIds.length && !cfg.primaryDepartmentsFieldId && !cfg.additionalSitesFieldId) {
    throw new Error('Choose at least one affiliation field.');
  }
  return cfg;
}
