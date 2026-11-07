import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveFormMembershipOrganizationId } from './formMembershipOwner.js';

const member = { id: 'member', tenant_id: 'tenant', organization_id: 'org' };
function fixture(tables = {}, failedTable) {
  const calls = [];
  return { calls, from(table) {
    const filters = {};
    calls.push({ table, filters });
    return {
      select() { return this; },
      eq(key, value) { filters[key] = value; return this; },
      is(key, value) { filters[key] = value; return this; },
      async maybeSingle() {
        return { data: (tables[table] || []).find(row =>
          Object.entries(filters).every(([key, value]) => row[key] === value)) || null };
      },
      async limit() {
        if (table === failedTable) return { error: { code: 'unavailable' } };
        return { data: (tables[table] || []).filter(row =>
          Object.entries(filters).every(([key, value]) => row[key] === value)).slice(0, 1) };
      },
    };
  }};
}
test('personal membership history overrides organisation affiliation regardless of status', async () => {
  for (const status of ['active', 'pending', 'cancelled', 'expired']) {
    const db = fixture({ member_membership_history: [{ id: 'history', tenant_id: 'tenant', member_id: 'member', status }] });
    assert.equal(await resolveFormMembershipOrganizationId(db, 'tenant', member), null);
    assert.equal(db.calls.length, 1);
  }
});
test('personal billing agreement pins individual scope before a history exists', async () => {
  const db = fixture({ membership_billing_agreements: [{
    id: 'agreement', tenant_id: 'tenant', member_id: 'member', organization_id: null,
  }] });
  assert.equal(await resolveFormMembershipOrganizationId(db, 'tenant', member), null);
});
test('organisation payer agreements and foreign member history cannot select individual scope', async () => {
  const db = fixture({
    member_membership_history: [{ tenant_id: 'other', member_id: 'member' }, { tenant_id: 'tenant', member_id: 'other' }],
    membership_billing_agreements: [{ tenant_id: 'tenant', member_id: 'member', organization_id: 'org' }],
  });
  assert.equal(await resolveFormMembershipOrganizationId(db, 'tenant', member), 'org');
});
test('unaffiliated members stay individual and database failures cannot silently select organisation', async () => {
  const db = fixture();
  assert.equal(await resolveFormMembershipOrganizationId(db, 'tenant', { ...member, organization_id: null }), null);
  assert.equal(db.calls.length, 0);
  for (const table of ['member_membership_history', 'membership_billing_agreements']) {
    await assert.rejects(resolveFormMembershipOrganizationId(fixture({}, table), 'tenant', member), /could not be verified/);
  }
  await assert.rejects(resolveFormMembershipOrganizationId(db, 'foreign', member), /tenant/);
});
test('form quote, reservation and start paths share resolved ownership while confirmation keeps saved ownership', async () => {
  const source = await readFile(new URL('../forms/membership-payment.js', import.meta.url), 'utf8');
  assert.equal((source.match(/await resolveFormMembershipOrganizationId\(supabase, tenantId, member, req\)/g) || []).length, 2);
  assert.equal((source.match(/await renewalContext\(tenantId, member, organizationId, req, fieldOverrides\)/g) || []).length, 5);
  assert.equal((source.match(/await renewalContext\(tenantId, member, organizationId\)/g) || []).length, 1);
  assert.match(source, /memberId: context\.organizationId \? null : member\.id/);
  assert.match(source, /organizationId: context\.organizationId \|\| null/);
  assert.match(source, /const organizationId = saved \? saved\.organizationId/);
  assert.doesNotMatch(source, /simulate: member\.organization_id/);
});

test('saved personal schedule pins first membership to member despite organisation affiliation', async () => {
  const tables = {
    form: [{ id: 'form', tenant_id: 'tenant', is_active: true, require_authentication: true, fields: [
      { id: 'answer', type: 'radio', options: ['Associate'] },
      { id: 'payment', type: 'membership_payment', membership_schedule_mapping: {
        source_field_id: 'answer', entries: [{ value: 'Associate', config_id: 'personal' }],
      } },
    ] }],
    membership_tier_config: [{ id: 'personal', tenant_id: 'tenant', structure_scope_type: 'member' }],
  };
  for (const method of ['GET', 'POST']) {
    const input = { formId: 'form', paymentFieldId: 'payment', renewalScheduleAnswer: 'Associate' };
    const req = { method, query: input, body: input };
    assert.equal(await resolveFormMembershipOrganizationId(fixture(tables), 'tenant', member, req), null);
    assert.equal(req.resolvedFormRenewalSelection.configId, 'personal');
    input.renewalScheduleAnswer = 'Forged';
    await assert.rejects(resolveFormMembershipOrganizationId(fixture(tables), 'tenant', member, req), /valid answer/);
  }
});
