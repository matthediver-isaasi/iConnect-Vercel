import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.join(here, '20261024_form_width_presets.sql'),
  'utf8',
);
const runner = readFileSync(
  path.join(here, '../../scripts/apply-form-width-presets.mjs'),
  'utf8',
);

test('form width migration persists a narrow default and constrains all presets', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS form_width TEXT NOT NULL DEFAULT 'narrow'/);
  assert.match(migration, /UPDATE public\.form[\s\S]*SET form_width = 'narrow'/);
  assert.match(migration, /form_width NOT IN \('narrow', 'medium', 'wide'\)/);
  assert.match(migration, /form_form_width_check/);
  assert.match(migration, /CHECK \(form_width IN \('narrow', 'medium', 'wide'\)\)/);
});

test('migration runner is destination-bound and verifies the persisted column', () => {
  assert.match(runner, /DEST_DATABASE_URL/);
  assert.match(runner, /DEST_SUPABASE_URL/);
  assert.match(runner, /isApprovedDestinationSupabaseTarget/);
  assert.match(runner, /20261024_form_width_presets\.sql/);
  assert.match(runner, /form_form_width_check/);
  assert.match(runner, /jsonb_populate_record\(NULL::public\.form/);
  assert.match(runner, /form_width_invalid_write/);
  assert.match(runner, /ROLLBACK TO SAVEPOINT/);
  assert.match(runner, /FORM_WIDTH_PRESETS = \['narrow', 'medium', 'wide'\]/);
  assert.match(runner, /await client\.query\('ROLLBACK'\)/);
});