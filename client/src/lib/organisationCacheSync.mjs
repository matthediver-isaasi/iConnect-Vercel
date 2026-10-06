export const organisationDirectKey = (tenantId, memberId, organizationId) => (
  ['organization-direct', tenantId, memberId, organizationId]
);

export const organisationListKey = (tenantId, memberId) => (
  ['organizations-crm-paginated', tenantId, memberId]
);

// Patch both possible sources of selectedOrg, without creating missing records
// or replacing pagination/derived row data. Cancel older reads before committing.
export async function syncOrganisationCaches({
  queryClient, tenantId, memberId, organizationId, updates = {}, customValue,
}) {
  if (!organizationId) return;
  const directKey = organisationDirectKey(tenantId, memberId, organizationId);
  const listKey = organisationListKey(tenantId, memberId);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: directKey, exact: true }),
    queryClient.cancelQueries({ queryKey: listKey }),
  ]);
  const patch = (org) => {
    if (!org || org.id !== organizationId) return org;
    return {
      ...org,
      ...updates,
      ...(customValue ? {
        custom_fields: { ...org.custom_fields, [customValue.fieldId]: customValue.value },
      } : {}),
    };
  };
  queryClient.setQueryData(directKey, patch);
  queryClient.setQueriesData({ queryKey: listKey }, (page) => (
    page?.organizations ? { ...page, organizations: page.organizations.map(patch) } : page
  ));
  // Sort/filter membership and totals are server-owned; refresh, don't fabricate.
  await queryClient.invalidateQueries({ queryKey: listKey });
}

export async function syncOrganisationPreferenceCache(queryClient, organizationId, { fieldId, value }) {
  const key = ['org-detail-preference-values', organizationId];
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
  queryClient.setQueryData(key, (values) => {
    if (!Array.isArray(values)) return values;
    const existing = values.some(row => row.field_id === fieldId);
    return existing
      ? values.map(row => row.field_id === fieldId ? { ...row, value: storedValue } : row)
      : [...values, { organization_id: organizationId, field_id: fieldId, value: storedValue }];
  });
}

// Keep editing until every write has completed. A rejection deliberately leaves
// the draft open, including custom-field values not yet persisted.
export async function saveOrganisationEdits({ core, custom, updateCore, updateCustom, finish }) {
  await updateCore(core);
  for (const change of custom) await updateCustom(change);
  finish();
}
