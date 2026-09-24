const EVENT_FIELDS = new Set(['id', 'event_kind', 'status', 'event_start_date']);
const EVENT_GROUP_FIELDS = new Set(['event_kind', 'status']);

/**
 * Enforces the intentionally small Events dashboard contract. Events are a
 * union of simple and complex event records, not bookings, so only record
 * counts and event-level dimensions are meaningful.
 */
export function validateEventsConfig(config) {
  if (config?.source !== 'event') return;

  const measure = config.measure || {};
  if (measure.aggregator !== 'count'
      || measure.field
      || measure.fieldId
      || (Array.isArray(measure.additionalFields) && measure.additionalFields.length > 0)) {
    throw new Error('Events widgets only support Count with no measure field.');
  }

  if (config.groupBy) {
    if (config.groupBy.kind !== 'system'
        || !EVENT_GROUP_FIELDS.has(config.groupBy.field)
        || config.groupBy.fieldId) {
      throw new Error('Events can only be grouped by Event kind or Status.');
    }
  }

  if (config.timeBucket) {
    if (config.timeBucket.field !== 'event_start_date'
        || (config.timeBucket.fieldKind && config.timeBucket.fieldKind !== 'system')
        || config.timeBucket.fieldId) {
      throw new Error('Events can only be time-bucketed by Event start date.');
    }
  }

  for (const filter of config.filters || []) {
    if (filter.fieldKind !== 'system'
        || !filter.field
        || !EVENT_FIELDS.has(filter.field)
        || filter.fieldId
        || filter.orgField === true) {
      throw new Error('Events filters must use an Events system field.');
    }
  }

  if (config.participation === true) {
    throw new Error('Events do not support organisation participation.');
  }
  if (config.clickThrough === true) {
    throw new Error('Events do not support CRM click-through.');
  }
  if (config.seriesBy) {
    throw new Error('Events do not support a secondary series.');
  }
  if (config.transition?.mode || config.conversion || config.membershipValue) {
    throw new Error('Events cannot use settings from another dashboard source.');
  }
}

export default validateEventsConfig;