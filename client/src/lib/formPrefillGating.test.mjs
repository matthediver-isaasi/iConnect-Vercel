// Tests for the shared prefill readiness gate (Task #3336).
// Guards against the race where a prefill entity resolves before its
// member/org custom-value queries, which would latch prefillApplied and
// permanently skip custom-field prefills on EmbedForm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWaitForPrefillCustomValues, resolveEffectivePrefillIds, buildPrefillValues } from './formFieldPrefill.js';

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
