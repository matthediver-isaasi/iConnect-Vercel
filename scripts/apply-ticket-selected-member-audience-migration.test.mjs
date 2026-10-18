import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './apply-ticket-selected-member-audience-migration.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

test('offline review and reviewed-hash gating need no database/network', async () => {
  await main([], {});
  await assert.rejects(main(['--apply'], {}), /Exact reviewed migration SHA/);
  await assert.rejects(main(['--verify'], {}), /Pinned destination credentials/);
  await assert.rejects(main(['--apply', '--verify'], {}), /Use --apply/);
  await assert.rejects(main(['--source'], {}), /Use --apply/);
});

test('DEST pin rejects fallback, other projects and connection overrides', () => {
  const base = {
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
    DEST_DATABASE_URL: 'postgresql://postgres.lvmzliemqnieeoruhkik:unused@aws-1-eu-central-1.pooler.supabase.com:5432/postgres',
  };
  assert.equal(destinationTarget(base).hostname, 'aws-1-eu-central-1.pooler.supabase.com');
  for (const env of [
    { DATABASE_URL: base.DEST_DATABASE_URL },
    { ...base, DEST_SUPABASE_URL: 'https://another.supabase.co' },
    { ...base, DEST_DATABASE_URL: base.DEST_DATABASE_URL.replace('postgres.lvmzliemqnieeoruhkik', 'postgres.other') },
    { ...base, DEST_DATABASE_URL: `${base.DEST_DATABASE_URL}?host=example.invalid` },
  ]) assert.throws(() => destinationTarget(env));
});
