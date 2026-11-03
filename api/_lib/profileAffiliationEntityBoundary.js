export async function rejectGenericAffiliationWrite({ entity, req, res, context, hasAdminAccess }) {
  if (String(entity).replace(/[-_]/g, '').toLowerCase() !== 'member'
    || !['PATCH', 'PUT', 'POST'].includes(req.method)) return false;
  const contains = value => Array.isArray(value) ? value.some(contains)
    : value && typeof value === 'object' && (Object.hasOwn(value, 'organization_id')
      || ['records', 'items', 'data'].some(key => contains(value[key])));
  if (!contains(req.body) || (context?.isAuthenticated && await hasAdminAccess(context))) return false;
  res.status(403).json({ error: 'Use the member affiliation editor to change organisation links.' });
  return true;
}
