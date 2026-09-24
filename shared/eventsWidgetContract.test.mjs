import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEventsConfig } from './eventsWidgetContract.js';

function config(patch = {}) {
  return {
    source: 'event',
    measure: { aggregator: 'count', field: null, fieldKind: null, fieldId: null },
    filters: [],
    ...patch,
  };
}

test('Events accepts count, supported grouping, start-date buckets and system filters', () => {
  assert.doesNotThrow(() => validateEventsConfig(config({
    groupBy: { kind: 'system', field: 'status', fieldId: null },
    filters: [
      { fieldKind: 'system', field: 'event_kind', operator: 'eq', value: 'complex' },
      { fieldKind: 'system', field: 'event_start_date', operator: 'lte', value: '2026-06-30' },
    ],
  })));
  assert.doesNotThrow(() => validateEventsConfig(config({
    timeBucket: {
      field: 'event_start_date',
      fieldKind: 'system',
      fieldId: null,
      granularity: 'month',
    },
  })));
});

test('Events rejects non-count measures and unsupported grouping or time fields', () => {
  assert.throws(
    () => validateEventsConfig(config({ measure: { aggregator: 'count_distinct', field: 'status', fieldKind: 'system' } })),
    /only support Count/,
  );
  assert.throws(
    () => validateEventsConfig(config({ groupBy: { kind: 'system', field: 'id' } })),
    /only be grouped/,
  );
  assert.throws(
    () => validateEventsConfig(config({ timeBucket: { field: 'created_at', granularity: 'month' } })),
    /Event start date/,
  );
});

test('Events rejects custom/org filters and capabilities belonging to other sources', () => {
  assert.throws(
    () => validateEventsConfig(config({
      filters: [{ fieldKind: 'custom', fieldId: 'field-1', operator: 'eq', value: 'x' }],
    })),
    /system field/,
  );
  assert.throws(
    () => validateEventsConfig(config({ participation: true })),
    /participation/,
  );
  assert.throws(
    () => validateEventsConfig(config({ clickThrough: true })),
    /click-through/,
  );
  assert.throws(
    () => validateEventsConfig(config({ conversion: { sourceFormId: 'a' } })),
    /another dashboard source/,
  );
});

test('Events validation is a no-op for existing sources', () => {
  assert.doesNotThrow(() => validateEventsConfig({
    source: 'event_booking',
    measure: { aggregator: 'count_distinct', field: 'organization_id' },
    participation: true,
  }));
});

test('dashboard widget schema invokes the Events contract for saved configs', async () => {
  const { widgetConfigSchema } = await import('../api/dashboard/_lib/validation.js');
  const valid = widgetConfigSchema.parse(config({
    groupBy: { kind: 'system', field: 'event_kind' },
  }));
  assert.equal(valid.source, 'event');

  const invalid = widgetConfigSchema.safeParse(config({
    participation: true,
  }));
  assert.equal(invalid.success, false);
  assert.match(invalid.error.issues.map(issue => issue.message).join(' '), /participation/);
});