import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from './apply-directory-carousel-consent.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

test('migration review is offline and apply requires the exact reviewed hash', async () => {
  const original = console.log;
  const logs = [];
  console.log = value => logs.push(JSON.parse(value));
  try { await main([], {}); } finally { console.log = original; }
  assert.equal(logs[0].offline, true);
  assert.equal(logs[0].writesPerformed, false);
  assert.match(logs[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(main(['--apply'], {}), /Reviewed migration hash required/);
  await assert.rejects(main(['--apply', '--preflight'], {}), /Use offline review/);
});

test('runner never accepts generic or SOURCE database credentials as a fallback', () => {
  assert.throws(() => destinationTarget({ DATABASE_URL: 'postgres://fixture.invalid/postgres' }), /unavailable/);
  assert.throws(() => destinationTarget({
    DEST_SUPABASE_URL: 'https://source-project.supabase.co',
    DEST_DATABASE_URL: 'postgres://postgres@fixture.invalid/postgres',
  }), /pin mismatch/);
});
