export function getMemberBadgePanelState({
  isLoading = false,
  isError = false,
  awards = [],
  availableBadges = [],
  canManage = false,
} = {}) {
  if (isLoading) return { kind: 'loading', canAward: false };
  if (isError) return { kind: 'error', canAward: false };
  return {
    kind: awards.length > 0 ? 'history' : 'empty',
    canAward: canManage && availableBadges.length > 0,
    showAwardControl: canManage,
    activeAwards: awards.filter((award) => award.status === 'active').length,
    revokedAwards: awards.filter((award) => award.status === 'revoked').length,
  };
}
