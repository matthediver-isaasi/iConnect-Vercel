import test from 'node:test';
import assert from 'node:assert/strict';
import { completeMemberAffiliations, memberAffiliationPrefill } from './formMemberAffiliations.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(result = null) {
  const calls = [];
  const config = { version: 1, enabled: true, primaryOrganizationFieldIds: ['org'] };
  const snapshot = { id: id(1), config, member_id: id(2), result,
    expires_at: '2099-01-01', graph: { organization_id: id(3), links: [], records: [], recordLinks: [] } };
  const db = {
    from(table) {
      const q = { select() { return q; }, eq() { return q; },
        async maybeSingle() { return { data: table === 'form_member_affiliation_config' ? { config } : snapshot }; },
        async single() { return { data: { id: id(2), organization_id: id(5) } }; } };
      return q;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: { committed: true } }; },
  };
  return { calls, snapshot, context: { db, tenantId: id(10), memberId: id(2),
    form: { id: id(11), tenant_id: id(10), fields: [{ id: 'org', type: 'organisation_dropdown' }],
      require_authentication: true, mutation_access_policy: { mode: 'authenticated_owner' } },
    submission: { id: id(12), tenant_id: id(10), form_id: id(11), created_member_id: id(2),
      submission_data: { __member_affiliation_snapshot: id(1), org: id(4) } } } };
}
test('source execution binds first, then applies the complete canonical selection', async () => {
  const f = fixture();
  const result = await completeMemberAffiliations(f.context);
  assert.deepEqual(f.calls.map(c => c.name), ['form_member_affiliation_bind', 'form_member_affiliation_apply']);
  assert.equal(f.calls[1].args.p_primary, id(4));
  assert.deepEqual(f.calls[1].args.p_departments, []);
  assert.equal(result.status, 'applied');
  assert.equal(result.organizationId, id(5));
});
test('committed retry does not apply again or restore its historical organisation', async () => {
  const f = fixture({ committed: true });
  const result = await completeMemberAffiliations(f.context);
  assert.deepEqual(f.calls.map(c => c.name), ['form_member_affiliation_bind']);
  assert.equal(result.status, 'already_applied');
  assert.equal(result.organizationId, id(5));
});
test('unverified submission ownership fails before any RPC', async () => {
  const f = fixture(); f.context.submission.created_member_id = id(99);
  await assert.rejects(completeMemberAffiliations(f.context), /could not be verified/);
  assert.deepEqual(f.calls, []);
});
test('prefill exposes only configured answers, never the raw relationship graph', () => {
  const f = fixture();
  assert.deepEqual(memberAffiliationPrefill(f.snapshot), { values: { org: id(3) }, managedFieldIds: ['org'] });
});
