import { isResourceExcluded } from './roleVisibility.js';

// Match the Form Submissions management capability used by the shared detail
// screen. Same-tenant authentication alone does not grant document access.
export async function authorizeFormSubmissionAccess(db, context) {
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

export const authorizeFormSubmissionDelete = authorizeFormSubmissionAccess;
