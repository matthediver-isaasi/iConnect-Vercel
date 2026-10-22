import test from 'node:test';
import assert from 'node:assert/strict';
import { programRegistrationFingerprint, programRegistrationReplay } from './programRegistrationAttempt.js';
import { resolveProgramRegistrationAttempt, finishProgramRegistrationAttempt, hasProgramRegistrationAttempt } from '../../client/src/lib/programRegistrationAttempt.mjs';
import { restoreProgramBookingEntitlement } from './bookingLookup.js';
import { programRegistrationIdentity } from '../../shared/programRegistrationIdentity.js';

test('programme registration IDs survive retries and stored session restoration', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key) };
  const args = { memberId: 'member', eventId: 'event', payload: { programTicketOwner: 'member', attendees: [{ email: 'a' }], registrationMode: 'self' }, storage };
  assert.equal(resolveProgramRegistrationAttempt({ ...args, createId: () => 'stable' }), 'stable');
  assert.equal(hasProgramRegistrationAttempt(args), true);
  assert.equal(resolveProgramRegistrationAttempt({ ...args, createId: () => assert.fail('must retain ID') }), 'stable');
  assert.equal(resolveProgramRegistrationAttempt({ ...args, payload: { ...args.payload, attendees: [{ email: 'a', isValid: true, validationStatus: 'loaded' }] },
    createId: () => assert.fail('UI hydration must not create another attempt') }), 'stable');
  assert.equal(resolveProgramRegistrationAttempt({ ...args, payload: { ...args.payload, programTicketOwner: 'organization' }, createId: () => 'new-owner' }), 'new-owner');
  entries.set('program-registration:restored:event', JSON.stringify({ id: 'stored',
    fingerprint: JSON.stringify({ owner: args.payload.programTicketOwner, ...programRegistrationIdentity(args.payload) }) }));
  assert.equal(resolveProgramRegistrationAttempt({ ...args, memberId: 'restored', createId: () => assert.fail('must load persisted ID') }), 'stored');
  finishProgramRegistrationAttempt({ memberId: 'restored', eventId: 'event', attemptId: 'stored', storage });
  assert.equal(resolveProgramRegistrationAttempt({ ...args, memberId: 'restored', createId: () => 'acknowledged-new-booking' }), 'acknowledged-new-booking');
});

test('server binding covers selected owner, identity, event and attendees, not forged ticket count', () => {
  const args = { tenantId: 'tenant', memberId: 'member', eventId: 'event', owner: 'member',
    params: { registrationMode: 'self', attendees: [{ email: 'a', first_name: 'A' }], ticketsRequired: 1 } };
  const fingerprint = programRegistrationFingerprint(args);
  assert.equal(programRegistrationFingerprint({ ...args, params: { ...args.params, ticketsRequired: -99 } }), fingerprint);
  for (const changed of [{ owner: 'organization' }, { memberId: 'other' }, { eventId: 'other' },
    { params: { ...args.params, attendees: [{ email: 'b' }] } }]) {
    assert.notEqual(programRegistrationFingerprint({ ...args, ...changed }), fingerprint);
  }
  assert.equal(programRegistrationReplay({ bookings: [{ id: 'saved' }], new_balance: 2 }, 'reference').bookings[0].id, 'saved');
});

test('existing booking lookup restoration delegates by original booking provenance, not current organization', async () => {
  let call;
  const result = await restoreProgramBookingEntitlement({
    id: 'booking', tenant_id: 'tenant', program_entitlement_transaction_id: 'usage', organization_id: 'new-org',
  }, 'tenant', { rpc: async (...args) => { call = args; return { data: { handled: true, success: true } }; } });
  assert.equal(result.success, true);
  assert.deepEqual(call, ['restore_program_booking_entitlement', { p_tenant_id: 'tenant', p_booking_id: 'booking' }]);
  await assert.rejects(restoreProgramBookingEntitlement({ id: 'booking', tenant_id: 'foreign', program_entitlement_transaction_id: 'usage' }, 'tenant'), /tenant mismatch/);
});
