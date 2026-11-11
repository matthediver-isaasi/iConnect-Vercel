// This mirrors merge tenancy: direct tenant first, organisation only as fallback.
// Callers must authorize their own tenant/admin context before invoking this.
export async function loadCpdMember(db, tenantId, memberId) {
  const { data, error } = await db.from('member')
    .select('*,organization:organization_id(tenant_id)').eq('id', memberId).maybeSingle();
  if (error) throw error;
  return data && (data.tenant_id || data.organization?.tenant_id) === tenantId ? data : null;
}
