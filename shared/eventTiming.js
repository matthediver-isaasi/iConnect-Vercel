export const SIMPLE_EVENT_TIMING = Object.freeze({
  SCHEDULED: 'published',
  TBC: 'tbc',
  IMMEDIATE: 'immediate',
});

export const PUBLIC_SIMPLE_EVENT_STATUSES = Object.freeze([
  SIMPLE_EVENT_TIMING.SCHEDULED,
  SIMPLE_EVENT_TIMING.TBC,
  SIMPLE_EVENT_TIMING.IMMEDIATE,
]);

export const PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES = Object.freeze([
  ...PUBLIC_SIMPLE_EVENT_STATUSES,
  'draft',
]);

const IMMEDIATE_SCHEDULE_FIELDS = Object.freeze([
  'start_date',
  'end_date',
  'registration_closes_at',
  'timezone',
  'zoom_webinar_id',
  'zoom_meeting_id',
]);

function timingStatus(value) {
  return typeof value === 'string' ? value : value?.status;
}

export function isImmediateEvent(value) {
  return timingStatus(value) === SIMPLE_EVENT_TIMING.IMMEDIATE;
}

export function isTbcEvent(value) {
  return timingStatus(value) === SIMPLE_EVENT_TIMING.TBC;
}

export function isPublicSimpleEventStatus(value) {
  return PUBLIC_SIMPLE_EVENT_STATUSES.includes(timingStatus(value));
}

export function resolveSimpleEventOnlineState(event, location = '') {
  // Preserve the existing TBC editor behavior. Immediate events, unlike TBC,
  // retain their delivery mode even though their schedule and Zoom ids are gone.
  if (isTbcEvent(event)) return false;
  if (event?.is_online !== undefined) return event.is_online === true;
  const locationText = String(location || event?.location || '').toLowerCase();
  return (
    locationText.includes('online') ||
    locationText.includes('zoom.us') ||
    locationText.includes('https://')
  );
}

export function canUseImmediateTiming({
  isTraining = false,
  isComplex = false,
  isGroupLimited = false,
} = {}) {
  return !isTraining && !isComplex && !isGroupLimited;
}

export function normalizeSimpleEventTiming(status, options = {}) {
  if (
    status === SIMPLE_EVENT_TIMING.IMMEDIATE &&
    canUseImmediateTiming(options)
  ) {
    return SIMPLE_EVENT_TIMING.IMMEDIATE;
  }
  if (status === SIMPLE_EVENT_TIMING.TBC) {
    return SIMPLE_EVENT_TIMING.TBC;
  }
  return SIMPLE_EVENT_TIMING.SCHEDULED;
}

/**
 * Validate and normalize a generic simple-event write against the row's final
 * state. This handles partial PATCH payloads as well as full creates.
 */
export function normalizeSimpleEventWrite(body = {}, existingEvent = null) {
  const finalEvent = { ...(existingEvent || {}), ...(body || {}) };
  if (!isImmediateEvent(finalEvent)) {
    return { ok: true, body };
  }

  // Match the create/edit transition: turning on training while Immediate is
  // selected moves timing back to Scheduled and preserves the training schedule.
  if (finalEvent.is_training === true) {
    return {
      ok: true,
      body: {
        ...(body || {}),
        status: SIMPLE_EVENT_TIMING.SCHEDULED,
      },
    };
  }

  if (Boolean(finalEvent.member_group_id)) {
    return {
      ok: false,
      status: 400,
      error: 'Immediate access is not available for group events',
    };
  }

  return {
    ok: true,
    body: suppressImmediateSchedule({
      ...(body || {}),
      status: SIMPLE_EVENT_TIMING.IMMEDIATE,
    }),
  };
}

export function suppressImmediateSchedule(event) {
  if (!event || typeof event !== 'object' || !isImmediateEvent(event)) return event;
  const normalized = { ...event };
  for (const field of IMMEDIATE_SCHEDULE_FIELDS) normalized[field] = null;
  normalized.is_training = false;
  normalized.agenda_summary = undefined;
  return normalized;
}

export function isEventInPast(event, now = new Date()) {
  if (isImmediateEvent(event)) return false;
  const dateValue = event?.end_date || event?.start_date;
  if (!dateValue) return false;
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return Number.isFinite(date.getTime()) && date < now;
}

export function getEventTimingSortBucket(event) {
  if (isImmediateEvent(event)) return 1;
  if (isTbcEvent(event) || !event?.start_date) return 2;
  return 0;
}

export function compareEventsByTiming(a, b) {
  const bucketA = getEventTimingSortBucket(a);
  const bucketB = getEventTimingSortBucket(b);
  if (bucketA !== bucketB) return bucketA - bucketB;

  if (bucketA === 0) {
    const dateA = new Date(a.start_date).getTime();
    const dateB = new Date(b.start_date).getTime();
    if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) {
      return dateA - dateB;
    }
    if (Number.isFinite(dateA) !== Number.isFinite(dateB)) {
      return Number.isFinite(dateA) ? -1 : 1;
    }
  }

  const titleOrder = String(a?.title || '').localeCompare(String(b?.title || ''));
  if (titleOrder !== 0) return titleOrder;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}