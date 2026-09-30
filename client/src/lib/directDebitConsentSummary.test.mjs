import test from 'node:test';
import assert from 'node:assert/strict';

import { directDebitFirstCollectionText, directDebitPolicyText, directDebitHasFixedTermTotal } from './directDebitConsentSummary.js';

test('describes earliest, nominated-day and anniversary collection timing', () => {
  assert.equal(
    directDebitFirstCollectionText({ firstCollectionRule: 'earliest' }),
    'As soon as the mandate permits',
  );
  assert.equal(
    directDebitFirstCollectionText({ firstCollectionRule: 'nominated_day', collectionDay: 21 }),
    'On the next applicable 21st of the month',
  );
  assert.equal(
    directDebitFirstCollectionText({ firstCollectionRule: 'anniversary' }),
    'On the next applicable monthly date matching the day your membership year starts',
  );
});

test('invalid nominated days fail safely to earliest timing', () => {
  assert.equal(
    directDebitFirstCollectionText({ firstCollectionRule: 'nominated_day', collectionDay: 31 }),
    'As soon as the mandate permits',
  );
});

for (const end_policy of ['stop', 'continue']) {
  for (const pricing_policy of ['fixed', 'dynamic']) {
    test(`discloses ${end_policy}/${pricing_policy} independently`, () => {
      const offer = { collectionPolicy: { version: 1, end_policy, pricing_policy } };
      const text = directDebitPolicyText(offer);
      assert.match(text, end_policy === 'stop' ? /Collections stop/ : /Collections continue/);
      assert.match(text, pricing_policy === 'fixed' ? /fixed for this membership term/ : /amount can change during the term/);
      assert.equal(directDebitHasFixedTermTotal(offer), pricing_policy === 'fixed');
      if (end_policy === 'continue' && pricing_policy === 'fixed') assert.match(text, /restamped/);
      if (pricing_policy === 'dynamic') assert.match(text, /advance notice/);
    });
  }
}

test('legacy policy is never inferred from instalments or auto-renew', () => {
  assert.match(directDebitPolicyText({ instalmentCount: 12, autoRenew: true }), /administrator must review/);
});