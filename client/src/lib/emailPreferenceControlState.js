export function isCategoryPreferenceChecked({
  isMember,
  categoryIsSubscribed,
  optedOutAll,
  externalOptOutCompleted,
}) {
  if (isMember) {
    return categoryIsSubscribed && !optedOutAll;
  }
  return categoryIsSubscribed && !externalOptOutCompleted;
}

export function isGlobalPreferenceChecked({
  isMember,
  persistedOptedOutAll,
  externalOptOutCompleted,
}) {
  return isMember
    ? persistedOptedOutAll
    : persistedOptedOutAll || externalOptOutCompleted;
}