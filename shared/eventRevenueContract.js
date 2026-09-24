export const EVENT_REVENUE_BASIS = 'Booking value after discounts, including unpaid invoices; excludes cancelled bookings. Vouchers, training funds and account credit are payment allocations, not additional discounts. Not cash received or refund-reconciled. Time buckets use event start date (first session for complex events). Currency uses a booking snapshot where available, otherwise the current linked simple ticket/event currency; complex bookings use their stored currency. Missing currency evidence is unavailable. No currency conversion.';

export function validateEventRevenueConfig(config) {
  if (config?.source !== 'event_revenue') return;
  if (config.measure?.aggregator !== 'sum' || config.measure?.field !== 'booked_value'
      || config.measure?.fieldKind !== 'system' || config.measure?.fieldId
      || config.measure?.additionalFields?.length) {
    throw new Error('Event Revenue requires Sum of Booking value after discounts.');
  }
  if (!/^[A-Z]{3}$/.test(config.revenueCurrency || '')
      || (typeof Intl.supportedValuesOf === 'function' && !Intl.supportedValuesOf('currency').includes(config.revenueCurrency))) {
    throw new Error('Choose a three-letter reporting currency for Event Revenue.');
  }
  if (config.groupBy && (config.groupBy.kind !== 'system'
      || !['event_id', 'event_kind'].includes(config.groupBy.field) || config.groupBy.fieldId)) {
    throw new Error('Event Revenue can only be grouped by Event or Event kind.');
  }
  if (config.timeBucket && (config.timeBucket.field !== 'event_start_date'
      || config.timeBucket.fieldKind !== 'system' || config.timeBucket.fieldId
      || !['day', 'week', 'month', 'quarter', 'year'].includes(config.timeBucket.granularity))) {
    throw new Error('Event Revenue uses Event start date for time buckets.');
  }
  if (config.groupBy && config.timeBucket) throw new Error('Choose grouping or time buckets, not both.');
  for (const filter of config.filters || []) {
    if (filter.fieldKind !== 'system' || filter.fieldId || filter.orgField
        || !['event_id', 'event_kind', 'event_start_date'].includes(filter.field)) {
      throw new Error('Event Revenue filters must use Event, Event kind or Event start date.');
    }
    const operators = filter.field === 'event_start_date'
      ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null']
      : ['eq', 'neq', 'in', 'contains', 'is_null', 'is_not_null'];
    if (!operators.includes(filter.operator)) throw new Error('Unsupported Event Revenue filter comparison.');
    if (!['is_null', 'is_not_null'].includes(filter.operator)
        && (filter.value == null || filter.value === '' || (Array.isArray(filter.value) && !filter.value.length))) {
      throw new Error('Event Revenue filters need a comparison value.');
    }
  }
  if (config.participation || config.clickThrough || config.seriesBy
      || config.transition?.mode || config.conversion || config.membershipValue) {
    throw new Error('Event Revenue cannot use settings from another source.');
  }
}