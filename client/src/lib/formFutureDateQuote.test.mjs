import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipQuoteKey } from './formPaymentQuote.js';

test('correcting a future-only date invalidates an earlier rejected membership quote', () => {
  const match = { configId: 'config', ruleId: 'rule', fieldMappings: {} };
  const form = { fields: [{ id: 'date', type: 'date', future_only: true }] };
  const key = values => membershipQuoteKey(match, values, form);
  assert.notEqual(key({ date: '2026-09-11' }), key({ date: '2026-09-12' }));
  assert.equal(key({ date: '2026-09-12', note: 'a' }), key({ date: '2026-09-12', note: 'b' }));
  const unrestricted = { fields: [{ id: 'date', type: 'date' }] };
  assert.equal(membershipQuoteKey(match, { date: '2026-09-11' }, unrestricted),
    membershipQuoteKey(match, { date: '2026-09-12' }, unrestricted));
});