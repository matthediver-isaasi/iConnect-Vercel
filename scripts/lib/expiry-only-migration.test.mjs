import test from 'node:test';
import assert from 'node:assert/strict';
import { runExpiryOnlyMigration, validateExpiryOnlyArgs } from './expiry-only-migration.mjs';

test('expiry-only installer requires both reviewed hashes for application', () => {
  assert.throws(() => validateExpiryOnlyArgs(['--expiry-only', '--apply']), /reviewed/);
  assert.throws(() => validateExpiryOnlyArgs([
    '--expiry-only', '--apply', `--expected-contract=${'a'.repeat(64)}`,
  ]), /reviewed/);
  assert.equal(validateExpiryOnlyArgs([
    '--expiry-only', '--apply', `--expected-contract=${'a'.repeat(64)}`,
    `--expected-migration=${'b'.repeat(64)}`,
  ]).apply, true);
});

test('expiry-only installer rejects mixed migration modes, malformed hashes and duplicate flags', () => {
  for (const args of [
    ['--expiry-only', '--payment-attempts'],
    ['--expiry-only', '--apply', '--verify-dest'],
    ['--expiry-only', '--verify-dest', '--verify-dest'],
    ['--expiry-only', '--expected-contract=not-a-hash'],
    ['--expiry-only', '--target=SOURCE'],
  ]) assert.throws(() => validateExpiryOnlyArgs(args), /Refusing/);
});

test('default expiry-only plan never connects', async () => {
  let connected = false;
  await runExpiryOnlyMigration(['--expiry-only'], async () => { connected = true; });
  assert.equal(connected, false);
});