import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../../supabase/migrations/20260903_role_assignable_roles.sql', import.meta.url),
  'utf8',
);

test('capacity trigger covers creation, activation, role changes, and organisation moves', () => {
  assert.match(migration, /BEFORE INSERT ON member/);
  assert.match(
    migration,
    /BEFORE UPDATE OF role_id,\s*login_enabled,\s*organization_id ON member/,
  );
});

test('capacity trigger skips only when role, login state, and organisation are unchanged', () => {
  assert.match(migration, /NEW\.role_id IS NOT DISTINCT FROM OLD\.role_id/);
  assert.match(migration, /NEW\.login_enabled IS NOT DISTINCT FROM OLD\.login_enabled/);
  assert.match(migration, /NEW\.organization_id IS NOT DISTINCT FROM OLD\.organization_id/);
  assert.match(migration, /WHERE organization_id = NEW\.organization_id/);
});