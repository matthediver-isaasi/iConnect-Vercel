import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildSurveyInvitationPrefill, mergeSurveyInvitationPrefill } from './surveyInvitationPrefill.js';
import { redactIdentityAnswers } from '../api/_lib/surveyScoring.js';

const booking = { attendee_first_name: 'Ada', attendee_last_name: 'Lovelace',
  attendee_email: 'ada@example.test', member_id: 'booker', organization_id: 'payer',
  private_answer: 'secret' };

test('anonymous responses redact published identity mappings with opaque labels', () => {
  const fields = [
    { id: 'a', type: 'text', prefill_field: 'member:first_name' },
    { id: 'b', type: 'text', prefill_field: 'booking:booking_reference' },
    { id: 'c', type: 'last_name' },
    { id: 'feedback', type: 'text' },
  ];
  assert.deepEqual(redactIdentityAnswers(fields, {
    a: 'Ada', b: 'booking-123', c: 'Lovelace', feedback: 'Useful event',
  }).data, { feedback: 'Useful event' });
});

test('published explicit mappings precede typed/name fallbacks; no broad or ambiguous evidence', () => {
  const fields = [
    { id: 'first', type: 'first_name' }, { id: 'last', label: 'Last Name' },
    { id: 'full', type: 'user_name' },
    { id: 'mapped', type: 'email', prefill_field: 'member:first_name' },
    { id: 'noFallback', type: 'email', prefill_field: 'org:invoicing_email' },
    { id: 'legacy', prefill_field: 'first_name' },
    { id: 'private', prefill_field: 'booking:private_answer' },
    { id: 'relationship', type: 'organisation_dropdown' },
    { id: 'custom', prefill_field: 'member_custom:secret' },
  ];
  const payload = buildSurveyInvitationPrefill(fields, booking);
  assert.deepEqual(payload.values, { first: 'Ada', last: 'Lovelace', full: 'Ada Lovelace', mapped: 'Ada' });
  assert.equal(payload.unavailable.length, 5);
  assert.deepEqual(buildSurveyInvitationPrefill([fields[5]], booking, {
    invitation_prefill_config: { source: 'member' },
  }).values, { legacy: 'Ada' });
  assert.equal(JSON.stringify(payload).includes('secret'), false);
});

test('client preserves defaults, draft values, cleared edits and rejects unpublished IDs', () => {
  const fields = ['default', 'draft', 'edited', 'empty', 'bool'].map(id => ({ id }));
  const previous = { default: 'Configured', draft: 'Saved', edited: '', bool: false };
  const payload = { values: Object.fromEntries([...fields.map(f => f.id), 'unpublished'].map(id => [id, 'Prefilled'])) };
  assert.deepEqual(mergeSurveyInvitationPrefill(previous, payload, fields, ['edited', 'draft']), {
    default: 'Configured', draft: 'Saved', edited: '', bool: false, empty: 'Prefilled',
  });
  assert.equal(previous.empty, undefined);
});

test('missing attendee scalars report unavailability rather than booker fallback', () => {
  assert.deepEqual(buildSurveyInvitationPrefill([{ id: 'name', prefill_field: 'member:first_name' }], {
    member_id: 'booker', first_name: 'Purchaser',
  }), { values: {}, unavailable: [{ field_id: 'name', reason: 'booking_value_unavailable' }] });
});

test('FormView consumes field-ID payload only after initialization and gates generic prefill', () => {
  const source = readFileSync(new URL('../client/src/pages/FormView.jsx', import.meta.url), 'utf8');
  assert.match(source, /urlMemberId: certificateGrant \? null/);
  assert.match(source, /urlOrgId: certificateGrant \? null/);
  assert.match(source, /prefillBookingId = certificateGrant \? null/);
  assert.match(source, /enabled: !certificateGrant && shouldFetchViewerBookingPrefill/);
  assert.match(source, /draftToken && !draftLoaded\) \|\| invitationInitializedRef/);
  assert.match(source, /mergeSurveyInvitationPrefill\(previous, payload, form.fields, protectedIds\)/);
  assert.doesNotMatch(source, /attendee = assignmentMeta.invitation_prefill/);
});