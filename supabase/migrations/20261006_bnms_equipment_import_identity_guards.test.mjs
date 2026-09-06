import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('./20261006_bnms_equipment_import_identity_guards.sql', import.meta.url),
  'utf8',
);

test('identity guard is schema-order independent and resolves generated object IDs at write time', () => {
  assert.match(migration, /SELECT definition\.object_key/);
  assert.match(migration, /NEW\.custom_object_id/);
  assert.doesNotMatch(migration, /SELECT id INTO STRICT/);
  assert.doesNotMatch(migration, /c1ce08d4|633d90fa|3dae6022/);
});

test('identity guard serializes same-key inserts and rejects missing or duplicate keys', () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /hashtextextended/);
  assert.match(migration, /bnms_equipment_import_identity_required/);
  assert.match(migration, /bnms_equipment_import_identity_unique/);
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
});