import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFormPaymentAccessProof,
  withFormPaymentAccessProof,
} from './formPaymentAccess.js';

test('unrestricted legacy payments do not require an authorization stamp', () => {
  assert.equal(hasFormPaymentAccessProof({ payment_meta: {} }, { access_policy: null }), true);
  assert.equal(hasFormPaymentAccessProof({ payment_meta: {} }, {
    access_policy: { version: 1, group_rules: [], rbac_role_ids: [], operator: 'or' },
  }), true);
});

test('restricted and malformed policies require a valid authorization timestamp', () => {
  const form = {
    access_policy: {
      version: 1,
      group_rules: [{ group_id: 'g1', role_names: [] }],
      rbac_role_ids: [],
      operator: 'or',
    },
  };
  assert.equal(hasFormPaymentAccessProof({ payment_meta: {} }, form), false);
  assert.equal(hasFormPaymentAccessProof({
    payment_meta: { access_authorized_at: 'not-a-date' },
  }, form), false);
  assert.equal(hasFormPaymentAccessProof({
    payment_meta: { access_authorized_at: '2026-08-24T12:00:00.000Z' },
  }, form), true);
  assert.equal(hasFormPaymentAccessProof({
    payment_meta: {},
  }, {
    access_policy: {
      version: 999,
      group_rules: [{ group_id: 'g1', role_names: [] }],
      rbac_role_ids: [],
      operator: 'or',
    },
  }), false);
});

test('proof writer preserves payment metadata and stamps policy state', () => {
  assert.deepEqual(withFormPaymentAccessProof(
    { membership: { quote: { id: 'q1' } } },
    { authorizedAt: '2026-08-24T12:00:00.000Z', accessPolicyRequired: true },
  ), {
    membership: { quote: { id: 'q1' } },
    access_authorized_at: '2026-08-24T12:00:00.000Z',
    access_policy_required: true,
  });
});