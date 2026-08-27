export async function authorizeGenericCommunicationPreferenceAccess(
  entity,
  tenantContext,
  { hasAdminAccess },
  method = 'GET',
) {
  const normalizedEntity = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  const adminOnlyCommunicationEntities = new Set([
    'communicationcategory',
    'communicationcategoryrole',
    'membercommunicationpreference',
  ]);
  if (!adminOnlyCommunicationEntities.has(normalizedEntity)) return null;

  if (!tenantContext?.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }
  if (!await hasAdminAccess(tenantContext)) {
    return { status: 403, error: 'Admin access required' };
  }
  if (normalizedEntity === 'membercommunicationpreference' && method !== 'GET') {
    return {
      status: 405,
      error: 'Communication preference writes must use the guarded preferences API',
    };
  }
  return null;
}