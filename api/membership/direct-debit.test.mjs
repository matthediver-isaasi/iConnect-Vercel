import test from 'node:test';
import assert from 'node:assert/strict';

import { selectLatestDirectDebitAgreement } from './direct-debit.js';

test('Direct Debit status lookup ignores a newer Stripe agreement for the same member', () => {
  const agreement = selectLatestDirectDebitAgreement([
    { id: 'stripe-newest', provider: 'stripe', metadata: { card: {} } },
    { id: 'dd-current', provider: 'gocardless', metadata: { dd: { kind: 'monthly_direct_debit' } } },
  ]);

  assert.equal(agreement?.id, 'dd-current');
});

test('Direct Debit status lookup supports only intentional legacy DD records', () => {
  const agreement = selectLatestDirectDebitAgreement([
    { id: 'stripe-with-dd-shaped-data', provider: 'stripe', metadata: { dd: { kind: 'monthly_direct_debit' } } },
    { id: 'unrelated-legacy', provider: null, metadata: { card: {} } },
    { id: 'legacy-dd', provider: null, metadata: { dd: { kind: 'monthly_direct_debit' } } },
  ]);

  assert.equal(agreement?.id, 'legacy-dd');
});