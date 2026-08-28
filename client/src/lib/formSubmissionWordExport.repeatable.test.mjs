import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubmissionToPrepared } from './formSubmissionWordExport.js';

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
        contacts: [{ organisation: '__form_not_listed__' }],
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
    ['Row 1', 'Organisation: Original organisation label'],
  );
});