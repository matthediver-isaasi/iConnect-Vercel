import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicantConfigurationDigest, hashApplicantToken, verifyApplicantContinuation,
  loadSubmissionApplicantContinuation, bindApplicantContinuation,
  loadApplicantMemberScope, canIssueApplicantContinuation,
} from './formApplicantContinuation.js';

const form = { id: 'form', tenant_id: 'tenant', fields: [],
  mutation_access_policy: { version: 1, mode: 'applicant_continuation' } };
const token = 'a'.repeat(43);
const grant = { id: 'grant', tenant_id: 'tenant', form_id: 'form',
  organization_id: 'org', expires_at: '2099-01-01',
  configuration_digest: applicantConfigurationDigest(form) };
function dbFor(row) {
  const filters = [];
  const query = {
    select() { return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    async maybeSingle() { return { data: row, error: null }; },
  };
  return { from: () => query, filters };
}
test('digest is key-order invariant but changes with processing configuration', () => {
  assert.equal(applicantConfigurationDigest(form), applicantConfigurationDigest({
    mutation_access_policy: { mode: 'applicant_continuation', version: 1 },
    fields: [], tenant_id: 'tenant', id: 'form',
  }));
  assert.notEqual(applicantConfigurationDigest(form),
    applicantConfigurationDigest({ ...form, field_mappings: [{ target_field: 'name' }] }));
});
test('valid bearer is looked up only by hash and tenant/form', async () => {
  const db = dbFor(grant);
  assert.equal((await verifyApplicantContinuation({ db, form, token })).organization_id, 'org');
  assert.deepEqual(db.filters, [['tenant_id', 'tenant'], ['form_id', 'form'],
    ['token_hash', hashApplicantToken(token)]]);
});
test('bare IDs and expired/revoked/cross-tenant/config-changed grants fail closed', async () => {
  for (const supplied of ['org', '', null]) {
    await assert.rejects(verifyApplicantContinuation({ db: dbFor(grant), form, token: supplied }));
  }
  for (const altered of [
    null, { ...grant, revoked_at: '2026-01-01' }, { ...grant, expires_at: '2000-01-01' },
    { ...grant, tenant_id: 'other' }, { ...grant, form_id: 'other' },
    { ...grant, configuration_digest: 'changed' },
  ]) {
    await assert.rejects(verifyApplicantContinuation({ db: dbFor(altered), form, token }));
  }
});
test('processor uses persisted submission binding, not request signatures', async () => {
  const boundGrant = { ...grant, submission_id: 'submission', bound_at: '2026-01-01' };
  const db = dbFor(boundGrant);
  assert.equal(await loadSubmissionApplicantContinuation({ db, form, submissionId: 'submission' }), boundGrant);
  assert.ok(db.filters.some(([key, value]) => key === 'submission_id' && value === 'submission'));
});
test('bound delayed processing outlives admission expiry but does not revive invitation', async () => {
  const expired = { ...grant, expires_at: '2000-01-01', submission_id: 'submission', bound_at: '1999-12-01' };
  assert.equal(await loadSubmissionApplicantContinuation({
    db: dbFor(expired), form, submissionId: 'submission',
  }), expired);
  await assert.rejects(verifyApplicantContinuation({ db: dbFor(expired), form, token }));
  await assert.rejects(bindApplicantContinuation({
    db: { rpc: () => { throw new Error('must not bind'); } }, form, grant: expired, submissionId: 'new',
  }));
  await assert.rejects(loadSubmissionApplicantContinuation({
    db: dbFor({ ...expired, revoked_at: '2001-01-01' }), form, submissionId: 'submission',
  }));
});
test('missing grant table yields no processor authority, and bearer verification fails closed', async () => {
  const query = { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { error: { code: '42P01' } }; } };
  const db = { from: () => query };
  assert.equal(await loadSubmissionApplicantContinuation({ db, form, submissionId: 'submission' }), null);
  await assert.rejects(verifyApplicantContinuation({ db, form, token }));
});
test('legacy public org mutation contract can issue without changing form configuration', () => {
  assert.equal(canIssueApplicantContinuation({ mutation_access_policy: null,
    require_authentication: false, entity_pipelines: {
      organisations: [{ mappings: [
        { target_type: 'core', target_field: 'name', source_type: 'field', source_field_id: 'name' },
        { target_type: 'core', target_field: 'phone', source_type: 'field', source_field_id: 'phone' },
      ] }],
      members: [{}],
    } }), true);
  assert.equal(canIssueApplicantContinuation({ mutation_access_policy: null,
    require_authentication: false, entity_pipelines: { members: [{}] } }), false);
});
test('member scope is intersection of immutable issuance snapshot and current organization membership', async () => {
  const filters = [];
  const db = { from(table) {
    assert.equal(table, 'member');
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      order() { return this; }, async range() { return { data: [{ id: 'still-associated' }, { id: 'added-after-issue' }] }; } };
  } };
  assert.deepEqual(await loadApplicantMemberScope({ db, form,
    grant: { ...grant, member_ids: ['still-associated', 'moved-away'] } }), ['still-associated']);
  assert.deepEqual(filters, [['tenant_id', 'tenant'], ['organization_id', 'org']]);
  assert.deepEqual(await loadApplicantMemberScope({ db, form, grant }), []);
});
test('atomic bind rejection cannot grant replay on another submission', async () => {
  await assert.rejects(bindApplicantContinuation({
    db: { rpc: async () => ({ data: false }) }, form, grant, submissionId: 'other',
  }));
});