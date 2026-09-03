export function canUseEventsPageTour({ memberInfo, memberRole }) {
  return Boolean(memberInfo && memberRole && memberRole.show_tours !== false);
}