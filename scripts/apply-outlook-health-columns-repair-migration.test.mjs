import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { main, MIGRATION } from './apply-outlook-health-columns-repair-migration.mjs';

const env = {
  DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
  DEST_DATABASE_URL: 'postgresql://postgres.lvmzliemqnieeoruhkik:test@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
};

test('offline default emits exact review hash and apply is hash gated', async () => {
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
  await assert.rejects(main(['--apply'], env), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], env), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${sha256}`], {}), /Pinned destination credentials/);
  await assert.rejects(main(['--apply', '--preflight'], {}), /Supported modes/);
  await assert.rejects(main(['--unknown'], {}), /Supported modes/);
});

test('runner is DEST-pinned with read-only preflight and verified transactional apply', async () => {
  assert.equal(destinationTarget(env).hostname, 'aws-1-eu-central-1.pooler.supabase.com');
  const script = await readFile(
    new URL('./apply-outlook-health-columns-repair-migration.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /BEGIN READ ONLY/);
  assert.match(script, /current_setting\('transaction_read_only'\)/);
  assert.match(script, /rejectUnauthorized: true, ca, servername: target.hostname/);
  assert.match(script, /await client\.query\('BEGIN'\)/);
  assert.match(script, /assertPostconditions/);
  assert.match(script, /await client\.query\('COMMIT'\)/);
  assert.match(script, /await client\.query\('ROLLBACK'\)/);
  assert.doesNotMatch(script, /SOURCE_DATABASE_URL|process\.env\.DATABASE_URL/);
});