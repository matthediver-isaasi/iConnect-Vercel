import { resolveMappedOrganizationDropdownValue } from '../../shared/formNotListedChoice.js';

export const ORGANIZATION_CORE_FIELD_MAPPINGS = Object.freeze({
  name: 'name',
  organization_name: 'name',
  organisation_name: 'name',
  logo_url: 'logo_url',
  phone: 'phone',
  invoicing_email: 'invoicing_email',
  invoicing_address: 'invoicing_address',
  website_url: 'website_url',
  email: 'email',
  address: 'address',
  website: 'website_url',
});

export function resolveOrganizationCoreField(targetField) {
  return ORGANIZATION_CORE_FIELD_MAPPINGS[targetField] || targetField;
}

export function resolvePrimaryOrganizationPipeline(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) return null;
  const explicitlyPrimary = pipelines.filter((pipeline) =>
    pipeline && (
      pipeline.isPrimary === true
      || pipeline.is_primary === true
      || pipeline.primary === true
    ));
  if (explicitlyPrimary.length === 1) return explicitlyPrimary[0];
  if (explicitlyPrimary.length > 1) return null;
  return pipelines.length === 1 ? pipelines[0] : null;
}

export function resolveOrganizationDropdownAssignment({
  field,
  targetField,
  value,
  submissionData,
} = {}) {
  const canonicalTargetField = resolveOrganizationCoreField(targetField);
  return resolveMappedOrganizationDropdownValue({
    field,
    targetField: canonicalTargetField,
    value,
    submissionData,
  });
}