/**
 * Maps server opportunity permissions to UI capabilities. Managing the
 * collaborator list is deliberately stricter than editing opportunity content.
 */
export function getOpportunityUiCapabilities(permissions = {}) {
  return {
    canEdit: permissions.canEdit ?? permissions.edit ?? permissions.can_edit ?? true,
    canManage: permissions.canManage ?? permissions.manage ?? permissions.can_manage ?? false,
  };
}