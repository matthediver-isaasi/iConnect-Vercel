// An organisation-less member may read their own bookings, not a tenant-wide
// list. Never treat client filter contents as the authority for the SQL scope.
export function isOwnBookingHistoryRead(method, entity, context, filter) {
  if (method !== 'GET' || entity !== 'Booking' || !context.isAuthenticated
      || context.tenantMismatch || context.organizationId
      || !context.memberId || !context.effectiveTenantId) return false;
  const value = filter?.member_id;
  const memberId = typeof value === 'string' ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && typeof value.eq === 'string'
      ? value.eq : null;
  return memberId === context.memberId;
}

export function scopeOwnBookingHistory(query, context) {
  if (!context.memberId || !context.effectiveTenantId) throw new Error('Invalid member history context');
  return query.eq('tenant_id', context.effectiveTenantId).eq('member_id', context.memberId);
}
