import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEventCodeOfConduct, hasCodeOfConductContent, codeOfConductScope, codeOfConductPayload } from './eventCodeOfConduct.mjs';
import { createEventSettingsWriter } from './eventSettingsSaving.js';

test('single setting roundtrip preserves exact saved HTML and unrelated settings', async () => {
  const content = '<h2>Our Code</h2>\n<p>Respect &amp; inclusion.</p>';
  let rows = [{ id: 'terms', setting_key: 'event_booking_terms', setting_value: 'unchanged' }];
  const calls = [];
  const writer = createEventSettingsWriter({
    entity: { create: async data => { calls.push(data); return { id: 'conduct', ...data }; } },
    getRows: () => rows,
    acknowledge: row => { rows = [...rows, row]; },
  });
  await writer.create({ setting_key: 'event_code_of_conduct', setting_value: JSON.stringify({ content, required: true }) });
  assert.equal(calls.length, 1);
  assert.equal(rows[0].setting_value, 'unchanged');
  const policy = parseEventCodeOfConduct(rows);
  assert.deepEqual(policy, { content, required: true });
  assert.deepEqual(codeOfConductPayload(policy, true), { code_of_conduct_accepted: true, code_of_conduct_content: content });
  assert.deepEqual(codeOfConductPayload(policy, false), {});
  assert.notEqual(codeOfConductScope('one', policy), codeOfConductScope('two', policy));
  assert.notEqual(codeOfConductScope('one', policy), codeOfConductScope('one', { ...policy, content: content + ' ' }));
});

test('empty rich editor content cannot be made mandatory', () => {
  for (const html of ['', '<p><br></p>', '<p>&nbsp; &#160; &#xA0;\u200b</p>', '<p>&emsp;&#32;&#x20;&ZeroWidthSpace;</p>', '<!-- draft --><p> </p>', '<script>hidden</script><style>hidden</style>']) {
    assert.equal(hasCodeOfConductContent(html), false, html);
  }
  assert.equal(hasCodeOfConductContent('<h2>Be respectful</h2>'), true);
  assert.deepEqual(parseEventCodeOfConduct([]), { content: '', required: false });
  assert.equal(parseEventCodeOfConduct('{"content":"Optional","required":false}').required, false);
});

test('simple, complex, card and waiting-list request builders retain acceptance, including paid recovery', () => {
  const load = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const simple = load('../pages/EventDetails.jsx');
  const payment = load('../components/booking/PaymentOptions.jsx');
  const complex = load('../pages/ComplexEventDetail.jsx');
  const waiting = load('../components/booking/WaitingListCheckout.jsx');
  assert.match(simple, /const requestPayload = \{\s*\.\.\.codeOfConduct\.payload/);
  for (const name of ['programPayload', 'piPayload', 'savedPayload']) {
    assert.match(payment, new RegExp(`const ${name} = \\{\\s*\\.\\.\\.(?:codeOfConduct|liveCodeOfConduct.current).payload`));
  }
  assert.match(payment, /invoke\('createStripePaymentIntent', \{\s*\.\.\.liveCodeOfConduct\.current\.payload/);
  assert.match(payment, /code_of_conduct_content: savedPayload\.code_of_conduct_content/);
  assert.equal((complex.match(/code_of_conduct_content: data\.code_of_conduct_content/g) || []).length, 2);
  assert.match(waiting, /\.\.\.codeOfConduct\.payload/);
  assert.match(payment, /bookingBlocked=\{!codeOfConduct\.canProceed\}/);
});
