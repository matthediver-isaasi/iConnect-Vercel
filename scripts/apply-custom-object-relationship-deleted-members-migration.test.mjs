import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { destinationTarget, main, MIGRATION } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const env = {
  DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
  DEST_DATABASE_URL: 'postgresql://postgres.lvmzliemqnieeoruhkik:test@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
};

test('destination guards accept only exact pinned hosts, project user and database', () => {
  assert.equal(destinationTarget(env).search, '');
  assert.equal(destinationTarget({ ...env, DEST_DATABASE_URL: 'postgres://postgres:test@db.lvmzliemqnieeoruhkik.supabase.co/postgres' }).search, '');
  for (const change of [
    { DEST_SUPABASE_URL: 'http://lvmzliemqnieeoruhkik.supabase.co' },
    { DEST_SUPABASE_URL: 'https://other.supabase.co' },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace('aws-1-eu-central-1.pooler.supabase.com', 'evil.example') },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace('5432', '6543') },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace('postgres.lvmzliemqnieeoruhkik', 'postgres.other') },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL + '&host=evil.example' },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL + '&ssl=false' },
    { DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace('/postgres?', '/other?') },
    { DEST_DATABASE_URL: '' },
  ]) assert.throws(() => destinationTarget({ ...env, ...change }), /destination|Destination/);
  assert.throws(() => destinationTarget({ DATABASE_URL: env.DEST_DATABASE_URL, SOURCE_DATABASE_URL: env.DEST_DATABASE_URL }));
});

test('offline dry run reports exact SQL SHA; apply refuses missing review or destination before networking', async () => {
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const logs = [];
  const previous = console.log;
  console.log = value => logs.push(JSON.parse(value));
  try {
    await main([], {});
  } finally {
    console.log = previous;
  }
  assert.deepEqual(logs, [{ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }]);
  await assert.rejects(main(['--apply'], env), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], env), /Reviewed migration SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${sha256}`], {}), /Pinned destination credentials/);
  await assert.rejects(main(['--unknown'], {}), /Supported arguments/);
});

test('apply runner enforces verified TLS, transactional DDL and server-only verification', async () => {
  const script = await readFile(new URL('./apply-custom-object-relationship-deleted-members-migration.mjs', import.meta.url), 'utf8');
  assert.match(script, /rejectUnauthorized: true, ca, servername: target.hostname/);
  assert.match(script, /await client.query\('BEGIN'\)/);
  assert.match(script, /await client.query\('COMMIT'\)/);
  assert.match(script, /await client.query\('ROLLBACK'\)/);
  assert.match(script, /verification.rowCount !== 2/);
  assert.doesNotMatch(script, /SOURCE_DATABASE_URL|process.env.DATABASE_URL|FROM public.member|FROM public.tenant/);
});