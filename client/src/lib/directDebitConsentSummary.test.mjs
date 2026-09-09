import test from 'node:test';
import assert from 'node:assert/strict';

import { directDebitFirstCollectionText } from './directDebitConsentSummary.js';

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