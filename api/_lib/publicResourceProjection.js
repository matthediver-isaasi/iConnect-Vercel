import { isResourceReleased } from '../../shared/resourceRelease.js';

// Public discovery must not reveal group-only or attendance-gated resources,
// even if is_public is true. Apply before projecting any target URL.
export function isPublicLibraryResource(resource, now = Date.now()) {
  return isResourceReleased(resource, now) && !resource.member_group_id &&
    !(Array.isArray(resource.linked_events) && resource.linked_events.length > 0);
}

export function projectPublicResourceAccess(resource, tenantDomain) {
  const isPublic = resource?.is_public === true;
  return {
    ...resource,
    target_url: isPublic ? resource.target_url : null,
    is_locked: !isPublic,
    login_redirect_url: !isPublic
      ? `https://${tenantDomain}/login?returnTo=/resources&resourceId=${resource.id}`
      : null,
  };
}