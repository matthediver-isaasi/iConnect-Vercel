const arrayFrom = (value, keys) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
};

export function getOpportunitiesFromResponse(response) {
  return arrayFrom(response, ['opportunities', 'items', 'data', 'results']);
}

export function getOpportunityActivityFromResponse(response) {
  const direct = arrayFrom(response, ['activity', 'activities', 'events']);
  if (direct.length > 0) return direct;

  return getOpportunitiesFromResponse(response).flatMap((opportunity) => {
    const activity = arrayFrom(opportunity, ['activity', 'activities', 'events']);
    return activity.map((item) => ({
      ...item,
      opportunityId: item.opportunityId || item.opportunity_id || opportunity.id,
      opportunityName:
        item.opportunityName ||
        item.opportunity_name ||
        opportunity.name ||
        opportunity.title,
    }));
  });
}

export function responseIncludesOpportunityActivity(response) {
  if (Array.isArray(response?.activity) || Array.isArray(response?.activities) || Array.isArray(response?.events)) {
    return true;
  }
  return getOpportunitiesFromResponse(response).some(
    (opportunity) =>
      Array.isArray(opportunity?.activity) ||
      Array.isArray(opportunity?.activities) ||
      Array.isArray(opportunity?.events),
  );
}

export function opportunityActivityDate(item) {
  return (
    item?.createdAt ||
    item?.created_at ||
    item?.occurredAt ||
    item?.occurred_at ||
    item?.activityDate ||
    item?.activity_date ||
    item?.date ||
    null
  );
}

export function opportunityActivityLabel(item) {
  return (
    item?.description ||
    item?.summary ||
    item?.message ||
    item?.action ||
    item?.activityType ||
    item?.activity_type ||
    item?.type ||
    'Opportunity updated'
  );
}

export function mergeOpportunityActivity(...collections) {
  const seen = new Set();
  return collections
    .flat()
    .filter(Boolean)
    .filter((item) => {
      const key = item.id
        ? `id:${item.id}`
        : [
            item.opportunityId || item.opportunity_id || '',
            opportunityActivityDate(item) || '',
            opportunityActivityLabel(item),
          ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        new Date(opportunityActivityDate(b) || 0).getTime() -
        new Date(opportunityActivityDate(a) || 0).getTime(),
    );
}

export function buildOpportunityQuery({ organizationId, memberId, activity = false }) {
  const params = new URLSearchParams();
  if (organizationId) params.set('organizationId', organizationId);
  if (memberId) params.set(activity ? 'memberId' : 'contactMemberId', memberId);
  if (!activity) {
    params.set('page', '1');
    params.set('pageSize', '20');
  }
  return `/api/opportunities${activity ? '/activity' : ''}?${params.toString()}`;
}