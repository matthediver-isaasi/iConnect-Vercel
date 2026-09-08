export function buildPublicFormProcessingPayload({
  form,
  submission,
  tenantId,
  prefillOrganizationId,
  roleId,
  verifiedSubmitterMemberId,
  verifiedAdminAccess,
}) {
  const persistedSubmissionId = submission?.id || null;
  const persistedSubmissionData = submission?.submission_data || {};
  return {
    form_id: form.id,
    form_values: persistedSubmissionData,
    fields: form.fields || [],
    field_mappings: form.field_mappings || [],
    application_level: form.application_level || 'member',
    submission_id: persistedSubmissionId,
    prefill_organization_id: prefillOrganizationId || null,
    role_id: roleId || null,
    entity_pipelines: form.entity_pipelines,
    tenant_id: tenantId,
    defer_communication_subscriptions: true,
    verified_submitter_member_id: verifiedSubmitterMemberId,
    verified_admin_access: verifiedAdminAccess,
  };
}