export function shouldShowMemberMembershipTab({ member, isNew = false } = {}) {
  return !isNew && Boolean(member?.id);
}
