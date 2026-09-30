import { PUBLIC_SIMPLE_EVENT_STATUSES } from '../../shared/eventTiming.js';

const COMPLEX_EVENT_STATUSES = ['published', 'tbc'];

/**
 * Visibility used by event-card click ingestion. This intentionally mirrors
 * the /Events listing rules: public timing status, no drafts, and private
 * group events only for an active group member (or tenant administrator).
 */
export function isEventCardClickVisible(
  row,
  {
    eventType,
    tenantId,
    isAuthenticated = false,
    isTenantAdmin = false,
    groupIds = new Set(),
  } = {},
) {
  if (!row || row.tenant_id !== tenantId) return false;
  if (eventType !== 'simple' && eventType !== 'complex') return false;

  const statusAllowed = eventType === 'simple'
    ? PUBLIC_SIMPLE_EVENT_STATUSES.includes(row.status)
    : COMPLEX_EVENT_STATUSES.includes(row.status)
      && (row.event_state == null || row.event_state === 'active' || row.event_state === 'closed');
  if (!statusAllowed || row.event_state === 'draft') return false;

  // Match useEventsData: legacy bespoke RSVP group events have no ticket
  // classes and are dormant, even when their group visibility flag is public.
  if (
    eventType === 'simple'
    && row.member_group_id
    && (!Array.isArray(row.pricing_config?.ticket_classes)
      || row.pricing_config.ticket_classes.length === 0)
  ) {
    return false;
  }

  if (!row.member_group_id || row.group_event_public === true) return true;
  if (!isAuthenticated || isTenantAdmin) return isAuthenticated || row.group_event_public === true;
  return groupIds instanceof Set
    ? groupIds.has(row.member_group_id)
    : new Set(groupIds || []).has(row.member_group_id);
}

export function eventClickTable(eventType) {
  return eventType === 'simple' ? 'event' : 'complex_event';
}