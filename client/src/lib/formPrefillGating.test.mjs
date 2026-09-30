// Tests for the shared prefill readiness gate (Task #3336).
// Guards against the race where a prefill entity resolves before its
// member/org custom-value queries, which would latch prefillApplied and
// permanently skip custom-field prefills on EmbedForm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWaitForPrefillCustomValues, resolveEffectivePrefillIds, buildPrefillValues, resolveMemberSourceOrgId, shouldWaitForPrefillOrgEntity, shouldFetchViewerBookingPrefill, shouldBlockForMissingViewerBooking, isViewerBookingResolutionPending } from './formFieldPrefill.js';

// --- buildPrefillValues: pure field mapping; empty result is legitimate ---

test('maps member core, org core and custom values', () => {
  const form = {
    prefill_source: 'member',
    fields: [
      { id: 'f1', prefill_field: 'member:first_name' },
      { id: 'f2', prefill_field: 'org:name' },
      { id: 'f3', prefill_field: 'member_custom:cf1', type: 'text' },
      { id: 'f4', prefill_field: 'org_custom:cf2', type: 'text' },
      { id: 'f5', type: 'organisation_dropdown' },
    ],
  };
  const memberEntity = { id: 'me', first_name: 'Ada', organization_id: 'org9' };
  const values = buildPrefillValues({
    form,
    memberEntity,
    orgEntity: { id: 'org9', name: 'Acme' },
    primaryEntity: memberEntity,
    memberCustomValues: [{ field_id: 'cf1', value: 'hello' }],
    orgCustomValues: [{ field_id: 'cf2', value: 'world' }],
  });
  assert.deepEqual(values, { f1: 'Ada', f2: 'Acme', f3: 'hello', f4: 'world', f5: 'org9' });
});

test('returns an empty object when nothing matches (callers must still latch)', () => {
  const form = {
    prefill_source: 'member',
    fields: [
      { id: 'f1', prefill_field: 'member:middle_name' },
      { id: 'f2' }, // no prefill_field
    ],
  };
  const memberEntity = { id: 'me' };
  const values = buildPrefillValues({ form, memberEntity, orgEntity: null, primaryEntity: memberEntity });
  assert.deepEqual(values, {});
});

test('organisation prefill fills the org dropdown from prefillOrgId', () => {
  const form = { prefill_source: 'organization', fields: [{ id: 'f1', type: 'organisation_dropdown' }] };
  const orgEntity = { id: 'org1' };
  assert.deepEqual(
    buildPrefillValues({ form, memberEntity: null, orgEntity, primaryEntity: orgEntity, prefillOrgId: 'org1' }),
    { f1: 'org1' }
  );
});

// --- resolveEffectivePrefillIds: explicit URL param > authenticated member/org > nothing ---

const viewer = { viewerMemberId: 'me', viewerOrgId: 'my-org' };

test('explicit URL params always win over the authenticated fallback', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: 'm-url', urlOrgId: 'o-url', prefillSource: 'member', ...viewer }),
    { prefillMemberId: 'm-url', prefillOrgId: 'o-url' }
  );
});

test('logged-in member with no URL params falls back to own ids on member-prefill forms', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: null, urlOrgId: null, prefillSource: 'member', ...viewer }),
    { prefillMemberId: 'me', prefillOrgId: 'my-org' }
  );
});

test('fallback also applies on organization-prefill forms', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: null, urlOrgId: null, prefillSource: 'organization', ...viewer }),
    { prefillMemberId: 'me', prefillOrgId: 'my-org' }
  );
});

test('no fallback when the form has no member/org prefill source', () => {
  for (const prefillSource of [null, undefined, 'none', 'booking']) {
    assert.deepEqual(
      resolveEffectivePrefillIds({ urlMemberId: null, urlOrgId: null, prefillSource, ...viewer }),
      { prefillMemberId: null, prefillOrgId: null }
    );
  }
});

test('anonymous viewers get no fallback', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: null, urlOrgId: null, prefillSource: 'member', viewerMemberId: null, viewerOrgId: null }),
    { prefillMemberId: null, prefillOrgId: null }
  );
});

test('member without an organisation degrades gracefully (org id stays null)', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: null, urlOrgId: null, prefillSource: 'organization', viewerMemberId: 'me', viewerOrgId: null }),
    { prefillMemberId: 'me', prefillOrgId: null }
  );
});

test('mixed: explicit member_id with fallback org', () => {
  assert.deepEqual(
    resolveEffectivePrefillIds({ urlMemberId: 'm-url', urlOrgId: null, prefillSource: 'member', ...viewer }),
    { prefillMemberId: 'm-url', prefillOrgId: 'my-org' }
  );
});

// --- shouldWaitForPrefillCustomValues ---

const base = {
  prefillSource: 'member',
  authenticated: true,
  memberId: 'm1',
  orgIdForCustomFields: 'o1',
  memberCustomValuesLoading: false,
  orgCustomValuesLoading: false,
};

test('no prefill source → never waits', () => {
  assert.equal(shouldWaitForPrefillCustomValues({ ...base, prefillSource: null, memberCustomValuesLoading: true, orgCustomValuesLoading: true }), false);
  assert.equal(shouldWaitForPrefillCustomValues({ ...base, prefillSource: 'none', memberCustomValuesLoading: true }), false);
});

test('anonymous viewer → never waits (queries are disabled)', () => {
  assert.equal(shouldWaitForPrefillCustomValues({ ...base, authenticated: false, memberCustomValuesLoading: true, orgCustomValuesLoading: true }), false);
});

test('member prefill waits while member custom values load', () => {
  assert.equal(shouldWaitForPrefillCustomValues({ ...base, memberCustomValuesLoading: true }), true);
});

test('member prefill waits while org custom values load (member org resolved late)', () => {
  assert.equal(shouldWaitForPrefillCustomValues({ ...base, orgCustomValuesLoading: true }), true);
});

test('organization prefill waits while org custom values load', () => {
  assert.equal(shouldWaitForPrefillCustomValues({
    ...base, prefillSource: 'organization', memberId: null, orgCustomValuesLoading: true,
  }), true);
});

test('organization prefill ignores member custom values loading flag', () => {
  assert.equal(shouldWaitForPrefillCustomValues({
    ...base, prefillSource: 'organization', memberCustomValuesLoading: true,
  }), false);
});

test('disabled queries (no ids) can never block prefill', () => {
  // react-query reports isLoading=true for disabled queries; the id args
  // mirror the enabled predicates so those can't deadlock the effect.
  assert.equal(shouldWaitForPrefillCustomValues({
    ...base, memberId: null, orgIdForCustomFields: null,
    memberCustomValuesLoading: true, orgCustomValuesLoading: true,
  }), false);
});

test('everything settled → apply', () => {
  assert.equal(shouldWaitForPrefillCustomValues(base), false);
});

test('score field filled-state: only integer score in range or explicit allowed N/A', async () => {
  const { isFieldValueFilled } = await import('./formFieldPrefill.js');
  const f = { type: 'score', score_min: 1, score_max: 5 };
  assert.equal(isFieldValueFilled(f, { score: '' }), false); // partial shape
  assert.equal(isFieldValueFilled(f, {}), false);
  assert.equal(isFieldValueFilled(f, { score: 3 }), true);
  assert.equal(isFieldValueFilled(f, { score: 9 }), false); // out of range
  assert.equal(isFieldValueFilled(f, { score: 2.5 }), false);
  assert.equal(isFieldValueFilled(f, { na: true }), false); // N/A not allowed
  assert.equal(isFieldValueFilled({ ...f, allow_na: true }, { na: true }), true);
  const nps = { type: 'score', score_style: 'nps' };
  assert.equal(isFieldValueFilled(nps, { score: 10 }), true);
  assert.equal(isFieldValueFilled(nps, { score: 11 }), false);
});

test('card-swipe gating: score shapes cannot advance a required step when invalid', async () => {
  const { isFieldValueFilled } = await import('./formFieldPrefill.js');
  const scoreField = { type: 'score', required: true, score_min: 1, score_max: 5 };
  // Empty/partial score shapes and disallowed N/A must NOT count as filled
  // (this is the shared gate the iEdit card-swipe "Next" button uses).
  assert.equal(isFieldValueFilled(scoreField, { score: '' }), false);
  assert.equal(isFieldValueFilled(scoreField, { na: true }), false); // N/A not allowed
  assert.equal(isFieldValueFilled(scoreField, { score: 4 }), true);
  assert.equal(isFieldValueFilled({ ...scoreField, allow_na: true }, { na: true }), true);
});

// --- Task #3357: member-source effective org id + org-entity readiness gate ---

test('resolveMemberSourceOrgId prefers the member entity org, falls back to prefillOrgId', () => {
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'member', memberEntity: { organization_id: 'o1' }, fallbackOrgId: 'o2' }),
    'o1'
  );
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'member', memberEntity: { organization_id: null }, fallbackOrgId: 'o2' }),
    'o2'
  );
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'member', memberEntity: null, fallbackOrgId: 'o2' }),
    'o2'
  );
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'member', memberEntity: null, fallbackOrgId: null }),
    null
  );
  // Non-member sources are unaffected
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'organization', memberEntity: { organization_id: 'o1' }, fallbackOrgId: 'o2' }),
    null
  );
  assert.equal(
    resolveMemberSourceOrgId({ prefillSource: 'booking', memberEntity: { organization_id: 'o1' }, fallbackOrgId: 'o2' }),
    null
  );
});

const orgForm = { fields: [{ id: 'f1', prefill_field: 'org:name' }] };

test('shouldWaitForPrefillOrgEntity waits only while an org fetch feeding org: fields is in flight', () => {
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'member', form: orgForm, effectiveOrgId: 'o1', orgEntityLoading: true,
  }), true);
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'organization', form: orgForm, effectiveOrgId: 'o1', orgEntityLoading: true,
  }), true);
  // Fetch settled -> no wait
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'member', form: orgForm, effectiveOrgId: 'o1', orgEntityLoading: false,
  }), false);
  // No resolvable org -> never blocks
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'member', form: orgForm, effectiveOrgId: null, orgEntityLoading: true,
  }), false);
  // No org-mapped fields -> no wait needed
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'member',
    form: { fields: [{ id: 'f1', prefill_field: 'member:first_name' }] },
    effectiveOrgId: 'o1',
    orgEntityLoading: true,
  }), false);
  // Booking/none sources are out of scope
  assert.equal(shouldWaitForPrefillOrgEntity({
    prefillSource: 'booking', form: orgForm, effectiveOrgId: 'o1', orgEntityLoading: true,
  }), false);
});

// Task #3399: authenticated viewer-booking prefill fallback gate.
test('shouldFetchViewerBookingPrefill fires only for booking forms, no explicit param, resolved logged-in viewer', () => {
  const base = {
    prefillSource: 'booking',
    urlBookingId: null,
    authResolved: true,
    viewerMemberId: 'm1',
    formSlug: 'my-form',
  };
  assert.equal(shouldFetchViewerBookingPrefill(base), true);
  // Explicit booking_id always wins — fallback disabled.
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, urlBookingId: 'b1' }), false);
  // Non-booking prefill sources never trigger the fetch.
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, prefillSource: 'member' }), false);
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, prefillSource: 'none' }), false);
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, prefillSource: undefined }), false);
  // Anonymous viewers and unresolved auth never trigger it.
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, viewerMemberId: null }), false);
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, authResolved: false }), false);
  // No slug (e.g. assignment-token surveys) — nothing to resolve against.
  assert.equal(shouldFetchViewerBookingPrefill({ ...base, formSlug: null }), false);
});

// Task #3400: block the form when the authenticated viewer has no booking
// for the linked event.
test('shouldBlockForMissingViewerBooking blocks only on an explicit settled noBooking result', () => {
  const base = {
    prefillSource: 'booking',
    urlBookingId: null,
    authResolved: true,
    viewerMemberId: 'm1',
    formSlug: 'my-form',
    viewerBookingData: { noBooking: true },
    viewerBookingError: null,
  };
  assert.equal(shouldBlockForMissingViewerBooking(base), true);
  // Booking found — never block.
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, viewerBookingData: { booking: { id: 'b1' } } }), false);
  // Plain-empty payload (non-event-linked form, anonymous session server-side) — degrade, don't block.
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, viewerBookingData: { booking: null } }), false);
  // Still loading / no data yet — don't block.
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, viewerBookingData: undefined }), false);
  // Transient error — degrade to the previous behaviour, don't block.
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, viewerBookingError: new Error('boom') }), false);
  // Not applicable cases: explicit param, anonymous, non-booking form.
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, urlBookingId: 'b1' }), false);
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, viewerMemberId: null }), false);
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, prefillSource: 'member' }), false);
  assert.equal(shouldBlockForMissingViewerBooking({ ...base, authResolved: false }), false);
});

test('isViewerBookingResolutionPending holds rendering while auth or the viewer-booking fetch settles', () => {
  const base = {
    prefillSource: 'booking',
    urlBookingId: null,
    authResolved: true,
    viewerMemberId: 'm1',
    formSlug: 'my-form',
    viewerBookingLoading: false,
  };
  // Settled — not pending.
  assert.equal(isViewerBookingResolutionPending(base), false);
  // Fetch in flight — pending.
  assert.equal(isViewerBookingResolutionPending({ ...base, viewerBookingLoading: true }), true);
  // Auth not yet resolved on a booking form with no param — pending (no flash).
  assert.equal(isViewerBookingResolutionPending({ ...base, authResolved: false }), true);
  // Anonymous viewer after auth resolved — never pending (renders as before).
  assert.equal(isViewerBookingResolutionPending({ ...base, viewerMemberId: null, viewerBookingLoading: true }), false);
  // Explicit booking_id or non-booking forms — never pending.
  assert.equal(isViewerBookingResolutionPending({ ...base, urlBookingId: 'b1', authResolved: false }), false);
  assert.equal(isViewerBookingResolutionPending({ ...base, prefillSource: 'member', authResolved: false }), false);
});

test('org dropdown on member-source forms falls back to prefillOrgId when member row lacks organization_id', () => {
  const form = { prefill_source: 'member', fields: [{ id: 'f1', type: 'organisation_dropdown' }] };
  const memberEntity = { id: 'me' }; // no organization_id
  assert.deepEqual(
    buildPrefillValues({ form, memberEntity, orgEntity: null, primaryEntity: memberEntity, prefillOrgId: 'sess-org' }),
    { f1: 'sess-org' }
  );
  // Member entity org still wins over the fallback
  assert.deepEqual(
    buildPrefillValues({ form, memberEntity: { id: 'me', organization_id: 'own-org' }, orgEntity: null, primaryEntity: memberEntity, prefillOrgId: 'sess-org' }),
    { f1: 'own-org' }
  );
  // No fallback and no member org -> untouched
  assert.deepEqual(
    buildPrefillValues({ form, memberEntity, orgEntity: null, primaryEntity: memberEntity }),
    {}
  );
});
