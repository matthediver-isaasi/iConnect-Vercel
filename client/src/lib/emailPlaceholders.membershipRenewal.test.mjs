import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_PLACEHOLDERS,
  PLACEHOLDER_CONTEXTS,
} from './emailPlaceholders.js';

test('payment link documentation covers fee emails and renewal reminders', () => {
  const paymentLink = EMAIL_PLACEHOLDERS.find((entry) => entry.token === '{{payment_link}}');

  assert.ok(paymentLink);
  assert.ok(PLACEHOLDER_CONTEXTS.includes('Membership Renewal Reminders'));
  assert.deepEqual(paymentLink.contexts, [
    'Membership Fee Link',
    'Membership Renewal Reminders',
  ]);
  assert.match(paymentLink.description, /optional in a membership renewal reminder template/);
  assert.match(paymentLink.prerequisites, /upfront, non-recurring renewal/);
  assert.match(paymentLink.notes, /deferred until the opening date/);
  assert.match(paymentLink.notes, /without this token remain informational/);
});