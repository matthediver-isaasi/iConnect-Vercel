import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_FORM_HELPER_MESSAGE,
  isProtectedDepartmentForm,
} from '../../../../shared/protectedDepartmentForm.js';
import {
  protectedFormUpdateHeaders,
  verifyProtectedFormPassword,
} from '../../lib/protectedFormActions.js';

const [dialogSource, builderSource, managementSource, formViewSource, clientSource, actionsSource] = await Promise.all([
  readFile(new URL('./ProtectedFormActionDialog.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../../pages/FormBuilder.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../../pages/FormManagement.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../../pages/FormView.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../../api/base44Client.js', import.meta.url), 'utf8'),
  readFile(new URL('../../lib/protectedFormActions.js', import.meta.url), 'utf8'),
]);

test('protected Department form identity is narrow and helper copy remains exact', () => {
  assert.equal(isProtectedDepartmentForm(PROTECTED_DEPARTMENT_FORM_ID), true);
  assert.equal(isProtectedDepartmentForm({ id: PROTECTED_DEPARTMENT_FORM_ID }), true);
  assert.equal(isProtectedDepartmentForm('00000000-0000-4000-8000-000000000000'), false);
  assert.equal(
    PROTECTED_FORM_HELPER_MESSAGE,
    'This form is protected and cannot be deleted, contact isaasi for details.',
  );
});

test('protected save and deactivation UI use ephemeral password headers and explicit confirmation', () => {
  assert.match(dialogSource, /type="password"/);
  assert.match(dialogSource, /autoComplete="off"/);
  assert.match(dialogSource, /verifyProtectedFormPassword/);
  assert.match(actionsSource, /verify-protection-password/);
  assert.match(dialogSource, /setPassword\(''\)/);
  assert.match(dialogSource, /Confirm Deactivate Form/);
  assert.match(dialogSource, /will not be deleted/);
  assert.match(builderSource, /isProtectedDepartmentForm\(formId\)/);
  assert.deepEqual(protectedFormUpdateHeaders('test-only-password'), {
    'X-Form-Protection-Password': 'test-only-password',
  });
  assert.deepEqual(protectedFormUpdateHeaders('test-only-password', { deactivation: true }), {
    'X-Form-Protection-Password': 'test-only-password',
    'X-Form-Deactivation-Confirmed': 'true',
  });
  assert.match(builderSource, /protectedFormUpdateHeaders\(password/);
  assert.match(clientSource, /async update\(id, data, options = \{\}\)/);
});

test('deactivation password verification is tenant/form scoped and surfaces rejection', async () => {
  let request;
  await verifyProtectedFormPassword({
    formId: PROTECTED_DEPARTMENT_FORM_ID,
    password: 'test-only-password',
    tenantId: 'test-tenant',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ success: true }) };
    },
  });
  assert.equal(request.url, '/api/forms/verify-protection-password');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.headers['X-Tenant-Id'], 'test-tenant');
  assert.deepEqual(JSON.parse(request.options.body), {
    form_id: PROTECTED_DEPARTMENT_FORM_ID,
    password: 'test-only-password',
  });

  await assert.rejects(
    verifyProtectedFormPassword({
      formId: PROTECTED_DEPARTMENT_FORM_ID,
      password: 'wrong-test-password',
      fetchImpl: async () => ({
        ok: false,
        json: async () => ({ error: 'Incorrect protection password.' }),
      }),
    }),
    /Incorrect protection password/,
  );
});

test('management replaces protected deletion with the deactivation flow', () => {
  assert.match(managementSource, /PROTECTED_FORM_HELPER_MESSAGE/);
  assert.match(managementSource, /Deactivate Form/);
  assert.match(managementSource, /if \(isProtectedDepartmentForm\(deletingForm\)\)/);
  assert.match(managementSource, /setDeactivatingProtectedForm\(deletingForm\)/);
  assert.match(managementSource, /protectedFormUpdateHeaders\(password, \{ deactivation: true \}\)/);
});

test('respondent success does not attempt a protected form counter PATCH', () => {
  assert.match(
    formViewSource,
    /if \(form && !isProtectedDepartmentForm\(form\)\) \{/,
  );
});