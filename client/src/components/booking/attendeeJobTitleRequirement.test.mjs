import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { requireAttendeeJobTitle, missingAttendeeJobTitle } from '../../../../shared/attendeeJobTitleRequirement.js';

const read = path => readFileSync(path, 'utf8');
const simple = read('client/src/components/booking/AttendeeList.jsx');
const complex = read('client/src/pages/ComplexEventDetail.jsx');
const payment = read('client/src/components/booking/PaymentOptions.jsx');
const enabled = [{ setting_key: 'require_attendee_job_title', setting_value: 'true' }];

// Execute the actual editor JSX and its change callback, not a duplicate component.
for (const [kind, source] of [['simple', simple], ['complex', complex]]) {
  test(`${kind} editor shows editable required titles for self, colleague and guest and preserves edits`, () => {
    const start = source.indexOf('<label className="block text-sm">', kind === 'complex' ? source.indexOf('function CartSummary') : 0);
    const jsx = source.slice(start, source.indexOf('</label>', start) + 8);
    const compiled = transformSync(`return (${jsx});`, { loader: 'jsx' }).code;
    for (const identity of [{ isSelf: true }, { validationStatus: 'registered' }, { validationStatus: 'external' }]) {
      let attendee = { ...identity, email: 'person@example.test', first_name: 'Person', job_title: 'Director' };
      const render = required => new Function('React', 'Input', 'attendee', 'index', 'i', 'ticketClassId', 'requireJobTitle', 'onUpdate', 'onUpdateAttendee', compiled)(
        React, 'input', attendee, 0, 0, 'ticket', required,
        (_i, key, value) => { attendee = { ...attendee, [key]: value }; },
        (_t, _i, patch) => { attendee = { ...attendee, ...patch }; },
      );
      const element = render(true);
      assert.match(renderToStaticMarkup(element), /value="Director"/);
      assert.match(renderToStaticMarkup(element), /required/);
      const input = React.Children.toArray(element.props.children).find(child => child.type === 'input');
      input.props.onChange({ target: { value: 'Editor' } });
      assert.equal(attendee.job_title, 'Editor');
      assert.equal(attendee.email, 'person@example.test');
      input.props.onChange({ target: { value: ' ' } });
      assert.match(renderToStaticMarkup(render(true)), /Enter a job title for Person/);
      assert.doesNotMatch(renderToStaticMarkup(render(false)), /required=|Enter a job title/);
    }
  });
}
test('actual checkout guard validates all attendees without clearing any details', () => {
  const start = payment.indexOf('const guardAttendeeJobTitles = () => {');
  const body = payment.slice(start + 'const guardAttendeeJobTitles = () => {'.length, payment.indexOf('\n  };', start));
  const errors = [];
  const guard = (settings, attendees, loading = false, failed = false) => new Function(
    'eventPaymentSettings', 'attendees', 'eventPaymentSettingsLoading', 'eventPaymentSettingsError', 'toast', 'requireAttendeeJobTitle', 'missingAttendeeJobTitle', body,
  )(settings, attendees, loading, failed, { error: value => errors.push(value) }, requireAttendeeJobTitle, missingAttendeeJobTitle);
  const attendees = [{ job_title: 'Manager' }, { first_name: 'Later', job_title: ' ' }];
  const before = structuredClone(attendees);
  assert.equal(guard(enabled, attendees), false);
  assert.match(errors.at(-1), /attendee 2 \(Later\)/);
  assert.deepEqual(attendees, before);
  attendees[1].job_title = 'Scientist';
  assert.equal(guard(enabled, attendees), true);
  assert.equal(guard([], [{ job_title: '' }]), true);
  assert.equal(guard(enabled, attendees, true), false);
  assert.equal(guard(enabled, attendees, false, true), false);
});
test('checkout transformations keep titles and member lookup is not expanded publicly', () => {
  assert.match(complex, /ci\.attendees\.map\(a => \(\{ \.\.\.purchaseIdentity\(a\), job_title: a\.job_title/);
  assert.match(payment, /attendees: attendees\.filter\(a => a\.isValid\)\.map\(a => \(\{ \.\.\.a, \.\.\.purchaseIdentity\(a\) \}\)\)/);
  assert.match(complex, /job_title: \(a\.job_title \|\| ''\)\.trim\(\)/);
  assert.match(read('api/public/system-settings.js'), /'require_attendee_job_title'/);
  const settings = read('client/src/pages/EventSettings.jsx');
  assert.match(settings, /setRequireJobTitle\(settings\.find/);
  assert.match(settings, /setting_value: String\(requireJobTitle\)/);
});
