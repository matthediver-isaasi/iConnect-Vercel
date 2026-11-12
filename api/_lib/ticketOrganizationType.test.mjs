import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTicketOrganizationTypes } from './ticketOrganizationType.js';
import { isTicketAccessibleToMember, ticketHasAccessRestrictions } from './ticketAccess.js';
import { validateTicketAudienceWrite } from './ticketAudienceWrite.js';
import { filterViewerTickets, projectSimpleTicketAudience } from '../../shared/ticketAudienceProjection.js';
import { organizationTypeOptions } from '../../shared/ticketOrganizationType.js';
import { ticketMemberPolicy, updateTicketMemberField } from '../../client/src/utils/publicTicketMembers.js';
import { reconcilePrivateCart } from '../../client/src/utils/privateTicketAudience.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1), memberId = id(2), orgId = id(3), fieldId = id(4);
const event = { id: id(5), tenant_id: tenantId };
const policy = { id: 'ticket', organization_type_enabled: true,
  organization_type_field_id: fieldId, organization_type_values: ['hospital'] };
const viewer = { memberId, tenantId, organizationTypes: {
  [fieldId]: { options: ['hospital', 'university'], values: ['hospital'] },
} };
const source = (await readFile(new URL('./privateTicketAccess.js', import.meta.url), 'utf8'))
  .replace("import { getSession } from './session.js';", 'const getSession = async req => req.session;')
  .replace("import { hasAdminAccess } from './tenantContext.js';", 'const hasAdminAccess = async () => false;')
  .replace(/from '(\.[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, import.meta.url).href)}`);
const { assertPrivateTicketsAccessible } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function database(changes = {}, failTable) {
  const seed = {
    member: [{ id: memberId, tenant_id: tenantId, organization_id: orgId, role_id: 'role' }],
    organization: [{ id: orgId, tenant_id: tenantId }],
    preference_field: [{ id: fieldId, tenant_id: tenantId, entity_scope: 'organization',
      name: 'org_type', is_active: true, options: ['hospital', { value: 'university', label: 'University' }] }],
    organization_preference_value: [{ organization_id: orgId, field_id: fieldId, value: '["hospital"]' }],
    member_group_assignment: [{ member_id: memberId, group_id: 'group' }],
    complex_event: [event], ...changes,
  };
  return { from(table) {
    let filters = [], single = false;
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        const rows = (seed[table] || []).filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: single ? rows[0] || null : rows,
          error: failTable === table ? new Error('Read failed') : null }).then(resolve, reject);
      },
    }; return q;
  } };
}

test('unrestricted, role-only, type-only and AND matrix preserves role/group OR', () => {
  assert.equal(ticketHasAccessRestrictions(policy), true);
  assert.equal(isTicketAccessibleToMember({ ticketClass: {} }), true);
  for (const typeMatches of [false, true]) for (const roleMatches of [false, true]) {
    const organizationTypeViewer = typeMatches ? viewer : { ...viewer, organizationTypes: {} };
    const args = { tenantId, organizationTypeViewer, memberRoleId: roleMatches ? 'role' : 'other' };
    assert.equal(isTicketAccessibleToMember({ ...args, ticketClass: policy }), typeMatches);
    assert.equal(isTicketAccessibleToMember({ ...args, ticketClass: { role_match_only: true, role_ids: ['role'] } }), roleMatches);
    assert.equal(isTicketAccessibleToMember({ ...args, ticketClass: { ...policy, role_match_only: true, role_ids: ['role'] } }), typeMatches && roleMatches);
    assert.equal(isTicketAccessibleToMember({ ...args, memberGroupIds: ['group'], ticketClass: {
      ...policy, role_match_only: true, role_ids: ['role'], member_group_ids: ['group'],
    } }), typeMatches);
  }
  for (const organizationTypeViewer of [null, { ...viewer, tenantId: id(9) }, { ...viewer, memberId: null }]) {
    assert.equal(isTicketAccessibleToMember({ ticketClass: policy, organizationTypeViewer, tenantId }), false);
  }
  for (const values of [[], ['removed'], ['hospital', 'removed'], 'hospital']) {
    assert.equal(isTicketAccessibleToMember({ ticketClass: { ...policy, organization_type_values: values }, organizationTypeViewer: viewer, tenantId }), false);
  }
  assert.equal(isTicketAccessibleToMember({ ticketClass: { ...policy, organization_type_values: ['university', 'hospital'] }, organizationTypeViewer: viewer, tenantId }), true);
  assert.deepEqual(organizationTypeOptions('["A",{"value":2,"label":"Two"},true]'), [
    { value: 'A', label: 'A' }, { value: '2', label: 'Two' }, { value: 'true', label: 'true' },
  ]);
});

test('resolver follows only primary organisation; tenant, field scope, active state and read failures fail closed', async () => {
  assert.deepEqual(await loadTicketOrganizationTypes(database(), tenantId, memberId), viewer.organizationTypes);
  for (const changes of [
    { member: [] }, { member: [{ id: memberId, tenant_id: tenantId }] },
    { member: [{ id: memberId, tenant_id: id(9), organization_id: orgId }] },
    { organization: [{ id: orgId, tenant_id: id(9) }] }, { preference_field: [] },
    { preference_field: [{ id: fieldId, tenant_id: tenantId, entity_scope: 'member', name: 'org_type', is_active: true, options: ['hospital'] }] },
    { preference_field: [{ id: fieldId, tenant_id: tenantId, entity_scope: 'organization', name: 'org_type', is_active: false, options: ['hospital'] }] },
  ]) assert.deepEqual(await loadTicketOrganizationTypes(database(changes), tenantId, memberId), {});
  for (const table of ['member', 'organization', 'preference_field', 'organization_preference_value']) {
    assert.deepEqual(await loadTicketOrganizationTypes(database({}, table), tenantId, memberId), {});
  }
  for (const value of ['hospital', '"hospital"', ['university', 'hospital'], { value: ['hospital'] }]) {
    const result = await loadTicketOrganizationTypes(database({ organization_preference_value: [{ organization_id: orgId, field_id: fieldId, value }] }), tenantId, memberId);
    assert.ok(result[fieldId].values.includes('hospital'));
  }
});

test('save/reopen both storage models across training and delivery variants; pin field and reject invalid writes', async () => {
  for (const is_training of [false, true]) for (const delivery of ['online', 'offline']) {
    for (const ticket of [policy, { ...policy, role_match_only: true, role_ids: ['role'] }, { role_match_only: true, role_ids: ['role'] }]) {
      const saved = await validateTicketAudienceWrite({ db: database(), tenantId, entity: 'Event',
        body: { is_training, delivery, pricing_config: JSON.stringify({ ticket_classes: [ticketMemberPolicy(ticket), ticket] }) } });
      assert.deepEqual(JSON.parse(saved.pricing_config).ticket_classes[1], ticket);
    }
  }
  const complex = await validateTicketAudienceWrite({ db: database(), tenantId, entity: 'ComplexEventTicketClass',
    body: { ...policy, complex_event_id: event.id } });
  assert.deepEqual(ticketMemberPolicy(complex).organization_type_values, ['hospital']);
  for (const patch of [
    { organization_type_values: [] }, { organization_type_values: ['removed'] },
    { organization_type_field_id: id(9) }, { organization_type_enabled: 'true' },
    { audience_mode: 'selected_members', selected_member_ids: [] },
  ]) await assert.rejects(validateTicketAudienceWrite({ db: database(), tenantId, entity: 'ComplexEventTicketClass',
    existingRow: { ...policy, tenant_id: tenantId }, body: patch }), /Organisation Type|organisation|Organization/);
  await assert.rejects(validateTicketAudienceWrite({ db: database({}, 'preference_field'), tenantId, entity: 'Event',
    body: { pricing_config: { ticket_classes: [policy] } } }), /Unable to load/);
  const privatePolicy = updateTicketMemberField(policy, 'audience_mode', 'selected_members');
  assert.equal(privatePolicy.organization_type_enabled, false);
  assert.deepEqual(privatePolicy.organization_type_values, []);
});

test('redacted discovery recalculates forged/stale browser flags and cart selection', () => {
  const forged = { ...policy, organization_type_eligible: true };
  const [guest] = filterViewerTickets([forged], null, tenantId);
  assert.equal(guest.organization_type_eligible, false);
  assert.equal(filterViewerTickets([policy], viewer, tenantId)[0].organization_type_eligible, true);
  const projected = projectSimpleTicketAudience({ pricing_config: { ticket_classes: [policy] } }, viewer, tenantId);
  assert.equal(projected.pricing_config.ticket_classes[0].organization_type_eligible, true);
  assert.equal(JSON.stringify(projected).includes('organizationTypes'), false);
  assert.deepEqual(reconcilePrivateCart({ ticket: { ticketClass: forged } }, [guest], { id: memberId }), {});
});

test('server checks every cart ticket and rejects forged identity before returning; exact purchased entitlement survives', async () => {
  const args = { req: { session: { data: { memberId } } }, db: database(), event,
    tickets: [{ ...policy, role_match_only: true, role_ids: ['role'] }], ticketIds: ['ticket'] };
  assert.equal((await assertPrivateTicketsAccessible(args)).length, 1);
  await assert.rejects(assertPrivateTicketsAccessible({ ...args, req: { body: { memberId, organization_type_eligible: true } } }), /Organisation Type/);
  await assert.rejects(assertPrivateTicketsAccessible({ ...args, tickets: [{ ...policy, role_match_only: true, role_ids: ['other'] }] }), /access/);
  const denied = { ...policy, id: 'denied', organization_type_values: ['university'] };
  await assert.rejects(assertPrivateTicketsAccessible({ ...args, tickets: [policy, denied], ticketIds: ['ticket', 'denied'] }), /Organisation Type/);
  const allocationContext = { tenantId, eventId: event.id, eventKind: 'complex', ticketTypeId: 'denied' };
  assert.equal((await assertPrivateTicketsAccessible({ ...args, req: {}, tickets: [denied], ticketIds: ['denied'],
    eventKind: 'complex', allocationContext })).length, 1);
  await assert.rejects(assertPrivateTicketsAccessible({ ...args, req: {}, tickets: [policy, denied],
    ticketIds: ['denied', 'ticket'], eventKind: 'complex', allocationContext }), /Organisation Type/);
});
