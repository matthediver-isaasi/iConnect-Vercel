import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveFormPaymentOrganization } from './formPaymentOrganization.js';

function dbFixture(org) {
  return { from(table) {
    assert.equal(table, 'organization');
    const filters = {};
    const q = {
      select() { return q; },
      eq(k, v) { filters[k] = v; return q; },
      async maybeSingle() {
        assert.equal(filters.tenant_id, 'tenant');
        return { data: org && org.id === filters.id && org.tenant_id === filters.tenant_id ? org : null };
      },
    };
    return q;
  } };
}

test('existing tenant organization is a valid authoritative creation target without a pipeline', async () => {
  assert.equal(await resolveFormPaymentOrganization(dbFixture({ id: 'org', tenant_id: 'tenant' }), 'tenant', 'org'), 'org');
});
test('missing or cross-tenant organization fails closed', async () => {
  for (const org of [null, { id: 'org', tenant_id: 'other' }]) {
    await assert.rejects(resolveFormPaymentOrganization(dbFixture(org), 'tenant', 'org'), /does not belong/);
  }
  assert.equal(await resolveFormPaymentOrganization({}, 'tenant', '__form_not_listed__'), null);
});
test('creation uses normalized validated target for quote and new insert only', async () => {
  const source = await readFile(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  assert.match(source, /organizationId = await resolveFormPaymentOrganization\(supabase, tenantData.id, prefill_organization_id\)/);
  assert.match(source, /simulateMembershipForOrg\(tenantData.id, organizationId,/);
  assert.match(source, /if \(!submissionRow\)[\s\S]*const insertRecord[\s\S]*organization_id: resolved.organizationId/);
  assert.equal((source.match(/organization_id: resolved.organizationId/g) || []).length, 1);
});