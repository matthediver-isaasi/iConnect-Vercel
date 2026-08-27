export async function authorizeGenericCommunicationPreferenceAccess(
  entity,
  tenantContext,
  { hasAdminAccess },
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
  return null;
}