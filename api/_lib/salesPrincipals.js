// Sales keeps the historical tenant_user principal kind and stored ID. Unified
// IDs are valid only with the same active admin authority used by session.js.
const PERSON_COLUMNS = 'id,first_name,last_name,email';

export async function resolveUnifiedSalesUser(db, tenantId, id) {
  const { data: memberships, error } = await db.from('tenant_membership')
    .select('identity_id').eq('tenant_id', tenantId).eq('identity_id', id)
    .eq('status', 'active').or('role.eq.owner,role.eq.admin,membership_type.eq.owner')
    .limit(1);
  if (error) throw error;
  if (!memberships?.length) return null;
  const { data, error: identityError } = await db.from('tenant_identity')
    .select(PERSON_COLUMNS).eq('id', id).maybeSingle();
  if (identityError) throw identityError;
  return data;
}

export async function resolveSalesTenantUser(db, tenantId, id) {
  const { data, error } = await db.from('tenant_user').select(PERSON_COLUMNS)
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data || resolveUnifiedSalesUser(db, tenantId, id);
}

export async function loadSalesTenantUsers(db, tenantId, ids) {
  const unique = [...new Set(ids)];
  const people = [];
  // Bound IN filters and response sizes. Only unresolved IDs need identity reads.
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const { data, error } = await db.from('tenant_user').select(PERSON_COLUMNS)
      .eq('tenant_id', tenantId).in('id', batch);
    if (error) throw error;
    people.push(...(data || []));
    const found = new Set((data || []).map(person => person.id));
    const missing = await Promise.all(batch.filter(id => !found.has(id))
      .map(id => resolveUnifiedSalesUser(db, tenantId, id)));
    people.push(...missing.filter(Boolean));
  }
  return { data: people, error: null };
}
