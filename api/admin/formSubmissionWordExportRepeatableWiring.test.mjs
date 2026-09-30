import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSubmissionToPrepared } from '../../client/src/lib/formSubmissionWordExport.js';

const syncSource = readFileSync(new URL('./form-submissions-word-export.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('./form-submission-export-jobs/process.js', import.meta.url), 'utf8');

test('synchronous and background DOCX exports discover nested lookup children and use canonical organization table', () => {
  for (const source of [syncSource, backgroundSource]) {
    assert.match(source, /getRepeatableRowChildren\(parentField\)/);
    assert.match(source, /collectRepeatableRelationshipRecordIds\(/);
    assert.match(source, /\.from\('organization'\)\.select\('id, name'\)/);
    assert.match(source, /organisationNamesById,/);
  }
});

test('DOCX resolver behavior formats nested organisation and relationship labels without IDs', () => {
  const form = {
    id: 'form-1',
    fields: [{
      id: 'rows',
      type: 'repeatable_row',
      repeatable_row: { child_fields: [
        { id: 'organisation', label: 'Organisation', type: 'organisation_dropdown' },
        { id: 'relationship', label: 'Department', type: 'relationship_dropdown' },
      ] },
    }],
  };
  const prepared = resolveSubmissionToPrepared({
    submission: { form_id: 'form-1', submission_data: { rows: [{ _row_id: 'row-1', organisation: 'org-id', relationship: 'rel-id' }] } },
    form,
    selectedOptions: [{ key: 'rows', label: 'Rows' }],
    resolvers: {
      organisationNamesById: { 'org-id': 'Example Organisation' },
      resolveRelationshipLabel: () => 'Example Department',
    },
  });
  const text = prepared.rows[0].lines.map((line) => line.text).join('\n');
  assert.match(text, /Example Organisation/);
  assert.match(text, /Example Department/);
  assert.equal(text.includes('org-id'), false);
  assert.equal(text.includes('rel-id'), false);
});