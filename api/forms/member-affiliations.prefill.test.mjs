import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './member-affiliations.js';

async function run({ directGroup = null, organizationError = false } = {}) {
  const calls = [];
  const config = { enabled: true, version: 1, prefillAffiliationQuestions: true,
    primaryOrganizationFieldIds: ['org'], organizationGroupFieldId: 'trust',
    countryFieldId: 'country', organizationCountryFieldId: 'country-definition',
    siteQuestionFieldId: 'site', additionalQuestionFieldId: 'additional' };
  const form = { id: 'form', tenant_id: 'tenant', is_active: true,
    require_authentication: true, member_affiliation_enabled: true,
    mutation_access_policy: { mode: 'authenticated_owner' }, fields: [] };
  const db = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(...args) { filters.push(args); return query; },
        maybeSingle() { return query.single(); },
        async single() {
          calls.push({ table, filters });
          if (table === 'form') return { data: form };
          if (table === 'form_member_affiliation_config') return { data: { config } };
          if (table === 'organization') return organizationError
            ? { error: new Error('unavailable') } : { data: { organization_group_id: 'org-group' } };
          if (table === 'organization_preference_value') return { data: { value: 'GB' } };
          throw new Error(`Unexpected read: ${table}`);
        },
      };
      return query;
    },
    async rpc(name) {
      calls.push({ rpc: name });
      return { data: { token: 'snapshot', config,
        graph: { organization_id: 'org-id', links: [], recordLinks: [] } } };
    },
  };
  let body, status;
  const res = { setHeader() {}, status(code) { status = code; return res; }, json(value) { body = value; return res; } };
  await handler({ method: 'GET', query: { form_id: 'form' } }, res, {
    db, getTenantContext: async () => ({ tenantId: 'tenant' }),
    getSession: async () => ({ data: { memberId: 'member' } }),
    getSessionMember: async () => ({ id: 'member', tenant_id: 'tenant', organization_group_id: directGroup }),
    resolveFormAccess: async () => ({ allowed: true }),
  });
  return { status, body, calls };
}

test('renewal captures its ordinary snapshot and resolves country/group controlling answers', async () => {
  const result = await run();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.values, { org: 'org-id', trust: 'org-group', country: 'United Kingdom',
    site: 'Yes', additional: 'No' });
  assert.deepEqual(result.calls.filter(c => c.rpc), [{ rpc: 'form_member_affiliation_capture' }]);
  assert.deepEqual(result.calls.find(c => c.table === 'organization').filters,
    [['tenant_id', 'tenant'], ['id', 'org-id']]);
});
test('direct member group wins and failed organisation lookup never becomes empty affiliations', async () => {
  assert.equal((await run({ directGroup: 'direct-group' })).body.values.trust, 'direct-group');
  const result = await run({ organizationError: true });
  assert.equal(result.status, 503);
  assert.equal(result.body.values, undefined);
});
