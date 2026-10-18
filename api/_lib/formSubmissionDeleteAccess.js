import { isResourceExcluded } from './roleVisibility.js';

// Match the Form Submissions management capability used by submission editing.
// Being authenticated in the same tenant is not deletion authority.
export async function authorizeFormSubmissionDelete(db, context) {
  if (!context.isAuthenticated || !context.tenantId) {
    return { status: 401, error: 'Authentication required' };
  }
  if (context.tenantUserId) return null;
  const denied = { status: 403, error: 'Form Submissions management access required' };
  if (!context.roleId) return denied;
  try {
    const { data: role, error } = await db.from('role')
      .select('excluded_features')
      .eq('id', context.roleId)
      .eq('tenant_id', context.tenantId)
      .single();
    if (error || !role) return denied;
    const exclusions = [
      ...(Array.isArray(role.excluded_features) ? role.excluded_features : []),
      ...(Array.isArray(context.memberExcludedFeatures) ? context.memberExcludedFeatures : []),
    ];
    return isResourceExcluded(exclusions, 'page_FormSubmissions') ? denied : null;
  } catch {
    return denied;
  }
}
