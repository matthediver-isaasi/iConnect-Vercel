const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Do not fall back to an arbitrary organisation when the default is missing.
export async function resolveFormOwnerOrganization(db, tenantId) {
  const { data, error } = await db.from('organization').select('id')
    .eq('tenant_id', tenantId).eq('is_primary', true).limit(2);
  if (error) throw error;
  return data?.length === 1 ? data[0].id : null;
}

export async function validateFormOwners({ db, tenantId, payload }) {
  if (!Object.prototype.hasOwnProperty.call(payload, 'owners')) return null;
  if (!Array.isArray(payload.owners) || payload.owners.some(id => typeof id !== 'string' || !UUID.test(id))) {
    return 'Form owners must be a list of valid member records.';
  }
  const ids = [...new Set(payload.owners)];
  if (!ids.length) return null;
  const organizationId = await resolveFormOwnerOrganization(db, tenantId);
  if (!organizationId) return 'Set a unique default organisation for this tenant before assigning form owners.';
  // Bound each lookup without relying on the database's default row limit.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await db.from('member').select('id')
      .eq('tenant_id', tenantId).eq('organization_id', organizationId)
      .not('email', 'ilike', 'deleted_%@deleted.local').in('id', batch);
    if (error) throw error;
    const found = new Set((data || []).map(member => member.id.toLowerCase()));
    if (batch.some(id => !found.has(id.toLowerCase()))) {
      return "Form owners must belong to this tenant's default organisation. Remove any other owners before saving.";
    }
  }
  return null;
}
