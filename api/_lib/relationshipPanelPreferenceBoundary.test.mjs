import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const collection = await readFile(
  new URL('../entities/[entity]/index.js', import.meta.url),
  'utf8',
);
const item = await readFile(
  new URL('../entities/[entity]/[id].js', import.meta.url),
  'utf8',
);
const migration = await readFile(
  new URL('../../supabase/migrations/20261002_relationship_panel_preferences.sql', import.meta.url),
  'utf8',
);

test('generic SystemSettings routes hide and reject personal relationship panel rows', () => {
  assert.match(
    collection,
    /query = query\.not\('setting_key', 'like', 'relationship_columns_%'\)/,
  );
  assert.match(
    collection,
    /req\.method === 'POST'[\s\S]*startsWith\('relationship_columns_'\)[\s\S]*dedicated endpoint/,
  );
  assert.match(
    item,
    /existingPersonalSetting[\s\S]*startsWith\('relationship_columns_'\)[\s\S]*status\(404\)[\s\S]*status\(403\)/,
  );
});

test('relationship panel setting writes have a scoped uniqueness boundary', () => {
  assert.match(
    migration,
    /PARTITION BY tenant_id, setting_key/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*ON system_settings \(tenant_id, setting_key\)[\s\S]*WHERE setting_key LIKE 'relationship_columns_%'/,
  );
});