import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  formRoleValidationError,
  unavailableRoleLabel,
} from './formRoleValidationError.js';

test('formats Base44 member role validation details into replacement guidance', () => {
  const result = formRoleValidationError({
    message: 'API Error (400): Invalid roles',
    body: {
      code: 'INVALID_MEMBER_ROLE_ASSIGNMENT',
      message: 'Two member role assignments are no longer available.',
      details: {
        invalid_role_settings: [
          {
            pipeline_index: 0,
            pipeline_label: 'Primary Member',
            setting: 'value_to_role_id',
            role_id: 'retired-mapped-role',
            answer: 'Student',
          },
          {
            pipeline_index: 1,
            setting: 'fallback_role_id',
            role_id: 'retired-fallback-role',
          },
        ],
      },
    },
  });

  assert.equal(result.title, 'Two member role assignments are no longer available.');
  assert.match(result.description, /“Primary Member”: Answer mapping for answer “Student” uses an unavailable role \(retired-mapped-role\)/);
  assert.match(result.description, /Pipeline 2: Fallback role uses an unavailable role \(retired-fallback-role\)/);
  assert.match(result.description, /Select an available replacement/);
});

test('only handles the member role assignment error code', () => {
  assert.equal(formRoleValidationError({ body: { code: 'OTHER_ERROR' } }), null);
  assert.equal(formRoleValidationError(new Error('Network failed')), null);
});

test('unavailable role label explicitly asks for replacement', () => {
  assert.equal(
    unavailableRoleLabel('legacy-role'),
    'Unavailable role (legacy-role) — select a replacement',
  );
});

test('role editors retain unavailable fixed, mapped, and fallback selections', async () => {
  const source = await readFile(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
  assert.match(source, /fixedRoleUnavailable[\s\S]*?<SelectItem value=\{member\.role_id\}/);
  assert.match(source, /mappedRoleUnavailable[\s\S]*?<SelectItem value=\{valueMap\[option\.value\]\}/);
  assert.match(source, /fallbackRoleUnavailable[\s\S]*?<SelectItem value=\{assignment\.fallback_role_id\}/);
  assert.match(source, /formRoleValidationError\(error, 'save'\)/);
});

test('form copy surfaces detailed member role validation errors', async () => {
  const source = await readFile(new URL('../pages/FormManagement.jsx', import.meta.url), 'utf8');
  assert.match(source, /formRoleValidationError\(error, 'copy'\)/);
  assert.match(source, /toast\.error\(roleError\.title, \{ description: roleError\.description \}\)/);
});

test('Base44 errors preserve structured response bodies for callers', async () => {
  const source = await readFile(new URL('../api/base44Client.js', import.meta.url), 'utf8');
  assert.match(source, /err\.code = errorJson\?\.code;/);
  assert.match(source, /err\.body = errorJson;/);
});