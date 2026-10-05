import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicTicketMemberSnapshot, publicTicketIdentity,
  assertPublicTicketRole, preflightPublicTicketMembers,
  lookupPublicTicketMemberEmails,
  validatePublicTicketMemberPolicyWrite,
} from './publicTicketMemberCreation.js';

const tenantId = 'tenant-a';
const role = { id: 'role-a', tenant_id: tenantId };
const buyer = { first_name: 'Ada', last_name: 'Lovelace', email: ' ADA@EXAMPLE.COM ', organization: 'Analytical' };
const attendee = { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com', organization: 'Independent' };
const ticket = { id: 'ticket-a', visibility_mode: 'public_only', create_member_records: true, new_member_role_id: role.id };
const args = () => ({ tenantId, purchaser: buyer, items: [{ ticket, attendees: [attendee] }], roles: [role] });
const rejectsCode = code => error => error.code === code;

test('snapshot preserves independent buyer and attendee organisations; strips arbitrary authority', () => {
  const snapshot = buildPublicTicketMemberSnapshot(args());
  assert.equal(snapshot.people.length, 2);
  assert.equal(snapshot.people[0].identity.email, 'ada@example.com');
  assert.equal(snapshot.people[1].identity.organization, 'Independent');
  assert.deepEqual(publicTicketIdentity({ ...buyer, organization_id: 'forged', is_admin: true }), snapshot.purchaser);
});

test('same person deduplicates without losing purchaser and attendee links', () => {
  const input = args();
  input.items[0].attendees = [{ ...buyer, email: 'ada@example.com' }];
  const result = buildPublicTicketMemberSnapshot(input);
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.people[0].links.map(link => link.kind), ['purchaser', 'attendee']);
});

test('disabled ticket attendees are excluded and default-off needs no identities', () => {
  const input = args();
  input.items.push({ ticket: { id: 'off', create_member_records: false }, attendees: [{}] });
  assert.equal(buildPublicTicketMemberSnapshot(input).people.length, 2);
  assert.equal(buildPublicTicketMemberSnapshot({ ...input, purchaser: null, items: [input.items[1]] }), null);
});

test('missing explicit buyer and missing attendee organisation fail; no implicit fallback', () => {
  assert.throws(() => buildPublicTicketMemberSnapshot({ ...args(), purchaser: null }), rejectsCode('IDENTITY_REQUIRED'));
  const input = args();
  input.items[0].attendees = [{ ...attendee, organization: '' }];
  assert.throws(() => buildPublicTicketMemberSnapshot(input), rejectsCode('IDENTITY_REQUIRED'));
});

test('role and identity conflicts reject rather than selecting arbitrary privilege', () => {
  const input = args();
  input.items[0].attendees = [{ ...buyer, first_name: 'Different' }];
  assert.throws(() => buildPublicTicketMemberSnapshot(input), rejectsCode('IDENTITY_CONFLICT'));
  const secondRole = { ...role, id: 'role-b' };
  const conflict = args();
  conflict.roles.push(secondRole);
  conflict.items.push({ ticket: { ...ticket, id: 'second', new_member_role_id: secondRole.id }, attendees: [attendee] });
  assert.throws(() => buildPublicTicketMemberSnapshot(conflict), rejectsCode('ROLE_CONFLICT'));
});

test('cross-tenant, privileged, capacity and evidence-dependent roles are refused', () => {
  for (const override of [
    { tenant_id: 'other' }, { is_admin: true }, { is_tenant_admin: true },
    { requires_effective_from_date: true }, { max_members: 0 },
    { max_members: 100 }, { requires_organization: true },
  ]) assert.throws(() => assertPublicTicketRole({ ...role, ...override }, tenantId), rejectsCode('ROLE_NOT_PROVISIONABLE'));
  assert.throws(() => assertPublicTicketRole(null, tenantId), rejectsCode('ROLE_NOT_PROVISIONABLE'));
});

test('invalid visibility cannot enable provisioning', () => {
  const input = args();
  input.items[0].ticket = { ...ticket, visibility_mode: 'members_and_public' };
  assert.throws(() => buildPublicTicketMemberSnapshot(input), rejectsCode('INVALID_TICKET_POLICY'));
});

test('eligibility RPC binds normalized literal addresses with wildcard characters unchanged', async () => {
  let called;
  const db = { rpc: async (name, values) => { called = { name, values }; return { data: [] }; } };
  await lookupPublicTicketMemberEmails(db, tenantId, [' A_*%\\@Example.com ', 'a_*%\\@example.com']);
  assert.deepEqual(called, {
    name: 'lookup_public_ticket_member_emails',
    values: { p_tenant_id: tenantId, p_emails: ['a_*%\\@example.com'] },
  });
});

test('lookup failures and malformed responses fail closed', async () => {
  for (const response of [{ data: null }, { data: [], error: { message: 'offline' } }]) {
    await assert.rejects(lookupPublicTicketMemberEmails({ rpc: async () => response }, tenantId, [buyer.email]), rejectsCode('ELIGIBILITY_UNAVAILABLE'));
  }
});

test('authenticated same-tenant members cannot use public-only checkout', async () => {
  await assert.rejects(preflightPublicTicketMembers({
    ...args(), authenticatedMember: { tenant_id: tenantId }, db: { rpc() { throw new Error('must not query'); } },
  }), rejectsCode('PUBLIC_ONLY_MEMBER'));
});

test('existing purchaser or enabled attendee is rejected without member details', async () => {
  for (const [email, code] of [['ada@example.com', 'PUBLIC_ONLY_MEMBER'], ['grace@example.com', 'ATTENDEE_ALREADY_MEMBER']]) {
    await assert.rejects(preflightPublicTicketMembers({
      ...args(), db: { rpc: async () => ({ data: [{ normalized_email: email }] }) },
    }), rejectsCode(code));
  }
});

test('another tenant membership alone does not block; successful preflight retains snapshot', async () => {
  const result = await preflightPublicTicketMembers({
    ...args(), authenticatedMember: { tenant_id: 'other' }, db: { rpc: async () => ({ data: [] }) },
  });
  assert.equal(result.people.length, 2);
});

test('policy configuration requires authorization before role lookup', async () => {
  await assert.rejects(validatePublicTicketMemberPolicyWrite({
    db: { from() { throw new Error('must not query'); } }, tenantId,
    tickets: [ticket], authorizedToAssignRoles: false,
  }), rejectsCode('ROLE_ASSIGNMENT_FORBIDDEN'));
});

test('authorized policy configuration still validates tenant role and fails closed on lookup errors', async () => {
  const dbFor = response => ({ from(table) {
    assert.equal(table, 'role');
    return { select() { return this; }, eq(key, value) {
      assert.equal(key, 'tenant_id'); assert.equal(value, tenantId); return this;
    }, async in(key, values) { assert.equal(key, 'id'); assert.deepEqual(values, [role.id]); return response; } };
  } });
  const input = { tenantId, tickets: [ticket], authorizedToAssignRoles: true };
  await validatePublicTicketMemberPolicyWrite({ ...input, db: dbFor({ data: [role] }) });
  await assert.rejects(validatePublicTicketMemberPolicyWrite({ ...input, db: dbFor({ data: [] }) }), rejectsCode('ROLE_NOT_PROVISIONABLE'));
  await assert.rejects(validatePublicTicketMemberPolicyWrite({ ...input, db: dbFor({ error: { message: 'unavailable' } }) }), rejectsCode('ROLE_VALIDATION_UNAVAILABLE'));
});
