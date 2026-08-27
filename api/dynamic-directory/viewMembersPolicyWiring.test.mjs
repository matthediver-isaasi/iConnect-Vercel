import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const createSource = fs.readFileSync(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
const updateSource = fs.readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../../supabase/migrations/20260827_separate_org_view_members_roles.sql', import.meta.url),
  'utf8'
);

test('policy writes are permission-gated on create and update', () => {
  for (const source of [createSource, updateSource]) {
    assert.match(source, /org_directory_view_members_role_ids/);
    assert.match(source, /view_members_role_ids/);
    assert.match(source, /Directory settings access required/);
  }
});

test('migration copies legacy values once per tenant without overwriting new policy', () => {
  assert.match(migration, /org_directory_reverse_card_role_ids/);
  assert.match(migration, /GROUP BY legacy\.tenant_id/);
  assert.match(migration, /system_settings_org_view_members_one_per_tenant/);
  assert.match(migration, /ROW_NUMBER\(\) OVER \(PARTITION BY tenant_id ORDER BY id\)/);
  assert.match(migration, /ON CONFLICT \(tenant_id\)[\s\S]*WHERE setting_key = 'org_directory_view_members_role_ids'/);
  assert.match(migration, /view_members_role_ids JSONB DEFAULT NULL/);
});