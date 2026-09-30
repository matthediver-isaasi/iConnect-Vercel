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

export function getEmailPreferenceControlState({
  optedOutAll,
  categoryIsSubscribed,
  updating = false,
}) {
  const subscribed = categoryIsSubscribed === true && !optedOutAll;
  return {
    checked: subscribed,
    disabled: updating || optedOutAll,
    status: subscribed ? 'Subscribed' : 'Opted out',
    cardClassName: subscribed
      ? 'border-green-300 bg-green-50 text-green-950'
      : 'border-red-300 bg-red-50 text-red-950',
    guidance: optedOutAll
      ? 'This category is stopped because you opted out of all emails. Turn off the global opt-out above before changing individual categories.'
      : subscribed
        ? 'On: you will receive emails in this category. Turn off to stop them.'
        : 'Off: you will not receive emails in this category. Turn on to subscribe again.',
  };
}

export function getGlobalEmailPreferenceControlState({ optedOutAll, updating = false }) {
  return {
    checked: optedOutAll,
    disabled: updating,
    status: optedOutAll ? 'All marketing emails stopped' : 'Marketing emails enabled',
    cardClassName: optedOutAll
      ? 'border-red-300 bg-red-50 text-red-950'
      : 'border-green-300 bg-green-50 text-green-950',
    guidance: optedOutAll
      ? 'On: all marketing emails are stopped. Turn off to manage categories individually; categories you opted out of will stay stopped.'
      : 'Off: marketing emails are enabled according to the category choices below. Turn on to stop all marketing emails.',
  };
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