import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubmissionToPrepared } from './formSubmissionWordExport.js';

test('Word export discovers nested files without persisting or serializing signed URLs', () => {
  const field = {
    id: 'documents', type: 'repeatable_rows', label: 'Documents',
    children: [{ id: 'purpose', type: 'text', label: 'Purpose' }, { id: 'upload', type: 'file', label: 'Evidence' }],
  };
  const metadata = {
    file_name: 'evidence.pdf', file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant%2Fevidence.pdf',
    bucket: 'private-uploads', storage_path: 'tenant/evidence.pdf', is_private: true,
  };
  const submission = {
    submission_data: { documents: [{ _row_id: 'first', purpose: 'A', upload: JSON.stringify(metadata) },
      { _row_id: 'second', purpose: 'B', upload: metadata }] },
  };
  const prepared = resolveSubmissionToPrepared({
    submission, form: { fields: [field] },
    selectedOptions: [{ key: 'documents', label: 'Documents' }],
    resolvers: {
      resolveFile: raw => {
        const file = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          name: file.file_name,
          url: `https://example.test/api/storage/secure-url?bucket=${encodeURIComponent(file.bucket)}&path=${encodeURIComponent(file.storage_path)}&redirect=true`,
        };
      },
    },
  });
  assert.deepEqual(prepared.supportingDocs[0].files.map(file => file.name), [
    'Row 1 — Evidence: evidence.pdf', 'Row 2 — Evidence: evidence.pdf',
  ]);
  assert.ok(prepared.supportingDocs[0].files.every(file => (
    file.url === 'https://example.test/api/storage/secure-url?bucket=private-uploads&path=tenant%2Fevidence.pdf&redirect=true'
  )));
  assert.equal(JSON.stringify(prepared).includes('signedUrl'), false);
  assert.match(prepared.rows[0].lines.map(line => line.text).join('\n'), /Evidence: evidence.pdf/);
  assert.deepEqual(submission.submission_data.documents[1].upload, metadata);
});

test('Word export prepares repeatable rows as labelled lines with resolved relationships', () => {
  const form = {
    id: 'form-1',
    fields: [{
      id: 'contacts',
      label: 'Contacts',
      type: 'repeatable_row',
      repeatable_row: {
        child_fields: [
          { id: 'name', label: 'Name', type: 'text' },
          { id: 'organisation', label: 'Organisation', type: 'organisation_dropdown' },
          { id: 'team', label: 'Team', type: 'relationship_dropdown' },
        ],
      },
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: {
      id: 'submission-1',
      form_id: 'form-1',
      submission_data: {
        contacts: [{ _row_id: 'row-id', name: 'Ada', organisation: 'org-1', team: 'team-id' }],
      },
    },
    form,
    selectedOptions: [{ key: 'contacts', label: 'Contacts' }],
    resolvers: {
      resolveRelationshipLabel: (value) => value === 'team-id' ? 'Engineering' : 'Unavailable record',
      organisationNamesById: { 'org-1': 'Analytical Engines' },
    },
  });
  assert.deepEqual(
    prepared.rows[0].lines.map((line) => line.text),
    ['Row 1', 'Name: Ada', 'Organisation: Analytical Engines', 'Team: Engineering'],
  );
  assert.equal(JSON.stringify(prepared).includes('row-id'), false);
  assert.equal(JSON.stringify(prepared).includes('team-id'), false);
  assert.equal(JSON.stringify(prepared).includes('org-1'), false);
});

test('Word export preserves partial repeatable dates without full-date coercion', () => {
  const form = {
    fields: [{
      id: 'periods',
      label: 'Periods',
      type: 'repeatable_row',
      children: [
        { id: 'month', label: 'Month', type: 'date', date_precision: 'month' },
        { id: 'year', label: 'Year', type: 'date', date_precision: 'year' },
      ],
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: {
      submission_data: {
        periods: [{ month: '2026-03', year: '2026' }],
      },
    },
    form,
    selectedOptions: [{ key: 'periods', label: 'Periods' }],
    resolvers: {},
  });
  assert.deepEqual(
    prepared.rows[0].lines.map(line => line.text),
    ['Row 1', 'Month: 2026-03', 'Year: 2026'],
  );
});

test('Word export retains the submitted repeatable not-listed label', () => {
  const form = {
    fields: [{
      id: 'contacts',
      label: 'Contacts',
      type: 'repeatable_row',
      children: [{
        id: 'organisation',
        label: 'Organisation',
        type: 'organisation_dropdown',
        not_listed_choice: { enabled: false, label: 'Renamed label' },
      }],
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: {
      submission_data: {
        contacts: [{
          organisation: '__form_not_listed__',
          __not_listed_choice_text: { organisation: 'Independent organisation' },
        }],
        __not_listed_choice_labels: {
          contacts: { organisation: 'Original organisation label' },
        },
      },
    },
    form,
    selectedOptions: [{ key: 'contacts', label: 'Contacts' }],
    resolvers: { organisationNamesById: {} },
  });
  assert.deepEqual(
    prepared.rows[0].lines.map(line => line.text),
    ['Row 1', 'Organisation: Original organisation label — Independent organisation'],
  );
});

test('Word export resolves repeatable relationship labels alongside inclusive Other text', () => {
  const form = {
    fields: [{
      id: 'contacts',
      label: 'Contacts',
      type: 'repeatable_row',
      children: [{
        id: 'department',
        label: 'Department',
        type: 'relationship_dropdown',
        selection_mode: 'multiple',
        not_listed_choice: { enabled: true, label: 'Other department' },
      }],
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: {
      submission_data: {
        contacts: [{
          department: ['department-1', '__form_not_listed__'],
          __not_listed_choice_text: { department: 'Research partnerships' },
        }],
      },
    },
    form,
    selectedOptions: [{ key: 'contacts', label: 'Contacts' }],
    resolvers: {
      resolveRelationshipLabel: value => value === 'department-1' ? 'Finance' : 'Unavailable record',
    },
  });
  assert.deepEqual(
    prepared.rows[0].lines.map(line => line.text),
    ['Row 1', 'Department: Finance, Other department — Research partnerships'],
  );
});

test('Word export uses the relationship fallback when a custom label resolver has no label', () => {
  const form = {
    fields: [{
      id: 'department',
      label: 'Department',
      type: 'relationship_dropdown',
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: {
      submission_data: { department: 'missing-department' },
    },
    form,
    selectedOptions: [{ key: 'department', label: 'Department' }],
    resolvers: {
      resolveRelationshipLabel: () => undefined,
    },
  });
  assert.deepEqual(prepared.rows[0].lines, [{
    kind: 'text',
    text: 'Unavailable record',
  }]);
});