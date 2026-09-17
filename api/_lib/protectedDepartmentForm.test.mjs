import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTECTED_DEPARTMENT_FORM_ID,
  PROTECTED_DEPARTMENT_TENANT_ID,
  PROTECTED_FORM_HELPER_MESSAGE,
  authorizeProtectedFormMutation,
  isProtectedDepartmentForm,
  verifyProtectedFormPassword,
} from './protectedDepartmentForm.js';

const env = { BNMS_DEPT_SURVEY_SECRET: 'correct horse battery staple' };
const base = {
  formId: PROTECTED_DEPARTMENT_FORM_ID,
  tenantId: PROTECTED_DEPARTMENT_TENANT_ID,
  method: 'PATCH',
  body: { name: 'Changed' },
  env,
};

test('protected identity is ID-based and normalized', () => {
  assert.equal(isProtectedDepartmentForm(PROTECTED_DEPARTMENT_FORM_ID.toUpperCase()), true);
  assert.equal(isProtectedDepartmentForm({ id: PROTECTED_DEPARTMENT_FORM_ID }), true);
  assert.equal(isProtectedDepartmentForm('another-form'), false);
});

test('password check fails closed and accepts only the environment secret', () => {
  assert.equal(verifyProtectedFormPassword('correct horse battery staple', env), true);
  assert.equal(verifyProtectedFormPassword('wrong', env), false);
  assert.equal(verifyProtectedFormPassword('anything', {}), false);
});

test('missing and wrong passwords reject before mutation', () => {
  assert.equal(authorizeProtectedFormMutation({ ...base }).code, 'PROTECTED_FORM_PASSWORD_INCORRECT');
  assert.equal(authorizeProtectedFormMutation({ ...base, password: 'wrong' }).code, 'PROTECTED_FORM_PASSWORD_INCORRECT');
  assert.equal(authorizeProtectedFormMutation({ ...base, password: 'correct horse battery staple' }).ok, true);
});

test('missing environment secret fails closed', () => {
  const result = authorizeProtectedFormMutation({ ...base, password: 'anything', env: {} });
  assert.equal(result.status, 503);
  assert.equal(result.code, 'PROTECTED_FORM_SECRET_NOT_CONFIGURED');
});

test('deactivation requires password and explicit final confirmation', () => {
  const pending = authorizeProtectedFormMutation({
    ...base,
    body: { is_active: false },
    password: 'correct horse battery staple',
  });
  assert.equal(pending.code, 'PROTECTED_FORM_DEACTIVATION_CONFIRMATION_REQUIRED');
  assert.equal(authorizeProtectedFormMutation({
    ...base,
    body: { is_active: false },
    password: 'correct horse battery staple',
    deactivationConfirmed: 'true',
  }).ok, true);
});

test('permanent deletion is forbidden even with admin-equivalent password', () => {
  const result = authorizeProtectedFormMutation({
    ...base,
    method: 'DELETE',
    password: 'correct horse battery staple',
  });
  assert.equal(result.status, 403);
  assert.equal(result.error, PROTECTED_FORM_HELPER_MESSAGE);
});

test('credential-like body properties are rejected and unrelated forms are unaffected', () => {
  assert.equal(authorizeProtectedFormMutation({
    ...base,
    body: { protection_password: 'never persist me' },
    password: 'correct horse battery staple',
  }).code, 'PROTECTED_FORM_CREDENTIAL_IN_BODY');
  assert.deepEqual(authorizeProtectedFormMutation({
    ...base,
    formId: 'unrelated-form',
  }), { ok: true, protected: false });
  assert.deepEqual(authorizeProtectedFormMutation({
    ...base,
    tenantId: 'unrelated-tenant',
  }), { ok: true, protected: false });
});