import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isPrivateTicket, isPrivateTicketEligible, serializeTicketAudience } from '../../shared/ticketAudience.js';
import { isTicketAccessibleToMember } from './ticketAccess.js';

const memberId = '12345678-1234-1234-1234-123456789012';
const otherId = '22345678-1234-1234-1234-123456789012';
const ticket = { id: 'private', audience_mode: 'selected_members', selected_member_ids: [memberId] };
const event = { id: 'event', tenant_id: 'tenant' };
const viewer = { memberId, tenantId: 'tenant' };
// Replace only session IO. The policy and injected DB adapter remain real.
const source = (await readFile(new URL('./privateTicketAccess.js', import.meta.url), 'utf8'))
  .replace("import { getSession } from './session.js';", 'const getSession = async req => req.verifiedSession || null;')
  .replace("import { hasAdminAccess } from './tenantContext.js';", 'const hasAdminAccess = async ctx => ctx.admin === true;')
  .replace("'../../shared/ticketAudience.js'", JSON.stringify(new URL('../../shared/ticketAudience.js', import.meta.url).href));
const { loadPrivateTicketViewer, assertPrivateTicketsAccessible, assertSimplePrivateTicketsAccessible, assertGenericPrivateTicketBooking } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function db(member, error = null) {
  return { from(table) {
    assert.equal(table, 'member');
    return { select() { return this; }, eq(key, id) {
      assert.equal(key, 'id'); assert.equal(id, memberId); return this;
    }, async maybeSingle() { return { data: member, error }; } };
  } };
}
const req = { verifiedSession: { data: { memberId } } };
const base = () => ({ req, db: db({ id: memberId, tenant_id: 'tenant' }), event,
  tickets: [ticket], ticketIds: ['private'] });

test('private audience requires canonical selected identity and tenant; legacy defaults unchanged', () => {
  assert.equal(isPrivateTicket({}), false);
  assert.equal(isPrivateTicketEligible(ticket, viewer, 'tenant'), true);
  for (const person of [null, {}, { memberId: otherId, tenantId: 'tenant' }, { ...viewer, tenantId: 'other' }]) {
    assert.equal(isPrivateTicketEligible(ticket, person, 'tenant'), false);
  }
  for (const ids of [null, [], 'all', ['not-a-uuid'], [memberId, 'bad']]) {
    assert.equal(isPrivateTicketEligible({ ...ticket, selected_member_ids: ids }, viewer, 'tenant'), false);
  }
  assert.equal(isPrivateTicketEligible({ ...ticket, tenant_id: 'other' }, viewer, 'tenant'), false);
  assert.equal(isTicketAccessibleToMember({ ticketClass: {} }), true);
  assert.equal(isTicketAccessibleToMember({ ticketClass: { ...ticket, role_match_only: true, role_ids: ['admin'] }, memberRoleId: 'admin' }), false);
  assert.equal(isTicketAccessibleToMember({ ticketClass: ticket, ...viewer, ticketTenantId: 'tenant' }), true);
});

test('serializer is full ticket projection and never leaks list or stale eligibility', () => {
  assert.deepEqual(serializeTicketAudience({ ...ticket, private_ticket_eligible: true }, false),
    { id: 'private', audience_mode: 'selected_members' });
  assert.equal(serializeTicketAudience(ticket, true).private_ticket_eligible, true);
  assert.deepEqual(serializeTicketAudience({ id: 'legacy', selected_member_ids: [memberId], private_ticket_eligible: true }, true),
    { id: 'legacy', audience_mode: 'legacy' });
});

test('viewer uses verified session and direct canonical tenant ownership, never inherited or submitted identity', async () => {
  assert.equal(await loadPrivateTicketViewer({ body: { memberId } }, 'tenant', db(null)), null);
  assert.equal(await loadPrivateTicketViewer(req, 'tenant', db({ id: memberId, organization: { tenant_id: 'tenant' } })), null);
  for (const row of [null, { id: memberId, tenant_id: 'other', organization: { tenant_id: 'tenant' } },
    { id: memberId, tenant_id: 'tenant', login_enabled: false }, { id: memberId, tenant_id: 'tenant', membership_paused: true }]) {
    assert.equal(await loadPrivateTicketViewer(req, 'tenant', db(row)), null);
  }
  await assert.rejects(loadPrivateTicketViewer(req, 'tenant', db(null, new Error('offline'))), /Unable to verify/);
});

test('every requested ticket checked; roles, emails, flags and allocation for a different ticket cannot bypass', async () => {
  assert.deepEqual(await assertPrivateTicketsAccessible(base()), [ticket]);
  await assert.rejects(assertPrivateTicketsAccessible({ ...base(), req: { body: { memberId, private_ticket_eligible: true } } }), /access/);
  await assert.rejects(assertPrivateTicketsAccessible({ ...base(), tickets: [ticket, { ...ticket, id: 'second', selected_member_ids: [otherId] }],
    ticketIds: ['private', 'second'] }), /access/);
  await assert.rejects(assertPrivateTicketsAccessible({ ...base(), ticketIds: ['forged'] }), /valid ticket/);
  const allocationContext = { tenantId: 'tenant', eventId: 'event', eventKind: 'simple', ticketTypeId: 'private' };
  assert.deepEqual(await assertPrivateTicketsAccessible({ ...base(), req: {}, allocationContext }), [ticket]);
  for (const change of [{ tenantId: 'other' }, { eventId: 'other' }, { eventKind: 'complex' }, { ticketTypeId: 'other' }]) {
    await assert.rejects(assertPrivateTicketsAccessible({ ...base(), req: {}, allocationContext: { ...allocationContext, ...change } }), /access/);
  }
});

test('simple legacy default remains valid but malformed or configured tickets fail closed', async () => {
  assert.deepEqual(await assertSimplePrivateTicketsAccessible({ ...base(), event, ticketIds: ['default'] }), [null]);
  for (const pricing_config of ['{bad', { ticket_classes: 'bad' }]) {
    await assert.rejects(assertSimplePrivateTicketsAccessible({ ...base(), event: { ...event, pricing_config } }), /Unable to verify/);
  }
  await assert.rejects(assertSimplePrivateTicketsAccessible({ ...base(), event: { ...event, pricing_config: { ticket_classes: [ticket] } }, ticketIds: ['default'] }), /valid ticket/);
});

test('generic registration inserts and reassignment use authoritative ticket policy; admin imports remain exempt', async () => {
  function bookingDb() {
    return { from(table) {
      const rows = table === 'member' ? [{ id: memberId, tenant_id: 'tenant' }]
        : table === 'complex_event_ticket_class' ? [{ ...ticket, tenant_id: 'tenant', complex_event_id: event.id }]
          : [{ ...event, pricing_config: { ticket_classes: [ticket, { id: 'legacy' }] } }];
      const filters = [];
      let single = false;
      return {
        select() { return this; }, eq(key, value) { filters.push(row => row[key] === value); return this; },
        maybeSingle() { single = true; return this; },
        then(ok, fail) {
          const selected = rows.filter(row => filters.every(filter => filter(row)));
          return Promise.resolve({ data: single ? selected[0] || null : selected, error: null }).then(ok, fail);
        },
      };
    } };
  }
  for (const entity of ['Booking', 'ComplexEventBooking']) {
    const options = { req: {}, db: bookingDb(), tenantCtx: { isAuthenticated: true, tenantId: 'tenant' },
      entity, body: { event_id: 'event', ticket_class_id: 'private' } };
    await assert.rejects(assertGenericPrivateTicketBooking(options), /access/);
    await assertGenericPrivateTicketBooking({ ...options, req });
    await assert.rejects(assertGenericPrivateTicketBooking({ ...options,
      existing: { event_id: 'event', ticket_class_id: 'legacy' }, body: { ticket_class_id: 'private' } }), /access/);
    await assert.rejects(assertGenericPrivateTicketBooking({ ...options, body: { ...options.body, tenant_id: 'foreign' } }), /verify booking/);
    await assertGenericPrivateTicketBooking({ ...options, db: { from() { throw new Error('Admin exemption must not inspect imports'); } },
      tenantCtx: { ...options.tenantCtx, admin: true } });
  }
  await assertGenericPrivateTicketBooking({ req: {}, db: bookingDb(), tenantCtx: { tenantId: 'tenant' },
    entity: 'Booking', body: { event_id: 'event', ticket_class_id: 'legacy' } });
});
