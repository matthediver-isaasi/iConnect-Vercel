export async function checkRoleMutationAccess(tenantCtx, hasAdminAccess) {
  if (!tenantCtx?.isAuthenticated) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  if (!tenantCtx.tenantId) {
    return { ok: false, status: 400, error: 'Tenant context required' };
  }
  if (!tenantCtx.tenantUserId && !(await hasAdminAccess(tenantCtx))) {
    return { ok: false, status: 403, error: 'Role Management access required' };
  }
  return { ok: true };
}