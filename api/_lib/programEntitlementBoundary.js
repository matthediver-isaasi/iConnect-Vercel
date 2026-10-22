// Programme ledger rows are financial records, never public tenant-wide data.
export async function handleProgramEntitlementEntity({ entity, id, req, res, context, db, hasAdminAccess }) {
  if (entity === 'booking' && req.method !== 'GET'
    && ['program_entitlement_transaction_id', 'program_entitlement_refunded_at'].some(key => Object.hasOwn(req.body || {}, key))) {
    res.status(403).json({ error: 'Programme booking provenance is service-owned' });
    return true;
  }
  if (entity !== 'programtickettransaction') return false;
  const send = (status, body) => { res.status(status).json(body); return true; };
  if (!context.isAuthenticated || !context.tenantId || context.tenantMismatch) {
    return send(403, { error: 'Authenticated tenant context required' });
  }
  const admin = await hasAdminAccess(context);
  if (admin && req.method === 'GET') return false;
  if (req.method !== 'GET') {
    // Keep existing administrative organization editing; personal rows are RPC-owned.
    if (!admin) return send(403, { error: 'Programme transactions are managed by the entitlement service' });
    if (req.body?.owner_member_id) return send(403, { error: 'Personal programme transactions are service-owned' });
    if (id) {
      const result = await db.from('program_ticket_transaction').select('owner_member_id')
        .eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
      if (result.error) return send(503, { error: 'Unable to verify programme transaction' });
      if (result.data?.owner_member_id) return send(403, { error: 'Personal programme transactions are service-owned' });
    }
    return false;
  }
  if (req.query?.expand) return send(400, { error: 'Programme ledger projections are not supported' });
  let query = db.from('program_ticket_transaction').select('*').eq('tenant_id', context.tenantId);
  if (!admin) {
    const uuid = value => /^[0-9a-f-]{36}$/i.test(value || '');
    const owners = [];
    if (uuid(context.memberId)) owners.push(`owner_member_id.eq.${context.memberId}`);
    if (uuid(context.organizationId)) owners.push(`organization_id.eq.${context.organizationId}`);
    if (!owners.length) return send(id ? 404 : 200, id ? { error: 'Transaction not found' } : []);
    query = query.or(owners.join(','));
  }
  try {
    const filter = typeof req.query?.filter === 'string' ? JSON.parse(req.query.filter) : req.query?.filter || {};
    const fields = new Set(['id', 'organization_id', 'owner_member_id', 'program_name', 'program_tag', 'transaction_type', 'booking_reference', 'member_email']);
    for (const [key, value] of Object.entries(filter)) {
      if (!fields.has(key) || (value !== null && typeof value === 'object')) return send(400, { error: 'Unsupported programme history filter' });
      query = value === null ? query.is(key, null) : query.eq(key, value);
    }
    if (id) query = query.eq('id', id);
    const { data, error } = await query.limit(1000);
    if (error) return send(503, { error: 'Unable to load programme history' });
    if (id && !data.length) return send(404, { error: 'Transaction not found' });
    data.sort((a, b) => Date.parse(b.created_at || b.created_date || 0) - Date.parse(a.created_at || a.created_date || 0));
    return send(200, id ? data[0] : data);
  } catch {
    return send(400, { error: 'Invalid programme history filter' });
  }
}
