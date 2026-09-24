import { fetchPaged, loadEventRows } from './eventAggregation.js';
import { EVENT_REVENUE_BASIS, validateEventRevenueConfig } from '../../../shared/eventRevenueContract.js';

// These are attendee rows, not group charges: the simple checkout writer
// divides total_cost and discount_code_amount by ticketsRequired. The complex
// checkout writer stores the already code-discounted unit ticket_price per row.
// Do not deduplicate by booking_group_reference or subtract complex discounts
// again. See createOneOffEventBooking and public/complex-event-booking.js.
export function bookedValue(row, kind) {
  const requiredMoney = (value, field) => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === ''
        || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new Error(`Event Revenue unavailable: booking ${row.id} has invalid ${field}.`);
    }
    return Number(value);
  };
  const base = requiredMoney(kind === 'simple' ? row.total_cost : row.ticket_price,
    kind === 'simple' ? 'total_cost' : 'ticket_price');
  if (kind === 'simple' && row.discount_code_id && row.discount_code_amount == null) {
    throw new Error(`Event Revenue unavailable: booking ${row.id} has no discount amount.`);
  }
  const discount = kind === 'simple'
    ? requiredMoney(row.discount_code_amount ?? 0, 'discount_code_amount') : 0;
  if (discount > base) throw new Error(`Event Revenue unavailable: discount exceeds booking value (${row.id}).`);
  return base - discount;
}

export function simpleBookingCurrency(booking, pricing) {
  const snapshot = booking.purchaser_context?.financial_snapshot?.currency;
  if (snapshot) return String(snapshot).toUpperCase();
  // The simple booking schema has no currency column. Never silently default
  // historic bookings to GBP merely because that is the current checkout UI's
  // default. Require explicit linked-ticket/event configuration evidence.
  const ticket = booking.ticket_class_id
    ? pricing?.ticket_classes?.find(ticket => String(ticket.id) === String(booking.ticket_class_id))
    : null;
  return String(booking.ticket_class_id ? ticket?.currency || '' : pricing?.currency || '').toUpperCase();
}

export async function eventRevenueOptions(client, tenantId, { withPricing = false } = {}) {
  const [simple, complex] = await Promise.all([
    fetchPaged(client, 'event', `id,title${withPricing ? ',pricing_config' : ''}`, tenantId),
    fetchPaged(client, 'complex_event', 'id,title', tenantId),
  ]);
  return [...simple.map(row => ({ value: `simple:${row.id}`, label: `${row.title || row.id} (simple)`,
    ...(withPricing ? { pricing: row.pricing_config } : {}) })),
    ...complex.map(row => ({ value: `complex:${row.id}`, label: `${row.title || row.id} (complex)` }))];
}

export async function runEventRevenueWidget(config, tenantId, client, helpers, maxGroups = 30) {
  validateEventRevenueConfig(config);
  const { matchFilter, bucketTimestamp, finalizeTimeRows, resolveTimeWindowStart } = helpers;
  const now = new Date();
  const windowStart = config.timeBucket?.window ? resolveTimeWindowStart(config.timeBucket.window, now) : null;
  const [events, names, simple, complex] = await Promise.all([
    loadEventRows(client, tenantId),
    eventRevenueOptions(client, tenantId, { withPricing: true }),
    fetchPaged(client, 'booking', 'id,event_id,status,total_cost,discount_code_amount,discount_code_id,ticket_class_id,purchaser_context', tenantId),
    fetchPaged(client, 'complex_event_booking', 'id,event_id,status,ticket_price,currency', tenantId),
  ]);
  const eventMap = new Map(events.map(row => [row.id, row]));
  const nameMap = new Map(names.map(row => [row.value, row.label]));
  const pricingMap = new Map(names.map(row => [row.value, row.pricing]));
  const selected = [];
  let otherCurrencyCount = 0;
  for (const [kind, bookings] of [['simple', simple], ['complex', complex]]) {
    for (const booking of bookings) {
      if (String(booking.status || '').toLowerCase() === 'cancelled') continue;
      const eventId = `${kind}:${booking.event_id}`;
      // Event-id/kind filters can exclude unrelated historic orphan bookings.
      const event = eventMap.get(eventId);
      const row = { ...event, event_id: eventId, event_kind: kind };
      if (!(config.filters || []).every(filter => matchFilter(row[filter.field], filter, null, false))) continue;
      if (!event) throw new Error(`Event Revenue unavailable: booking ${booking.id} has no tenant event.`);
      if (windowStart && event.event_start_date) {
        const key = bucketTimestamp(event.event_start_date, config.timeBucket.granularity);
        if (key < bucketTimestamp(windowStart, config.timeBucket.granularity)
            || key > bucketTimestamp(now, config.timeBucket.granularity)) continue;
      }
      const currency = kind === 'simple'
        ? simpleBookingCurrency(booking, pricingMap.get(eventId))
        : String(booking.currency || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)
          || (typeof Intl.supportedValuesOf === 'function' && !Intl.supportedValuesOf('currency').includes(currency))) {
        throw new Error(`Event Revenue unavailable: booking ${booking.id} has no valid currency.`);
      }
      if (currency !== config.revenueCurrency) { otherCurrencyCount++; continue; }
      if (config.timeBucket && !event.event_start_date) {
        throw new Error('Event Revenue cannot time-bucket bookings for unscheduled events. Filter to a dated event period.');
      }
      selected.push({ ...row, value: bookedValue(booking, kind) });
    }
  }
  // Sum unrounded attendee allocations before rounding (e.g. £10 / 3 seats).
  const precision = new Intl.NumberFormat('en', { style: 'currency', currency: config.revenueCurrency })
    .resolvedOptions().maximumFractionDigits;
  const round = value => {
    const factor = 10 ** precision;
    if (!Number.isFinite(value) || Math.abs(value * factor) > Number.MAX_SAFE_INTEGER) {
      throw new Error('Event Revenue exceeds safe monetary precision; narrow the event filters.');
    }
    return Math.round((value + Math.max(1, Math.abs(value)) * Number.EPSILON) * factor) / factor;
  };
  // Round each event's summed attendee allocations once, then aggregate those
  // currency amounts. Scalar, grouped and time views consequently reconcile
  // even when allocations contain fractional minor units.
  const byEvent = new Map();
  for (const row of selected) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, { ...row, value: 0 });
    byEvent.get(row.event_id).value += row.value;
  }
  const workingRows = [...byEvent.values()].map(row => ({ ...row, value: round(row.value) }));
  const sum = rows => round(rows.reduce((total, row) => total + row.value, 0));
  const metadata = {
    currency: config.revenueCurrency,
    revenueBasis: EVENT_REVENUE_BASIS,
    excludedOtherCurrencyBookings: otherCurrencyCount,
    total: sum(workingRows),
  };
  if (!config.groupBy && !config.timeBucket) {
    const value = sum(workingRows);
    return { ...metadata, type: 'scalar', value, rows: [{ key: 'total', value }] };
  }
  const buckets = new Map();
  for (const row of workingRows) {
    const key = config.timeBucket
      ? bucketTimestamp(row.event_start_date, config.timeBucket.granularity)
      : row[config.groupBy.field];
    if (!key) throw new Error('Event Revenue encountered an invalid event date.');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row.value);
  }
  if (config.timeBucket) {
    const rows = finalizeTimeRows(buckets, config.timeBucket, 'sum', config.cumulative, now)
      .map(row => ({ ...row, value: round(row.value) }));
    return { ...metadata, type: 'time', categories: ['value'], rows,
      total: config.cumulative ? rows.at(-1)?.value || 0 : round(rows.reduce((total, row) => total + row.value, 0)),
      granularity: config.timeBucket.granularity };
  }
  if (buckets.size > maxGroups) throw new Error(`Event Revenue produced too many groups (maximum ${maxGroups}); narrow the event filters.`);
  const rows = [...buckets].map(([key, values]) => ({
    key: config.groupBy.field === 'event_id' ? `${nameMap.get(key) || key} [${key}]` : key,
    value: round(values.reduce((total, value) => total + value, 0)),
  })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  return { ...metadata, type: 'group', categories: ['value'], rows };
}