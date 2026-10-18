import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as relationships from '../lib/relationshipDisplayLabels.js';
import * as notListed from '../../../shared/formNotListedChoice.js';

// Exercise the actual dialog's field resolution/display expression and the
// existing export resolvers it shares, without loading authenticated live data.
const source = readFileSync(new URL('./FormSubmissions.jsx', import.meta.url), 'utf8');
const resolverStart = source.indexOf('  const buildExportResolvers = () => {');
const resolvers = source.slice(resolverStart, source.indexOf('  const buildAvailableFieldOptionsForSubmission', resolverStart));
const displayStart = source.indexOf('const field = resolveSubmissionField(viewingForm?.fields, key);');
const display = source.slice(displayStart, source.indexOf('                    return (', displayStart));
assert.ok(resolverStart >= 0 && displayStart >= 0, 'page resolver and detail expression must exist');
assert.match(source, /const detailValueResolvers = buildExportResolvers\(\);/);

function renderAnswer(field, value, overrides = {}) {
  const context = {
    ...relationships,
    ...notListed,
    organisationNamesById: { org: 'Example organisation' },
    organisationGroupNamesById: { group: 'Example group' },
    communicationCategoryNamesById: { news: 'News', events: 'Events' },
    customFieldDefById: { custom: { options: [
      { value: 'a', label: 'Option A' },
      { value: 'b', label: 'Option B' },
      { label: 'Legacy label' },
      { value: 0, label: 'Zero option' },
    ] } },
    relationshipLabelsByRecordId: {},
    memberNamesById: {}, roleNamesById: {}, resourceCategoryNamesById: {},
    resolveFormName() {}, getSubmitterEmail() {},
    viewingForm: { fields: [field] },
    viewingSubmission: { submission_data: { answer: value } },
    key: 'answer',
    value,
    ...overrides,
  };
  return new Function(...Object.keys(context), `
    ${resolvers}
    const detailValueResolvers = buildExportResolvers();
    ${display}
    return displayValue;
  `)(...Object.values(context));
}

const field = (type, extra = {}) => ({ id: 'answer', type, ...extra });
const imageField = field('image_buttons', { image_options: [
  { value: 'a', label: 'Image A' }, { value: 'b', label: 'Image B' },
] });
const customField = field('custom_field', { custom_field_id: 'custom' });

test('detail viewer resolves organisation scalar and multi-select answers with missing-ID fallback', () => {
  assert.equal(renderAnswer(field('organisation_dropdown'), 'org'), 'Example organisation');
  assert.equal(renderAnswer(field('organisation_dropdown'), ['org', 'deleted-org']), 'Example organisation, deleted-org');
  assert.equal(renderAnswer(field('organisation_dropdown'), 'deleted-org'), 'deleted-org');
});

test('communication preferences show subscribed category names and retain deleted category IDs', () => {
  const value = { news: true, events: false, deleted: true, legacy: 'true' };
  const before = structuredClone(value);
  assert.equal(renderAnswer(field('communication_preferences'), value), 'News, deleted');
  assert.equal(renderAnswer(field('communication_preferences'), { news: false }), '');
  assert.equal(renderAnswer(field('communication_preferences'), 'legacy-value'), 'legacy-value');
  assert.deepEqual(value, before);
});

test('image buttons resolve single and multiple labels, retaining unknown values', () => {
  assert.equal(renderAnswer(imageField, 'a'), 'Image A');
  assert.equal(renderAnswer(imageField, ['b', 'removed']), 'Image B, removed');
  assert.equal(renderAnswer(field('image_buttons'), 'removed'), 'removed');
});

test('custom fields resolve options, multi-selects, legacy label-only options and missing definitions', () => {
  assert.equal(renderAnswer(customField, 'a'), 'Option A');
  assert.equal(renderAnswer(customField, ['b', 'removed', 'Legacy label']), 'Option B, removed, Legacy label');
  assert.equal(renderAnswer(customField, 0), 'Zero option');
  assert.equal(renderAnswer(customField, ['a', 'removed'], { customFieldDefById: {} }), 'a, removed');
  assert.equal(renderAnswer(customField, true), 'Yes');
  assert.equal(renderAnswer(customField, false), 'No');
  assert.equal(renderAnswer(customField, 'Free text'), 'Free text');
});

test('empty answers stay empty and delayed lookup results can resolve without changing the answer', () => {
  for (const definition of [field('organisation_dropdown'), field('communication_preferences'), imageField, customField]) {
    for (const value of [null, undefined, '', []]) {
      assert.equal(renderAnswer(definition, value), '');
    }
  }
  assert.equal(renderAnswer(field('organisation_dropdown'), 'org', { organisationNamesById: {} }), 'org');
  assert.equal(renderAnswer(field('organisation_dropdown'), 'org'), 'Example organisation');
});

test('legacy field names and existing not-listed, group and ordinary answer behavior are preserved', () => {
  assert.equal(renderAnswer({ id: 'new-id', name: 'answer', type: 'organisation_dropdown' }, 'org'), 'Example organisation');
  const definition = field('organisation_dropdown', { not_listed_enabled: true });
  const value = notListed.FORM_NOT_LISTED_VALUE;
  const submission_data = { answer: value, [notListed.FORM_NOT_LISTED_TEXT_KEY]: { answer: 'Other organisation' } };
  assert.equal(renderAnswer(definition, value, { viewingSubmission: { submission_data } }),
    notListed.resolveFormNotListedDisplayValue(definition, value, submission_data));
  assert.equal(renderAnswer(field('organisation_group_dropdown'), 'group'), 'Example group');
  assert.equal(renderAnswer(field('text'), 'Original text'), 'Original text');
  assert.equal(renderAnswer(field('checkbox'), ['A', 'B']), 'A, B');
});
