import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'swap-execute.js'), 'utf8');

function assertOrdered(earlier, later, message) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later, earlierIndex);
  assert.notEqual(earlierIndex, -1, `missing ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing ${later}`);
  assert.ok(earlierIndex < laterIndex, message);
}

test('DD swaps validate mapped values against tenant-scoped saved target fields', () => {
  assert.match(
    source,
    /\.from\('form'\)[\s\S]*?\.select\('id, name, fields, due_diligence_required'\)[\s\S]*?\.eq\('tenant_id', tenantCtx\.tenantId\)[\s\S]*?\.in\('id', \[sourceFormId, targetFormId\]\)/,
  );
  assert.match(source, /const targetForm = forms\.find\(f => f\.id === targetFormId\)/);
  assert.match(source, /const targetFields = targetForm\.fields \|\| \[\]/);
  assert.match(
    source,
    /\.validateSubmission\(\{ form: targetForm, submissionData: newFormValues \}\)/,
  );
});

test('DD swap validation dominates both mapped answer-data writes', () => {
  assertOrdered(
    '.validateSubmission({ form: targetForm, submissionData: newFormValues })',
    "const newFormSubmission = {",
    'validation must precede the target form submission payload',
  );
  assertOrdered(
    '.validateSubmission({ form: targetForm, submissionData: newFormValues })',
    'const newDDRecord = {',
    'validation must precede the due-diligence answer payload',
  );
  assert.match(source, /submission_data: newFormValues/);
  assert.match(source, /original_form_values: newFormValues/);
  assert.match(source, /reviewed_form_values: newFormValues/);
});

test('DD swap relationship failures return only generic client errors', () => {
  assert.match(source, /error instanceof FormRelationshipError && error\.status < 500/);
  assert.match(source, /status\(400\)\.json\(\{ error: 'Invalid relationship selection' \}\)/);
  assert.match(source, /status\(500\)\.json\(\{ error: 'Failed to validate submission' \}\)/);
});