import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const read = (name) => readFileSync(`${here}${name}`, 'utf8');

test('list API carries form application level and validates the embedded tenant before pagination', () => {
  const source = read('list-submissions.js');
  assert.match(source, /form_submission:form_submission_id!inner/);
  assert.match(source, /\.eq\('form_submission\.tenant_id', tenantCtx\.tenantId\)/);
  assert.match(source, /\.eq\('form_submission\.form_id', formId\)/);
  assert.match(source, /MAX_LIMIT/);
  assert.match(source, /MAX_OFFSET/);
  assert.match(source, /application_level/);
  assert.match(source, /total: count \|\| 0/);
});

test('get API carries and validates form application level references', () => {
  const source = read('get-submission.js');
  assert.match(source, /form_submission:form_submission_id!inner/);
  assert.match(source, /\.eq\('form_submission\.tenant_id', tenantCtx\.tenantId\)/);
  assert.match(source, /due_diligence_required, application_level/);
  assert.match(source, /applicationLevel: form\?\.application_level/);
});
