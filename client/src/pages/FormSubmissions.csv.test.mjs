import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import moment from 'moment';
import * as relationships from '../lib/relationshipDisplayLabels.js';
import * as notListed from '../../../shared/formNotListedChoice.js';
import * as repeatable from '../../../shared/repeatableFormRowsFormat.js';
import { isRepeatableRowField, REPEATABLE_ROW_CHILD_TYPES } from '../../../shared/formRepeatableRows.js';
import { normalizeCustomFieldFileValue } from '../lib/customFieldFileValue.mjs';
import { formatScoreCsvAnswer } from '../lib/formSubmissionScoreCsv.js';
import { parseScoreAnswer } from '../../../api/_lib/surveyScoring.js';

// Run the ACTUAL page download handler, including selection, field resolution,
// CSV escaping and Blob creation. Only browser effects and page state are fake.
const source = readFileSync(new URL('./FormSubmissions.jsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  const handleExportCSV = () => {'), source.indexOf('\n  if (!accessChecked)', source.indexOf('  const handleExportCSV')));

async function download(fields, answers, overrides = {}) {
  let blob;
  let clicked = false;
  const context = {
    ...relationships, ...notListed, ...repeatable,
    isRepeatableRowField, normalizeCustomFieldFileValue, formatScoreCsvAnswer, moment,
    filteredSubmissions: answers.map(submission_data => ({ form_id: 'survey', submission_data })),
    formsById: { survey: { name: 'Synthetic feedback', fields } },
    exportFieldOptions: fields.map(f => ({ key: f.id, label: f.label || f.id })),
    selectedExportFields: fields.map(f => f.id),
    organisationNamesById: { org: 'Example organisation' },
    organisationGroupNamesById: { group: 'Example group' },
    memberNamesById: { member: 'Example member' },
    roleNamesById: { role: 'Example role' },
    resourceCategoryNamesById: { category: 'Example category' },
    communicationCategoryNamesById: { news: 'News' },
    relationshipLabelsByRecordId: { record: 'Example record' },
    customFieldDefById: { custom: { options: [{ value: 'a', label: 'Option A' }] } },
    resolveFormName: () => 'Synthetic feedback',
    getSubmitterEmail: s => s.submitted_by_email,
    selectedForm: 'survey', dateFrom: '', dateTo: '',
    window: { location: { origin: 'https://fixture.invalid' } },
    Blob, URL: { createObjectURL: value => { blob = value; return 'blob:fixture'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { clicked = true; } }) },
    setExportModalOpen() {}, toast: { success() {} },
    ...overrides,
  };
  new Function(...Object.keys(context), `${handler}\nhandleExportCSV();`)(...Object.values(context));
  assert.ok(clicked);
  return blob.text();
}

test('actual CSV download exports structured, missing and legacy scores without mutating persisted answers', async () => {
  const values = [{ score: 5 }, { score: 0 }, { na: true }, null, undefined, '', 4, 0, '3', '0', ' NA ', { score: '2' }];
  const answers = values.map(rating => ({ rating }));
  const before = structuredClone(answers);
  const csv = await download([{ id: 'rating', type: 'score' }], answers);
  assert.equal(csv, '"rating"\n"5"\n"0"\n"Not applicable"\n""\n""\n""\n"4"\n"0"\n"3"\n"0"\n"Not applicable"\n"2"');
  assert.deepEqual(answers, before);
  for (const value of values) {
    const parsed = parseScoreAnswer(value);
    assert.equal(formatScoreCsvAnswer(value), !parsed.answered ? '' : parsed.na ? 'Not applicable' : String(parsed.score));
  }
});

test('malformed scores never coerce to fabricated answers', async () => {
  const values = [true, false, [], [1], {}, { score: false }, { score: [] }, { score: {} }, ' ', { score: ' ' }, 'bad', 1.5, Infinity, NaN, { score: 'NA' }, { na: 'true' }];
  const csv = await download([{ id: 'rating', type: 'score' }], values.map(rating => ({ rating })));
  assert.equal(csv, ['"rating"', ...values.map(() => '""')].join('\n'));
});

test('actual CSV quoting, selected columns, input ordering and legacy field-name resolution', async () => {
  const fields = [{ id: 'rating', name: 'old_rating', type: 'score', label: 'Rating "overall"' }, { id: 'text', type: 'text' }, { id: 'omit', type: 'text' }];
  assert.equal(await download(fields, [
    { old_rating: { score: 0 }, text: 'Comma, "quote"\nnew line', omit: 'hidden' },
    { rating: { score: 5 }, text: 'second' },
  ], { selectedExportFields: ['text', 'rating'] }),
  '"Rating ""overall""","text"\n"0","Comma, ""quote""\nnew line"\n"5","second"');
});

test('actual CSV preserves specialised labels and repeatable/file formatting', async () => {
  const types = ['organisation_dropdown', 'organisation_group_dropdown', 'member_dropdown', 'role_dropdown', 'category_multiselect', 'communication_preferences', 'image_buttons', 'custom_field', 'relationship_dropdown', 'file'];
  const fields = types.map(type => ({ id: type, type, custom_field_id: 'custom', image_options: [{ value: 'a', label: 'Image A' }] }));
  fields.push({ id: 'rows', type: 'repeatable_rows', children: [
    { id: 'month', label: 'Month', type: 'date', date_precision: 'month' },
    { id: 'year', label: 'Year', type: 'date', date_precision: 'year' },
    { id: 'upload', label: 'Document', type: 'file' },
  ] });
  const file = { file_name: 'proof.pdf', bucket: 'private-uploads', storage_path: 'fixture/proof.pdf', is_private: true };
  const csv = await download(fields, [{
    organisation_dropdown: 'org', organisation_group_dropdown: 'group', member_dropdown: 'member',
    role_dropdown: 'role', category_multiselect: ['category'], communication_preferences: { news: true, other: false },
    image_buttons: 'a', custom_field: 'a', relationship_dropdown: 'record', file,
    rows: [{ month: '2026-03', year: '2026', upload: JSON.stringify(file) }],
  }]);
  assert.match(csv, /"Example organisation","Example group","Example member","Example role","Example category","News","Image A","Option A","Example record"/);
  assert.match(csv, /https:\/\/fixture.invalid\/api\/storage\/secure-url\?bucket=private-uploads&path=fixture%2Fproof.pdf&redirect=true/);
  assert.match(csv, /Row 1\nMonth: 2026-03\nYear: 2026\nDocument: proof.pdf/);
  assert.doesNotMatch(csv, /\[object Object\]|storage_path/);
  assert.equal(REPEATABLE_ROW_CHILD_TYPES.includes('score'), false);
});
