export function validateRoleMemberGroupPolicy(value = {}) {
  if (Object.hasOwn(value, 'max_member_groups')) {
    const maximum = value.max_member_groups;
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 2147483647)) {
      return 'Maximum Member Groups must be blank (unlimited) or a nonnegative whole number.';
    }
  }
  if (Object.hasOwn(value, 'exclude_auto_joined_groups_from_limit')
    && typeof value.exclude_auto_joined_groups_from_limit !== 'boolean') {
    return 'Exclude Auto-Joined Groups from Limit must be true or false.';
  }
  return null;
}
