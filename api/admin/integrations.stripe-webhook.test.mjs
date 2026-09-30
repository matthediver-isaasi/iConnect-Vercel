import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskCredentials,
  mergeCredentialUpdates,
  validateStripeWebhookSecretUpdates,
} from './integrations.js';

test('ordinary Stripe credential updates preserve both webhook secrets', () => {
  const existing = {
    membership_webhook_secret: 'whsec_live_existing',
    test_membership_webhook_secret: 'whsec_test_existing',
    secret_key: 'sk_live_old',
  };
  assert.deepEqual(
    mergeCredentialUpdates(existing, { secret_key: 'sk_live_new' }),
    { ...existing, secret_key: 'sk_live_new' },
  );
  assert.deepEqual(
    mergeCredentialUpdates(existing, {
      membership_webhook_secret: '',
      test_membership_webhook_secret: '****',
    }),
    existing,
  );
});

test('webhook signing secrets are fully redacted', () => {
  const masked = maskCredentials({
    membership_webhook_secret: 'whsec_live_sensitive',
    test_membership_webhook_secret: 'whsec_test_sensitive',
  });
  assert.deepEqual(masked, {
    membership_webhook_secret: '****',
    test_membership_webhook_secret: '****',
  });
});

test('validates only nonblank newly supplied webhook secrets', () => {
  assert.equal(validateStripeWebhookSecretUpdates({
    membership_webhook_secret: 'whsec_valid-value',
    test_membership_webhook_secret: '',
  }), null);
  assert.equal(validateStripeWebhookSecretUpdates({
    membership_webhook_secret: 'bad',
  }), 'membership_webhook_secret must start with whsec_ and contain no whitespace');
  assert.equal(validateStripeWebhookSecretUpdates({
    test_membership_webhook_secret: 'whsec_has space',
  }), 'test_membership_webhook_secret must start with whsec_ and contain no whitespace');
});