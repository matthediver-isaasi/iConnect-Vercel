const DELETED_MEMBER_EMAIL = /^deleted_.*@deleted\.local$/i;

export function getToggledExplicitSubscriptionValue(existingPreference) {
  return existingPreference?.is_subscribed !== true;
}

export function getExplicitlySubscribedMemberIds(preferences, categoryIds) {
  const selectedCategoryIds = new Set((categoryIds || []).filter(Boolean));
  const memberIds = new Set();

  for (const preference of preferences || []) {
    if (
      preference?.is_subscribed === true &&
      selectedCategoryIds.has(preference.category_id) &&
      preference.member_id
    ) {
      memberIds.add(preference.member_id);
    }
  }

  return memberIds;
}

export function isActiveCommunicationMember(member) {
  return Boolean(
    member?.id &&
    member?.email &&
    !DELETED_MEMBER_EMAIL.test(member.email) &&
    member.login_enabled !== false
  );
}

export function isEligibleCommunicationMember(member) {
  return isActiveCommunicationMember(member) &&
    member.communications_opted_out_all !== true;
}

export function filterExplicitCategorySubscribers(
  members,
  preferences,
  categoryIds,
  { includeGlobalOptOuts = false } = {}
) {
  const subscribedMemberIds = getExplicitlySubscribedMemberIds(preferences, categoryIds);
  const seenMemberIds = new Set();

  return (members || []).filter((member) => {
    const eligible = includeGlobalOptOuts
      ? isActiveCommunicationMember(member)
      : isEligibleCommunicationMember(member);
    if (
      !eligible ||
      !subscribedMemberIds.has(member.id) ||
      seenMemberIds.has(member.id)
    ) {
      return false;
    }
    seenMemberIds.add(member.id);
    return true;
  });
}

export function mergeExternalCategorySubscribers(
  memberSubscribers,
  externalSubscribers,
  tenantMembers
) {
  const tenantMemberEmails = new Set(
    (tenantMembers || [])
      .map(({ email }) => String(email || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const seenEmails = new Set(
    (memberSubscribers || [])
      .map(({ email }) => String(email || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const recipients = [...(memberSubscribers || [])];

  for (const subscriber of externalSubscribers || []) {
    const email = String(subscriber?.email || '').trim().toLowerCase();
    if (!email || tenantMemberEmails.has(email) || seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipients.push({
      id: subscriber.id,
      member_id: null,
      email: subscriber.email,
      first_name: subscriber.first_name,
      last_name: subscriber.last_name,
    });
  }

  return recipients;
}