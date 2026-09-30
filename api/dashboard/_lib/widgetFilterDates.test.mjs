import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWidgetDateOperator,
  normalizeWidgetDate,
  widgetDateError,
} from '../../../shared/widgetFilterDates.js';
import {
  matchWidgetDateFilter,
  normalizeWidgetConfigDateFilters,
} from './widgetFilterDates.js';
import { matchFilter } from './aggregation.js';

test('normalizes strict British and ISO calendar dates without ambiguity', () => {
  assert.equal(normalizeWidgetDate('31/01/2026'), '2026-01-31');
  assert.equal(normalizeWidgetDate('2026-01-31'), '2026-01-31');
  assert.equal(normalizeWidgetDate('2026-01-31T12:30:00+01:00'), '2026-01-31T11:30:00.000Z');
  assert.equal(normalizeWidgetDate('2026-01-31T12:30:00'), new Date('2026-01-31T12:30:00').toISOString());
  assert.equal(normalizeWidgetDate('2026-01-31 12:30:00'), new Date('2026-01-31 12:30:00').toISOString());
  assert.equal(normalizeWidgetDate('01/02/2026'), '2026-02-01');
});

test('rejects rollover dates and non-ISO ambiguous values', () => {
  for (const value of [
    '31/02/2026',
    '2026-02-29',
    '2026-02-31T12:00:00Z',
    '1/2/2026',
    '02/01/26',
    '01-02-2026',
  ]) {
    assert.equal(normalizeWidgetDate(value), null, value);
    assert.match(widgetDateError(value), /valid calendar date|DD\/MM\/YYYY/);
  }
  assert.equal(normalizeWidgetDate('29/02/2024'), '2024-02-29');
});

test('only comparison operators are date-value operators', () => {
  for (const operator of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
    assert.equal(isWidgetDateOperator(operator), true);
  }
  for (const operator of ['contains', 'in', 'is_null']) {
    assert.equal(isWidgetDateOperator(operator), false);
  }
});

test('source metadata limits normalization to date fields', async () => {
  const config = await normalizeWidgetConfigDateFilters({
    source: 'event_booking',
    measure: { aggregator: 'count' },
    filters: [
      { fieldKind: 'system', field: 'created_at', operator: 'gte', value: '05/04/2026' },
      {
        fieldKind: 'system',
        field: 'status',
        operator: 'eq',
        value: '05/04/2026',
        valueType: 'date',
      },
    ],
  }, 'tenant');
  assert.deepEqual(config.filters[0], {
    fieldKind: 'system',
    field: 'created_at',
    operator: 'gte',
    value: '2026-04-05',
    valueType: 'date',
  });
  assert.equal(config.dateFilterVersion, 'instant-v1');
  assert.equal(config.filters[1].value, '05/04/2026');
  assert.equal(config.filters[1].valueType, undefined);
});

test('date-only operands retain existing midnight-instant comparison semantics', () => {
  const eq = { operator: 'eq', value: '2026-04-05', valueType: 'date' };
  const neq = { operator: 'neq', value: '2026-04-05', valueType: 'date' };
  assert.equal(matchWidgetDateFilter('2026-04-05T00:00:00.000Z', eq), true);
  assert.equal(matchWidgetDateFilter('05/04/2026', eq), true);
  assert.equal(matchWidgetDateFilter('2026-04-05T23:59:59.999Z', eq), false);
  assert.equal(matchWidgetDateFilter('2026-04-06T00:00:00.000Z', eq), false);
  assert.equal(matchWidgetDateFilter('2026-04-05T12:00:00.000Z', neq), true);
  assert.equal(matchWidgetDateFilter('2026-04-06T00:00:00.000Z', neq), true);
  assert.equal(matchWidgetDateFilter('2026-04-05T23:59:59.999Z', {
    operator: 'lte', value: '2026-04-05', valueType: 'date',
  }), false);
  assert.equal(matchWidgetDateFilter('2026-04-05T23:59:59.999Z', {
    operator: 'gt', value: '2026-04-05', valueType: 'date',
  }), true);
  assert.equal(matchWidgetDateFilter('2026-04-05T01:00:00+01:00', {
    operator: 'eq', value: '2026-04-05T00:00:00.000Z', valueType: 'date',
  }), true);
});

test('generic matcher preserves date context without changing text or numeric semantics', () => {
  assert.equal(matchFilter('2026-04-05T08:00:00Z', {
    operator: 'eq', value: '2026-04-05', valueType: 'date',
  }), false);
  assert.equal(matchFilter('05/04/2026', { operator: 'eq', value: '05/04/2026' }), true);
  assert.equal(matchFilter(10, { operator: 'gt', value: '2' }), true);
  assert.equal(matchFilter(['2026-04-05'], { operator: 'eq', value: '2026-04-05' }, null, true), true);
});

test('invalid date filters fail before aggregation or persistence', async () => {
  await assert.rejects(
    normalizeWidgetConfigDateFilters({
      source: 'event_booking',
      measure: { aggregator: 'count' },
      filters: [
        { fieldKind: 'system', field: 'created_at', operator: 'lte', value: '31/02/2026' },
      ],
    }, 'tenant'),
    /Filter 1: Enter a valid calendar date/,
  );
});