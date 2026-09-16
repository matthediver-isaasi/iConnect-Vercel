import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const read = (name) => readFileSync(`${here}${name}`, 'utf8');

test('DD submission projections use existing persisted member-reference columns', () => {
  for (const file of ['list-submissions.js', 'get-submission.js']) {
    const embedded = read(file).match(/form_submission:form_submission_id!inner\(([^)]+)\)/);
    assert.ok(embedded, `${file} must select its submission`);
    const columns = embedded[1].split(',').map(column => column.trim());
    assert.ok(columns.includes('created_member_id'));
    assert.ok(!columns.includes('member_id'), `${file}: form_submission has no member_id column`);
  }
  const stageProjection = read('_stageActions.js').match(
    /\.from\('form_submission'\)\s*\.select\('([^']*created_member_id[^']*)'\)/,
  );
  assert.ok(stageProjection);
  assert.ok(!stageProjection[1].split(',').map(column => column.trim()).includes('member_id'));
});

test('DD member-name lookup uses first_name and last_name, not a nonexistent full_name column', () => {
  const projection = read('submissionReferences.js').match(/\.from\('member'\)\s*\.select\('([^']+)'\)/);
  assert.ok(projection);
  const columns = projection[1].split(',').map(column => column.trim());
  assert.ok(columns.includes('first_name') && columns.includes('last_name'));
  assert.ok(!columns.includes('full_name'));
});

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
