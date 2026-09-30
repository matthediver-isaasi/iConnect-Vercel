import test from 'node:test';
import assert from 'node:assert/strict';
import { main, MIGRATIONS } from './apply-explicit-direct-debit-collection-policy.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

test('DD migration bundle includes dated commitments and organisation renewal ownership', async () => {
  assert.deepEqual(MIGRATIONS, [
    '20260924_gocardless_org_renewal_owners.sql',
    '20261108_direct_debit_dated_commitments.sql',
    '20261108_explicit_direct_debit_collection_policy.sql',
    '20261109_gocardless_dynamic_term_completion.sql',
    '20261109_manage_monthly_collection_days.sql',
  ]);
  const old = console.log;
  const messages = [];
  console.log = message => messages.push(JSON.parse(message));
  try { await main([], {}); } finally { console.log = old; }
  assert.equal(messages[0].destination, 'DEST');
  assert.equal(messages[0].writesPerformed, false);
  assert.match(messages[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(main(['--apply'], {}), /SHA-256/);
});

test('DD deployment never falls back to source, generic database URL or mismatched destination', () => {
  assert.throws(() => destinationTarget({ DATABASE_URL: 'postgres://example.invalid/postgres' }), /unavailable/);
  assert.throws(() => destinationTarget({
    DEST_DATABASE_URL: 'postgres://postgres:fixture@evil.invalid:5432/postgres',
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
  }), /pin mismatch/);
});