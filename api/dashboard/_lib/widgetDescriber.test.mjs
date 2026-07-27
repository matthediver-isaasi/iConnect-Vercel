import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWidgetConfig } from './widgetDescriber.js';

const labels = {
  'system:country': 'Country',
  'system:region': 'Region',
  'system:created_at': 'Created at',
  'custom:field-1': 'Countries of Operation',
  'custom:field-2': 'Children Impacted (Direct)',
  'custom:field-3': 'Children Impacted (Indirect)',
  'custom:field-4': 'Organisation Status',
};

function fieldLabel(ref) {
  if (!ref) return null;
  const kind = ref.fieldKind || ref.kind;
  const key = kind === 'custom' ? `custom:${ref.fieldId}` : `system:${ref.field}`;
  return labels[key] || null;
}

const OPTS = { sourceLabel: 'Organisations', fieldLabel };

test('plain count stat', () => {
  const text = describeWidgetConfig(
    { source: 'organization', measure: { aggregator: 'count' }, filters: [] },
    { ...OPTS, widgetType: 'stat' },
  );
  assert.equal(text, 'Counts organisations.');
});

test('count grouped by a countries custom field explains per-country counting', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      groupBy: { kind: 'custom', fieldId: 'field-1' },
      filters: [],
    },
    { ...OPTS, widgetType: 'bar' },
  );
  assert.match(text, /^Counts organisations\./);
  assert.match(text, /broken down by countries of Operation/i);
  assert.match(text, /counted once under each of its countries/);
});

test('LMIC filter wording', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      filters: [
        { fieldKind: 'custom', fieldId: 'field-1', operator: 'lmic' },
      ],
    },
    OPTS,
  );
  assert.match(text, /Only includes records where Countries of Operation is on this site's LMIC/);
});

test('NOT-LMIC filter explains unrecognised values excluded from both', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      filters: [
        { fieldKind: 'custom', fieldId: 'field-1', operator: 'not_lmic' },
      ],
    },
    OPTS,
  );
  assert.match(text, /is NOT on this site's LMIC list/);
  assert.match(text, /left out of both/);
});

test('region group-by explains one-bucket-per-org and Multi-region', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      groupBy: { kind: 'system', field: 'region' },
      filters: [],
    },
    { ...OPTS, widgetType: 'pie' },
  );
  assert.match(text, /grouped by world regions/);
  assert.match(text, /ONE region bucket/);
  assert.match(text, /Multi-region/);
  assert.match(text, /Unknown/);
});

test('region group-by names the World Bank scheme', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      groupBy: { kind: 'system', field: 'region', regionScheme: 'world_bank' },
      filters: [],
    },
    OPTS,
  );
  assert.match(text, /World Bank regions/);
});

test('sum with additional fields lists all fields', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: {
        aggregator: 'sum',
        fieldKind: 'custom',
        fieldId: 'field-2',
        additionalFields: [{ fieldKind: 'custom', fieldId: 'field-3' }],
      },
      filters: [],
    },
    OPTS,
  );
  assert.match(text, /Adds up Children Impacted \(Direct\) plus Children Impacted \(Indirect\) across organisations\./);
});

test('count_distinct wording', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count_distinct', fieldKind: 'system', field: 'country' },
      filters: [],
    },
    OPTS,
  );
  assert.match(text, /how many different values of Country/);
});

test('time bucket with cumulative flag', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      timeBucket: { field: 'created_at', granularity: 'month' },
      cumulative: true,
      filters: [],
    },
    { ...OPTS, widgetType: 'line' },
  );
  assert.match(text, /over time by month/);
  assert.match(text, /based on created at/i);
  assert.match(text, /running total/);
});

test('eq and in filters with values', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'count' },
      filters: [
        { fieldKind: 'custom', fieldId: 'field-4', operator: 'eq', value: 'Active' },
        { fieldKind: 'system', field: 'country', operator: 'in', value: ['India', 'Kenya'] },
      ],
    },
    OPTS,
  );
  assert.match(text, /Organisation Status is "Active"/);
  assert.match(text, /Country is one of "India", "Kenya"/);
  assert.match(text, /, and /);
});

test('DD transition modes', () => {
  const single = describeWidgetConfig(
    {
      source: 'dd_submission',
      measure: { aggregator: 'count' },
      transition: { mode: 'single', fromStage: 'New', toStage: 'Verified' },
      filters: [],
    },
    { sourceLabel: 'Due Diligence Submissions', fieldLabel },
  );
  assert.match(single, /moved from "New" to "Verified"/);

  const breakdown = describeWidgetConfig(
    {
      source: 'dd_submission',
      measure: { aggregator: 'count' },
      transition: { mode: 'breakdown' },
      filters: [],
    },
    { sourceLabel: 'Due Diligence Submissions', fieldLabel },
  );
  assert.match(breakdown, /one bar for each "from → to" move/);
});

test('form conversion wording', () => {
  const text = describeWidgetConfig(
    {
      source: 'form_conversion',
      measure: { aggregator: 'count' },
      conversion: { sourceFormId: 'a', targetFormIds: ['b'], matchBy: 'organization' },
      filters: [],
    },
    { sourceLabel: 'Form conversion', fieldLabel },
  );
  assert.match(text, /organisations that submitted the source form/);
  assert.match(text, /conversion rate/);
});

test('unknown field falls back to humanised name; empty config returns empty', () => {
  const text = describeWidgetConfig(
    {
      source: 'organization',
      measure: { aggregator: 'sum', fieldKind: 'system', field: 'training_fund_balance' },
      filters: [],
    },
    { sourceLabel: 'Organisations', fieldLabel: () => null },
  );
  assert.match(text, /training fund balance/);
  assert.equal(describeWidgetConfig(null, OPTS), '');
});
