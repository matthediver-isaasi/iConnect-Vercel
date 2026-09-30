import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'init-submission.js'), 'utf8');

test('due-diligence initialization validates authoritative submission values before durable claim', () => {
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
  assert.match(source, /initializeFormDueDiligence\(\{/);

  const validation = source.indexOf('.validateSubmission({ form, submissionData: submissionValues })');
  const claim = source.indexOf('initializeFormDueDiligence({', validation);
  assert.ok(validation > -1 && claim > validation, 'relationship validation must complete before DD claim');
});
