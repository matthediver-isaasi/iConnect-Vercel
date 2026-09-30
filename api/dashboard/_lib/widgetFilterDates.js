import { getCustomFieldsForSource, getSourceDef } from './sources.js';
import {
  isWidgetDateOperator,
  normalizeWidgetDate,
  widgetDateError,
} from '../../../shared/widgetFilterDates.js';

export const WIDGET_DATE_FILTER_VERSION = 'instant-v1';

export async function normalizeWidgetConfigDateFilters(config, tenantId) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.filters)) return config;
  const source = getSourceDef(config.source);
  if (!source) return config;

  const systemDates = new Set(
    (source.systemFields || []).filter(field => field.type === 'date').map(field => field.name),
  );
  const customDateIds = new Set();
  if (config.filters.some(filter => filter.fieldKind === 'custom' && filter.fieldId)) {
    const customFields = await getCustomFieldsForSource(source, tenantId);
    customFields
      .filter(field => field.type === 'date')
      .forEach(field => customDateIds.add(field.id));

    // Booking orgField filters refer to organisation metadata, not booking metadata.
    if (source.isBooking && config.filters.some(filter => filter.orgField === true)) {
      const organisationFields = await getCustomFieldsForSource('organization', tenantId);
      organisationFields
        .filter(field => field.type === 'date')
        .forEach(field => customDateIds.add(field.id));
    }
  }

  let hasDateComparison = false;
  const filters = config.filters.map((filter, index) => {
    const isDate = filter.fieldKind === 'system'
      ? systemDates.has(filter.field)
      : customDateIds.has(filter.fieldId);
    if (!isDate || !isWidgetDateOperator(filter.operator)) {
      // Source metadata, never a client-supplied hint, controls date semantics.
      // This keeps date-looking text, numbers and list values on their existing
      // comparison paths.
      const { valueType: _ignored, ...unchanged } = filter;
      return unchanged;
    }

    const value = normalizeWidgetDate(filter.value);
    if (!value) {
      throw new Error(`Filter ${index + 1}: ${widgetDateError(filter.value)}`);
    }
    hasDateComparison = true;
    return { ...filter, value, valueType: 'date' };
  });
  const normalized = { ...config, filters };
  // This server-owned marker participates in the database cache identity
  // because it is persisted inside config on create/update. Future semantic
  // changes can increment it without relying on a wall-clock rollout cutoff.
  if (hasDateComparison) normalized.dateFilterVersion = WIDGET_DATE_FILTER_VERSION;
  else delete normalized.dateFilterVersion;
  return normalized;
}

export function matchWidgetDateFilter(rawValue, filter) {
  const actual = normalizeWidgetDate(
    rawValue instanceof Date ? rawValue.toISOString() : String(rawValue ?? ''),
  );
  if (!actual) return false;
  const actualTime = Date.parse(actual);
  const expectedTime = Date.parse(filter.value);
  if (!Number.isFinite(actualTime) || !Number.isFinite(expectedTime)) return false;

  if (filter.operator === 'eq') return actualTime === expectedTime;
  if (filter.operator === 'neq') return actualTime !== expectedTime;
  if (filter.operator === 'gt') return actualTime > expectedTime;
  if (filter.operator === 'gte') return actualTime >= expectedTime;
  if (filter.operator === 'lt') return actualTime < expectedTime;
  if (filter.operator === 'lte') return actualTime <= expectedTime;
  return false;
}