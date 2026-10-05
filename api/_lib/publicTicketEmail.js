export function literalNormalizedEmailPattern(email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
    const error = new Error('Provide a valid purchaser email before payment.');
    error.statusCode = 400;
    throw error;
  }
  // ILIKE rewrites even escaped stars in PostgREST. IMATCH leaves this
  // anchored literal regular expression intact; % and _ have no special role.
  return `^[[:space:]]*${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[[:space:]]*$`;
}

export async function publicTicketEmailExists(db, tenantId, email) {
  const { data, error } = await db.from('member').select('id')
    .eq('tenant_id', tenantId).filter('email', 'imatch', literalNormalizedEmailPattern(email)).limit(1);
  if (error || !Array.isArray(data)) {
    const unavailable = new Error('Unable to verify ticket eligibility. Please try again before paying.');
    unavailable.statusCode = 503;
    throw unavailable;
  }
  return data.length > 0;
}

export async function assertPublicTicketPurchaser({ db, tenantId, purchaserEmail, authenticatedMember }) {
  if (authenticatedMember?.tenant_id === tenantId
      || await publicTicketEmailExists(db, tenantId, purchaserEmail)) {
    const error = new Error('Members must sign in and choose a member ticket.');
    error.statusCode = 409;
    throw error;
  }
}
