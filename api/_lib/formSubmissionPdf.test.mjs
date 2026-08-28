// Tests for the shared form-submission PDF builder (Task #3312).
// jsPDF writes uncompressed content streams by default, so rendered text is
// searchable in the raw PDF bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFormSubmissionPdf,
  formatFormSubmissionFieldValue,
  loadFormSubmissionRelationshipLabels,
} from './formSubmissionPdf.js';

const FIELDS = [
  { id: 'name', label: 'Full name', type: 'text' },
  { id: 'skills', label: 'Skills', type: 'multiselect' },
  { id: 'agree', label: 'Agree to terms', type: 'boolean' },
  { id: 'contact', label: 'Contact details', type: 'contact' },
  { id: 'cv', label: 'CV upload', type: 'file_upload' },
  { id: 'note', label: 'Heading', type: 'heading' },
];

const DATA = {
  name: 'Ada Lovelace',
  skills: ['Maths', 'Programming'],
  agree: true,
  contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
  cv: { name: 'ada-cv.pdf' },
};

test('builds a PDF buffer with rendered labels and values', () => {
  const buf = buildFormSubmissionPdf({
    title: 'Treasurer application',
    dateLabel: 'Submitted: 1 May 2026',
    fields: FIELDS,
    submissionData: DATA,
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const text = buf.toString('latin1');
  assert.ok(text.includes('Treasurer application'));
  assert.ok(text.includes('Submitted: 1 May 2026'));
  assert.ok(text.includes('Full name'));
  assert.ok(text.includes('Ada Lovelace'));
  assert.ok(text.includes('Maths, Programming'));
  assert.ok(text.includes('Yes'));
  assert.ok(text.includes('[Uploaded: ada-cv.pdf]'));
  // heading fields are skipped
  assert.ok(!text.includes('Heading'));
});

test('renders placeholders for missing values and sanitises non-WinAnsi text', () => {
  const buf = buildFormSubmissionPdf({
    title: 'Vacancy \u2014 Chair',
    fields: [
      { id: 'a', label: 'Answer', type: 'text' },
      { id: 'f', label: 'File', type: 'file' },
    ],
    submissionData: { f: null },
  });
  const text = buf.toString('latin1');
  // em dash normalised to '-'
  assert.ok(text.includes('Vacancy - Chair'));
  assert.ok(text.includes('[No file uploaded]'));
});

test('relationship formatter handles current, legacy, and unavailable records without leaking IDs', () => {
  const currentField = { id: 'relationship-id', name: 'relationship_name', type: 'relationship_dropdown' };
  assert.equal(
    formatFormSubmissionFieldValue(currentField, 'record-1', { 'record-1': 'Current record' }),
    'Current record',
  );
  assert.equal(
    formatFormSubmissionFieldValue(currentField, 'missing-uuid', {}),
    'Unavailable record',
  );

  const legacyField = { name: 'legacy_relationship', type: 'relationship_dropdown' };
  assert.equal(
    formatFormSubmissionFieldValue(
      legacyField,
      ['record-1', 'inactive-uuid'],
      new Map([['record-1', 'Legacy record']]),
    ),
    'Legacy record, Unavailable record',
  );
});

test('PDF formatter uses the snapshotted not-listed label after the field is renamed and disabled', () => {
  const field = {
    id: 'org',
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: false, label: 'Renamed label' },
  };
  assert.equal(
    formatFormSubmissionFieldValue(
      field,
      '__form_not_listed__',
      {},
      { __not_listed_choice_labels: { org: 'Original label' } },
    ),
    'Original label',
  );
});

test('PDF formatter resolves organisation group IDs without exposing unavailable UUIDs', () => {
  const field = { id: 'group', type: 'organisation_group_dropdown' };
  assert.equal(
    formatFormSubmissionFieldValue(field, 'group-1', {}, {}, {}, { 'group-1': 'Northern Group' }),
    'Northern Group',
  );
  assert.equal(
    formatFormSubmissionFieldValue(field, 'forged-group', {}, {}, {}),
    'Unavailable organisation group',
  );
});

test('PDF formatter renders repeatable rows with child labels and relationship display labels', () => {
  const field = {
    id: 'teams',
    type: 'repeatable_row',
    repeatable_row: {
      child_fields: [
        { id: 'name', label: 'Team name', type: 'text' },
        { id: 'organisation', label: 'Organisation', type: 'organisation_dropdown' },
        { id: 'lead', label: 'Team lead', type: 'relationship_dropdown' },
      ],
    },
  };
  const output = formatFormSubmissionFieldValue(
    field,
    [{ _row_id: 'row-secret', name: 'Platform', organisation: 'org-1', lead: 'record-1' }],
    { 'record-1': 'Ada Lovelace' },
    {},
    { 'org-1': 'Babbage Ltd' },
  );
  assert.equal(output, 'Row 1\nTeam name: Platform\nOrganisation: Babbage Ltd\nTeam lead: Ada Lovelace');
  assert.equal(output.includes('row-secret'), false);
  assert.equal(output.includes('record-1'), false);
  assert.equal(output.includes('org-1'), false);
});

test('PDF builder uses ID-first/name fallback and renders no relationship UUIDs', () => {
  const currentId = '11111111-1111-4111-8111-111111111111';
  const ignoredLegacyId = '22222222-2222-4222-8222-222222222222';
  const missingId = '33333333-3333-4333-8333-333333333333';
  const pdf = buildFormSubmissionPdf({
    title: 'Relationship answers',
    fields: [
      { id: 'current', name: 'old_current', label: 'Current', type: 'relationship_dropdown' },
      { name: 'legacy', label: 'Legacy', type: 'relationship_dropdown' },
      { id: 'missing', label: 'Missing', type: 'relationship_dropdown' },
    ],
    submissionData: {
      current: currentId,
      old_current: ignoredLegacyId,
      legacy: currentId,
      missing: missingId,
    },
    relationshipLabelsByRecordId: { [currentId]: 'Scoped record' },
  }).toString('latin1');

  assert.ok(pdf.includes('Scoped record'));
  assert.ok(pdf.includes('Unavailable record'));
  assert.ok(!pdf.includes(currentId));
  assert.ok(!pdf.includes(ignoredLegacyId));
  assert.ok(!pdf.includes(missingId));
});

test('scoped label loader uses only saved relationship fields and ID-first values', async () => {
  const requestedIds = [];
  const db = {
    from(table) {
      let selectedIds = [];
      const query = {
        select() { return query; },
        eq() { return query; },
        is() { return query; },
        in(_column, ids) {
          selectedIds = ids;
          if (table === 'custom_object_record') requestedIds.push(...ids);
          return query;
        },
        then(resolve, reject) {
          const data = table === 'custom_object_record'
            ? selectedIds.map((id) => ({ id, custom_object_id: 'object-1', data: { primary: 'Safe label' } }))
            : table === 'custom_object_definition'
              ? [{ id: 'object-1', primary_display_field_id: 'primary' }]
              : [{ id: 'primary', custom_object_id: 'object-1', name: 'primary', field_type: 'text', is_active: true }];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };

  const labels = await loadFormSubmissionRelationshipLabels({
    db,
    tenantId: 'tenant-1',
    fields: [{ id: 'current', name: 'legacy', type: 'relationship_dropdown' }],
    submissionData: {
      current: 'authoritative-record',
      legacy: 'must-not-win',
      unrelated: 'arbitrary-uuid',
    },
  });

  assert.deepEqual(requestedIds, ['authoritative-record']);
  assert.deepEqual(labels, { 'authoritative-record': 'Safe label' });
});

test('contract and vacancy PDF paths explicitly supply tenant-scoped labels', () => {
  const contract = readFileSync(new URL('../contracts/generate-pdf.js', import.meta.url), 'utf8');
  const vacancy = readFileSync(new URL('../member-groups/vacancy-application-pdf.js', import.meta.url), 'utf8');

  for (const source of [contract, vacancy]) {
    assert.match(source, /loadFormSubmissionRelationshipLabels\(\{\s*db: supabase,\s*tenantId,\s*fields,\s*submissionData,/s);
    assert.match(source, /buildFormSubmissionPdf\(\{[\s\S]*relationshipLabelsByRecordId,/);
  }
});
