import test from 'node:test';
import assert from 'node:assert/strict';
import { allAffiliationRows, originalAffiliationProposal } from './formAffiliationReview.js';
import handler from '../forms/member-affiliation-review.js';

test('complete option lists paginate and reject truncated or failed reads', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: String(i) }));
  assert.equal((await allAffiliationRows(() => ({
    order() { return this; }, range(a, b) { return { data: rows.slice(a, b + 1), count: rows.length }; },
  }))).length, 501);
  for (const result of [{ data: [], count: 1 }, { error: {} }, { data: [], count: 10001 }]) {
    await assert.rejects(allAffiliationRows(() => ({ order() { return this; }, range() { return result; } })));
  }
});
test('proposal preserves original organisation, department and secondary sets', () => {
  assert.deepEqual(originalAffiliationProposal({
    member_id: 'm', config: { memberDepartmentDefinitionId: 'dept', secondaryMemberDefinitionId: 'assignment',
      secondaryOrganizationDefinitionId: 'org' },
    graph: { organization_id: 'primary', links: [
      { relationship_definition_id: 'dept', source_record_id: 'd', target_record_id: 'm' },
      { relationship_definition_id: 'assignment', source_record_id: 'm', target_record_id: 'a' },
    ], recordLinks: [{ relationship_definition_id: 'org', source_record_id: 'secondary', target_record_id: 'a' }] },
  }), { primary: 'primary', departments: ['d'], secondary: ['secondary'] });
  assert.throws(() => originalAffiliationProposal({ config: {}, graph: {} }));
});

const submissionId = '11111111-1111-4111-8111-111111111111';
function response() {
  return { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
}
function dependencies({ allowed = true, linkage = 'sub' } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const q = { select() { return q; }, eq(key, value) { calls.push([table, key, value]); return q; },
        maybeSingle: async () => ({ data: table === 'form_member_affiliation_review'
          ? { id: 'review', review_form_submission_id: 'sub' } : { form_submission_id: linkage } }) };
      return q;
    },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: { status: 'saved' } }; },
  };
  return { calls, db, getTenantContext: async () => ({ tenantId: 'tenant' }),
    hasAdminAccess: async () => allowed, getSessionMember: async () => ({ id: 'admin' }),
    loadAffiliationReview: async () => ({ active: true }) };
}
test('review endpoint denies non-admin before any data access', async () => {
  const deps = dependencies({ allowed: false }), res = response();
  await handler({ method: 'GET', query: { submission_id: submissionId } }, res, deps);
  assert.equal(res.statusCode, 403); assert.deepEqual(deps.calls, []);
});
test('resolution save uses trusted tenant and actor, never browser identities', async () => {
  const deps = dependencies(), res = response();
  await handler({ method: 'PUT', body: { submission_id: submissionId, expectedVersion: 2,
    resolution: { primary: null, departments: [], secondary: [] }, tenantId: 'attacker', actor: 'attacker' } }, res, deps);
  assert.equal(res.statusCode, 200);
  const call = deps.calls.find(c => c.name);
  assert.equal(call.args.p_tenant_id, 'tenant'); assert.equal(call.args.p_actor, 'admin');
  assert.equal(call.args.p_expected_version, 2);
  assert.equal(call.name, 'save_form_member_affiliation_resolution');
});
test('mismatched case and invalid versions never write a resolution', async () => {
  for (const [deps, expectedVersion] of [[dependencies({ linkage: 'wrong' }), 0], [dependencies(), -1]]) {
    const res = response();
    await handler({ method: 'PUT', body: { submission_id: submissionId, expectedVersion } }, res, deps);
    assert.ok(res.statusCode >= 400); assert.equal(deps.calls.some(c => c.name), false);
  }
});
test('an authorized team administrator can save without a member account', async () => {
  const deps = dependencies();
  deps.getSessionMember = async () => null;
  deps.getSessionTenantUser = async () => ({ id: 'team-administrator' });
  const res = response();
  await handler({ method: 'PUT', body: { submission_id: submissionId, expectedVersion: 0,
    resolution: { primary: null, departments: [], secondary: [] } } }, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.calls.find(c => c.name).args.p_actor, 'team-administrator');
});
