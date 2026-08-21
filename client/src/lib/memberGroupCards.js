export const DEFAULT_MEMBER_GROUP_CARD_LIMIT = 6;
export const MAX_MEMBER_GROUP_CARD_LIMIT = 24;
export const MEMBER_GROUP_CARD_SOURCE = Object.freeze({
  SELF_JOIN: 'self_join',
  SELECTED: 'selected',
});

export function resolveMemberGroupCardSource(value) {
  return value === MEMBER_GROUP_CARD_SOURCE.SELECTED
    ? MEMBER_GROUP_CARD_SOURCE.SELECTED
    : MEMBER_GROUP_CARD_SOURCE.SELF_JOIN;
}

export function resolveSelectedMemberGroupIds(value) {
  const selected = [];
  const seen = new Set();
  for (const rawId of Array.isArray(value) ? value : []) {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
    if (selected.length === MAX_MEMBER_GROUP_CARD_LIMIT) break;
  }
  return selected;
}

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

export function selectSelectedMemberGroups(groups, selectedIds) {
  const availableById = new Map(
    (Array.isArray(groups) ? groups : [])
      .filter((group) => group?.id && group.is_active !== false)
      .map((group) => [String(group.id), group]),
  );
  return resolveSelectedMemberGroupIds(selectedIds)
    .map((id) => availableById.get(id))
    .filter(Boolean);
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