import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  main, MIGRATION,
} from './apply-delete-communication-category-preserve-campaigns-migration.mjs';

test('offline mode emits the exact review hash without requiring credentials', async () => {
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const messages = [];
  const previous = console.log;
  console.log = value => messages.push(JSON.parse(value));
  try {
    await main([], {});
  } finally {
    console.log = previous;
  }
  assert.deepEqual(messages, [{
    dryRun: true, migration: MIGRATION, sha256, writesPerformed: false,
  }]);
  await assert.rejects(main(['--apply'], {}), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], {}), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--preflight', '--apply'], {}), /Supported modes/);
  await assert.rejects(main(['--unknown'], {}), /Supported modes/);
});

test('runner has read-only preflight, destination pin, verified TLS, and transactional postconditions', async () => {
  const script = await readFile(
    new URL('./apply-delete-communication-category-preserve-campaigns-migration.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /destinationTarget\(env\)/);
  assert.match(script, /rejectUnauthorized: true, ca, servername: target.hostname/);
  assert.match(script, /BEGIN READ ONLY/);
  assert.match(script, /current_setting\('transaction_read_only'\)/);
  assert.match(script, /await client\.query\('BEGIN'\)/);
  assert.match(script, /assertPostconditions/);
  assert.match(script, /await client\.query\('COMMIT'\)/);
  assert.match(script, /await client\.query\('ROLLBACK'\)/);
  assert.doesNotMatch(script, /SOURCE_DATABASE_URL|process\.env\.DATABASE_URL/);
});