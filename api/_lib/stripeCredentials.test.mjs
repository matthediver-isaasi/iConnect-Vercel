import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptCredentials,
  selectStripeCredentials,
} from './stripeCredentials.js';
import {
  mergeCredentialUpdates,
  maskCredentials,
} from '../admin/integrations.js';

const stored = {
  secret_key: 'sk_live_realistic',
  publishable_key: 'pk_live_realistic',
  test_secret_key: 'sk_test_realistic',
  test_publishable_key: 'pk_test_realistic',
  stripe_mode_forms: 'live',
  stripe_mode_membership: 'test',
};

test('membership Test and Forms Live select independent complete key pairs', () => {
  assert.deepEqual(selectStripeCredentials(stored, 'membership'), {
    secret_key: 'sk_test_realistic',
    publishable_key: 'pk_test_realistic',
    mode: 'test',
    configuration_error: null,
  });
  assert.deepEqual(selectStripeCredentials(stored, 'forms'), {
    secret_key: 'sk_live_realistic',
    publishable_key: 'pk_live_realistic',
    mode: 'live',
    configuration_error: null,
  });
});

test('explicit Test mode never substitutes either live credential', () => {
  for (const incomplete of [
    { ...stored, test_secret_key: null },
    { ...stored, test_publishable_key: null },
    { ...stored, test_secret_key: null, test_publishable_key: null },
  ]) {
    const selected = selectStripeCredentials(incomplete, 'membership');
    assert.equal(selected.mode, 'test');
    assert.equal(selected.secret_key, null);
    assert.equal(selected.publishable_key, null);
    assert.match(selected.configuration_error, /set to Test/);
  }
});

test('an unreadable encrypted test credential fails closed instead of selecting live', () => {
  const decrypted = decryptCredentials({
    ...stored,
    test_secret_key: 'not-valid-encrypted:ciphertext',
  });
  const selected = selectStripeCredentials(decrypted, 'membership');
  assert.equal(selected.mode, 'test');
  assert.equal(selected.secret_key, null);
  assert.equal(selected.publishable_key, null);
  assert.match(selected.configuration_error, /could not be read/);
});

test('masked credential updates preserve secrets and exact persisted modes', () => {
  const masked = maskCredentials(stored);
  const merged = mergeCredentialUpdates(stored, {
    ...masked,
    stripe_mode_membership: 'test',
    stripe_mode_forms: 'live',
  });
  assert.deepEqual(merged, stored);
  assert.equal(masked.stripe_mode_membership, 'test');
  assert.equal(masked.stripe_mode_forms, 'live');
});