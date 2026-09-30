const DELETED_MEMBER_EMAIL = /^deleted_.*@deleted\.local$/i;

export const COMMUNICATION_CATEGORY_AUDIENCE = Object.freeze({
  MEMBERS_ONLY: 'members_only',
  PUBLIC_ONLY: 'public_only',
  PUBLIC_AND_MEMBERS: 'public_and_members',
});

export function getCommunicationCategoryAudienceMode(category) {
  const members = category?.member_enabled !== false;
  const publicAccess = category?.is_public === true;
  if (members && publicAccess) return COMMUNICATION_CATEGORY_AUDIENCE.PUBLIC_AND_MEMBERS;
  if (publicAccess) return COMMUNICATION_CATEGORY_AUDIENCE.PUBLIC_ONLY;
  return COMMUNICATION_CATEGORY_AUDIENCE.MEMBERS_ONLY;
}

export function applyCommunicationCategoryAudienceMode(category, audienceMode) {
  return {
    ...category,
    audienceMode,
    member_enabled: audienceMode !== COMMUNICATION_CATEGORY_AUDIENCE.PUBLIC_ONLY,
    is_public: audienceMode !== COMMUNICATION_CATEGORY_AUDIENCE.MEMBERS_ONLY,
  };
}

export function normalizeCommunicationRoleIds(roleId) {
  if (!roleId) return [];
  return (Array.isArray(roleId) ? roleId : [roleId]).filter(Boolean);
}

export function isCommunicationCategoryMemberEnabled(category) {
  return category?.member_enabled !== false;
}

export function isMemberEligibleForCommunicationCategory(member, categoryRoleIds, category = null) {
  if (!isCommunicationCategoryMemberEnabled(category)) return false;
  const applicableRoleIds = normalizeCommunicationRoleIds(categoryRoleIds);
  if (applicableRoleIds.length === 0) return true;

  const memberRoleIds = normalizeCommunicationRoleIds(member?.role_id);
  return memberRoleIds.some((roleId) => applicableRoleIds.includes(roleId));
}

export function filterCommunicationCategoriesForMember(categories, roleAssignments, member) {
  const rolesByCategory = new Map();
  for (const assignment of roleAssignments || []) {
    if (!assignment?.category_id || !assignment?.role_id) continue;
    const roleIds = rolesByCategory.get(assignment.category_id) || [];
    roleIds.push(assignment.role_id);
    rolesByCategory.set(assignment.category_id, roleIds);
  }

  return (categories || []).filter((category) =>
    isMemberEligibleForCommunicationCategory(
      member,
      rolesByCategory.get(category.id) || [],
      category,
    )
  );
}

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