import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => readFileSync(path.join(here, relativePath), 'utf8');

test('form builder creates, restores, edits, clears, and saves the full policy', () => {
  const source = read('../pages/FormBuilder.jsx');
  assert.match(source, /access_policy: null/);
  assert.match(source, /existingForm\.access_policy\?\.group_rules/);
  assert.match(source, /existingForm\.access_policy\?\.rbac_role_ids/);
  assert.match(source, /<FormAccessPolicyEditor/);
  assert.match(source, /group_rules: rules/);
  assert.match(source, /rbac_role_ids: selectedRoleIds/);
  assert.match(source, /operator: policy\?\.operator \|\| "or"/);
  assert.match(source, /onClick=\{\(\) => onChange\(null\)\}/);
  assert.match(source, /const \{ _ccCustomMode, _bccCustomMode, \.\.\.dataToSave \} = formData/);
});

test('standalone, embed, and iEdit surfaces gate rendering on server access outcomes', () => {
  for (const [relativePath, missingState] of [
    ['../pages/FormView.jsx', '  if (!form) {'],
    ['../pages/EmbedForm.jsx', '  if (error || !form) {'],
    ['../components/iedit/elements/IEditFormElement.jsx', '  if (!form) {'],
  ]) {
    const source = read(relativePath);
    assert.match(source, /resolveFormAccess\(accessPayload/);
    assert.match(source, /if \(formAccess\.restricted\)/);
    assert.match(source, /<FormAccessRestriction/);
    assert.ok(
      source.indexOf('if (formAccess.restricted)') < source.indexOf(missingState),
      `${relativePath} must render policy denial before generic not-found state`,
    );
  }
});

test('pretty form URLs preserve policy denials for the shared restricted state', () => {
  const source = read('../pages/DynamicPage.jsx');
  const fallbackStart = source.indexOf("queryKey: ['public-form-by-slug'");
  const fallbackEnd = source.indexOf('const formFallbackPending', fallbackStart);
  assert.notEqual(fallbackStart, -1);
  assert.notEqual(fallbackEnd, -1);
  const fallback = source.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /e\?\.errorData\?\.access/);
  assert.match(fallback, /return \{ __access: e\.errorData\.access \}/);
  assert.match(source, /<FormView slug=\{slug\} \/>/);
});

test('public form and mutation requests carry the session cookie', () => {
  const source = read('../api/publicClient.js');
  for (const method of [
    'getForm(',
    'listForms(',
    'getSurveyAssignment(',
    'submitForm(',
    'saveFormDraft(',
    'getFormDraft(',
  ]) {
    const methodIndex = source.indexOf(method);
    assert.notEqual(methodIndex, -1, `missing ${method}`);
    const nextMethod = source.indexOf('\n  async ', methodIndex + method.length);
    const body = source.slice(methodIndex, nextMethod === -1 ? source.length : nextMethod);
    assert.match(body, /credentials: 'include'/, `${method} must include credentials`);
  }
});