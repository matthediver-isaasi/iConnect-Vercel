export const DEFAULT_MEMBER_GROUP_CARD_LIMIT = 6;
export const MAX_MEMBER_GROUP_CARD_LIMIT = 24;

export function resolveMemberGroupCardLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.max(1, Math.min(MAX_MEMBER_GROUP_CARD_LIMIT, parsed))
    : DEFAULT_MEMBER_GROUP_CARD_LIMIT;
}

export function selectSelfJoinMemberGroups(groups, limit) {
  const safeLimit = resolveMemberGroupCardLimit(limit);
  return (Array.isArray(groups) ? groups : [])
    .filter((group) => group?.id && group.allow_self_join && group.is_active !== false)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, safeLimit);
}

export function buildMemberGroupCardDestination({
  groupId,
  isAuthenticated,
  detailPath,
}) {
  if (isAuthenticated) return `${detailPath}?id=${groupId}`;
  return `/login?returnTo=${encodeURIComponent(detailPath)}&groupId=${encodeURIComponent(groupId)}`;
}

export function isMemberGroupCardActivationKey(key) {
  return key === 'Enter' || key === ' ';
}

export function resolveMemberGroupCardsAccess({
  authResolved,
  sessionValidated,
  memberId,
  isAccessReady,
  featureExcluded,
}) {
  const isAuthenticated = !!(authResolved && sessionValidated && memberId);
  const accessRestricted = !!(isAuthenticated && isAccessReady && featureExcluded);
  return {
    isAuthenticated,
    accessRestricted,
    shouldLoadPublicData: !!(authResolved && !isAuthenticated),
    shouldLoadAuthenticatedData: !!(
      isAuthenticated
      && isAccessReady
      && !accessRestricted
    ),
  };
}