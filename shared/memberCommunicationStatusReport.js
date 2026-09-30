import {
  isMemberEligibleForCommunicationCategory,
} from './communicationCategoryMembership.js';

export const COMMUNICATION_STATUS_REPORT_DEFAULT_LIMIT = 50;
export const COMMUNICATION_STATUS_REPORT_MAX_LIMIT = 100;

const FILTER_VALUES = Object.freeze({
  globalOptOut: new Set(['all', 'yes', 'no']),
  categoryStatus: new Set(['opted_in', 'not_opted_in']),
});

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCommunicationStatusReportFilters(query = {}) {
  const page = Math.max(1, Number.parseInt(firstQueryValue(query.page), 10) || 1);
  const limit = Math.min(
    COMMUNICATION_STATUS_REPORT_MAX_LIMIT,
    Math.max(1, Number.parseInt(firstQueryValue(query.limit), 10)
      || COMMUNICATION_STATUS_REPORT_DEFAULT_LIMIT),
  );
  const globalOptOutValue = firstQueryValue(query.globalOptOut) || 'all';
  const categoryStatusValue = firstQueryValue(query.categoryStatus) || '';
  const categoryId = String(firstQueryValue(query.categoryId) || '').trim();

  return {
    page,
    limit,
    search: String(firstQueryValue(query.search) || '').trim().slice(0, 200),
    organizationId: String(firstQueryValue(query.organizationId) || '').trim(),
    roleId: String(firstQueryValue(query.roleId) || '').trim(),
    globalOptOut: FILTER_VALUES.globalOptOut.has(globalOptOutValue) ? globalOptOutValue : 'all',
    categoryId,
    categoryStatus: categoryId && FILTER_VALUES.categoryStatus.has(categoryStatusValue)
      ? categoryStatusValue
      : '',
  };
}

export function communicationCategoryAvailability(member, category, categoryRoleIds = []) {
  if (category?.is_active !== true) return { available: false, reason: 'inactive' };
  if (category?.member_enabled === false) return { available: false, reason: 'public_only' };
  if (!isMemberEligibleForCommunicationCategory(member, categoryRoleIds, category)) {
    return { available: false, reason: 'role_ineligible' };
  }
  return { available: true, reason: null };
}

export function buildCommunicationStatusReportRow(
  member,
  categories,
  preferences,
  rolesByCategory,
) {
  const explicitOptIns = new Set(
    (preferences || [])
      .filter((preference) => preference.is_subscribed === true)
      .map((preference) => preference.category_id),
  );

  const categoryStatuses = {};
  for (const category of categories || []) {
    const availability = communicationCategoryAvailability(
      member,
      category,
      rolesByCategory.get(category.id) || [],
    );
    categoryStatuses[category.id] = {
      optedIn: explicitOptIns.has(category.id),
      available: availability.available,
      unavailableReason: availability.reason,
    };
  }

  return {
    memberId: member.id,
    firstName: member.first_name || '',
    lastName: member.last_name || '',
    name: [member.first_name, member.last_name].filter(Boolean).join(' '),
    email: member.email || '',
    organizationId: member.organization_id || null,
    organizationName: member.organization?.name || '',
    roleId: member.role_id || null,
    roleName: member.role?.name || '',
    loginEnabled: member.login_enabled !== false,
    globalOptOut: member.communications_opted_out_all === true,
    categoryStatuses,
  };
}

export function reportCategoryMetadata(category, rolesByCategory) {
  return {
    id: category.id,
    name: category.name || '',
    displayOrder: category.display_order ?? 0,
    active: category.is_active === true,
    publicOnly: category.member_enabled === false,
    roleIds: [...(rolesByCategory.get(category.id) || [])],
  };
}