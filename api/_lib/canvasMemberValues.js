// This projection is created only from the session member, never an editor's
// selected record or a query-string member/organisation identifier.
export async function loadCanvasMemberSnapshot({ member, session, tenant, db }) {
  const tenantId = member?.tenant_id;
  if (!member?.id || !tenantId || !session?.data?.memberId
    || String(session.data.memberId) !== String(member.id)
    || !session.data.tenantId || String(session.data.tenantId) !== String(tenantId)
    // The session tenant alone does not prove which tenant's page is being
    // viewed (notably on an unresolved/custom host). Require both scopes.
    || !tenant?.id || String(tenant.id) !== String(tenantId)) return null;

  let organizationName = '';
  if (member.organization_id) {
    if (!db) throw new Error('Cannot load Canvas member organisation: database unavailable');
    const { data: organization, error } = await db.from('organization')
      .select('id, tenant_id, name')
      .eq('id', member.organization_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw new Error('Failed to load Canvas member organisation');
    // Check the returned relationship as well as scoping the query. Missing or
    // cross-tenant links never borrow a cached organisation name.
    if (organization && String(organization.id) === String(member.organization_id)
      && String(organization.tenant_id) === String(tenantId)) {
      organizationName = typeof organization.name === 'string' ? organization.name : '';
    }
  }
  return {
    memberId: member.id,
    tenantId,
    organizationId: member.organization_id || null,
    values: {
      'member.first_name': typeof member.first_name === 'string' ? member.first_name : '',
      'member.last_name': typeof member.last_name === 'string' ? member.last_name : '',
      'member.job_title': typeof member.job_title === 'string' ? member.job_title : '',
      'member.organization.name': organizationName,
    },
  };
}