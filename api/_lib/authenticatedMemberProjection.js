// Authentication has already established this tenant through the member or
// their organisation. Project it into the response; do not rewrite CRM data.
export function authenticatedMemberProjection(member, authenticatedTenantId) {
  if (!member || member.tenant_id || !authenticatedTenantId) return member;
  return { ...member, tenant_id: authenticatedTenantId };
}
