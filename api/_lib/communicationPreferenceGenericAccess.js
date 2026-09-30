const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && UUID_PATTERN.test(value);

export function validateGenericCommunicationPreferenceFilter(entity, filter) {
  if (String(entity || '').replace(/[-_]/g, '').toLowerCase() !== 'membercommunicationpreference') return null;
  const invalid = { status: 400, error: 'Communication preference member_id filters must contain valid UUIDs' };
  if (filter === undefined || filter === null) return null;
  let parsed = filter;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return invalid; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid;
  if (!Object.hasOwn(parsed, 'member_id')) return null;
  const value = parsed.member_id;
  if (Array.isArray(value)) return value.every(isUuid) ? null : invalid;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return invalid;
    for (const [operator, operand] of entries) {
      if (operator === 'is' && operand === null) continue;
      if (operator === 'in' && Array.isArray(operand) && operand.every(isUuid)) continue;
      if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(operator) && isUuid(operand)) continue;
      return invalid;
    }
    return null;
  }
  return isUuid(value) ? null : invalid;
}

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