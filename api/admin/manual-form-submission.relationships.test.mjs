import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'manual-form-submission.js'), 'utf8');

test('manual submissions enforce relationship and Organisation Group validation before persistence', () => {
  const repeatableIndex = source.indexOf('await validateRepeatableRowSubmission({');
  const relationshipIndex = source.indexOf(
    'await createFormRelationshipService({ db: supabase, tenantId }).validateSubmission({',
  );
  const groupIndex = source.indexOf('await validateFormOrganisationGroupAnswers({');
  const dependentIndex = source.indexOf(
    'await validateOrganisationGroupDependentOrganizationAnswers({',
  );
  const insertIndex = source.indexOf(".from('form_submission')");

  assert.ok(repeatableIndex >= 0);
  assert.ok(relationshipIndex > repeatableIndex);
  assert.ok(groupIndex > relationshipIndex);
  assert.ok(dependentIndex > groupIndex);
  assert.ok(insertIndex > dependentIndex);
});