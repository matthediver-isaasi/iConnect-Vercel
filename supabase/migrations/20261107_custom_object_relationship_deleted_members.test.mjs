import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('./20261107_custom_object_relationship_deleted_members.sql', import.meta.url), 'utf8');

test('migration narrowly replaces both member joins, preserving installed routine definitions', () => {
  assert.match(sql, /definition := pg_get_functiondef\(routine\)/);
  assert.match(sql, /EXECUTE replace\(definition, old_join, new_join\)/);
  assert.match(sql, /ep\.email IS NULL OR ep\.email !~\* ''\^deleted_\.\+@deleted\[\.\]local\$''/);
  assert.match(sql, /m\.email IS NULL OR m\.email !~\* '\^deleted_\.\+@deleted\[\.\]local\$'/);
  assert.doesNotMatch(sql, /login_enabled|membership_paused|first_name|last_name/i);
  assert.doesNotMatch(sql, /\b(?:INSERT INTO|UPDATE public|DELETE FROM|DROP FUNCTION|CREATE FUNCTION|ALTER TABLE)\b/i);
  assert.match(sql, /Already installed/);
  assert.match(sql, /Unrecognized relationship-list member join/);
});

test('migration retains server-only grants, security contract and schema reload', () => {
  assert.equal((sql.match(/FROM PUBLIC, anon, authenticated/g) || []).length, 2);
  assert.equal((sql.match(/TO service_role/g) || []).length, 2);
  assert.match(sql, /AND prosecdef/);
  assert.match(sql, /search_path=public/);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
});