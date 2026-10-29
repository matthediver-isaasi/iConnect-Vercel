// Shared by metadata reads and revocation: never infer delivery from "issued".
export function scopeActiveQuoteLinks(query, tenantId, quoteId, versionId, now = new Date().toISOString()) {
  return query.eq('tenant_id', tenantId).eq('quote_id', quoteId)
    .eq('quote_version_id', versionId)
    .not('activated_at', 'is', null).is('revoked_at', null).gt('expires_at', now);
}

export async function hasActiveQuoteLink(db, tenantId, quoteId, versionId) {
  if (!versionId) return false;
  const { data, error } = await scopeActiveQuoteLinks(
    db.from('sales_quote_delivery_token').select('id'), tenantId, quoteId, versionId,
  ).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}
