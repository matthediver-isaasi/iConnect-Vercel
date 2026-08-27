import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'init-submission.js'), 'utf8');

test('due-diligence initialization validates authoritative submission values before insert', () => {
  assert.match(
    source,
    /\.from\('form_submission'\)[\s\S]*?\.select\('id, form_id, tenant_id, submission_data'\)[\s\S]*?\.eq\('tenant_id', tenantCtx\.tenantId\)/,
  );
  assert.match(
    source,
    /\.from\('form'\)[\s\S]*?\.select\('id, tenant_id, fields, due_diligence_required'\)[\s\S]*?\.eq\('tenant_id', tenantCtx\.tenantId\)/,
  );
  assert.match(source, /createFormRelationshipService\(\{/);
  assert.match(source, /validateSubmission\(\{ form, submissionData: submissionValues \}\)/);
  assert.doesNotMatch(source, /formSubmission\.form_values/);
  assert.match(source, /original_form_values: submissionValues/);
  assert.match(source, /reviewed_form_values: submissionValues/);

  const validation = source.indexOf('.validateSubmission({ form, submissionData: submissionValues })');
  const insert = source.indexOf(".from('form_submission_due_diligence')", validation);
  assert.ok(validation > -1 && insert > validation, 'relationship validation must complete before DD insertion');
});