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