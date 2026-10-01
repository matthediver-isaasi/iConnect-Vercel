import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacySimpleHarness } from '../../tests/fixtures/ticketReleaseLegacyHandlers.mjs';
import { assertRequestedTicketsReleased, assertSimpleTicketsReleased } from '../_lib/ticketReleaseAccess.js';

const attendee = { email: 'guest@example.test', first_name: 'Legacy', last_name: 'Guest' };
const configurations = [
  ['absent pricing_config', undefined],
  ['null pricing_config', null],
  ['empty-string pricing_config', ''],
  ['legacy pricing fields', { member_price: 25, non_member_price: 25 }],
  ['empty classes', { ticket_classes: [] }],
];
for (const [label, pricing_config] of configurations) {
  for (const paid of [true, false]) {
    test(`actual simple default contract: ${label}, ${paid ? 'paid' : 'free'}`, async () => {
      const event = pricing_config === undefined ? {} : { pricing_config };
      const harness = createLegacySimpleHarness({ event });
      let stripePaymentIntentId = null;
      if (paid) {
        const payment = await harness.invoke('createStripePaymentIntent', {
          amount: 25, memberEmail: attendee.email,
          metadata: { event_id: 'event-a', ticket_class_id: 'default' },
        });
        assert.equal(payment.response.success, true, JSON.stringify(payment.response));
        stripePaymentIntentId = payment.response.paymentIntentId;
        assert.equal(harness.paymentIntents.get(stripePaymentIntentId).metadata.ticket_class_id, '');
      }
      // EventDetails selectedTicketClassId='default' becomes selectedTicketClass.id,
      // then PaymentOptions sends ticketClassId='default' to this endpoint.
      const booking = await harness.invoke('createOneOffEventBooking', {
        eventId: 'event-a', ticketsRequired: 1, totalCost: paid ? 25 : 0,
        ticketClassId: 'default', paymentMethod: paid ? 'card' : 'free',
        stripePaymentIntentId, isGuestBooking: true, guestInfo: attendee,
        attendees: [attendee], registrationMode: 'individual',
      });
      assert.equal(booking.response.success, true, JSON.stringify(booking.response));
      assert.equal(booking.bookings.length, 1);
      assert.equal(booking.bookings[0].ticket_class_id, null);
      assert.ok(!booking.calls.some(call => call.rpc?.includes('ticket_capacity')));
      assert.deepEqual(booking.unexpected, []);
    });
  }
}

test('legacy selectedTicketClassId alias and previously initialized default metadata normalize together', async () => {
  const harness = createLegacySimpleHarness();
  const payment = await harness.invoke('createStripePaymentIntent', {
    amount: 25, metadata: { event_id: 'event-a', ticket_class_id: 'default' },
  });
  const id = payment.response.paymentIntentId;
  harness.paymentIntents.get(id).metadata.ticket_class_id = 'default';
  const result = await harness.invoke('createOneOffEventBooking', {
    eventId: 'event-a', ticketsRequired: 1, totalCost: 25,
    selectedTicketClassId: 'default', paymentMethod: 'card', stripePaymentIntentId: id,
    isGuestBooking: true, guestInfo: attendee, attendees: [attendee],
  });
  assert.equal(result.response.success, true, JSON.stringify(result.response));
  assert.equal(result.bookings[0].ticket_class_id, null);
  assert.deepEqual(result.unexpected, []);
});

for (const configuredId of ['scheduled', 'default']) {
  test(`default cannot bypass authoritative configured future class ${configuredId}`, async () => {
    const harness = createLegacySimpleHarness({ event: { pricing_config: {
      ticket_classes: [{ id: configuredId, release_at: '2099-01-01T00:00:00Z', release_timezone: 'UTC' }],
    } } });
    const payment = await harness.invoke('createStripePaymentIntent', {
      amount: 25, metadata: { event_id: 'event-a', ticket_class_id: 'default' },
    });
    assert.match(payment.response.error, /Invalid ticket class|Tickets available from/);
    const booking = await harness.invoke('createOneOffEventBooking', {
      eventId: 'event-a', ticketsRequired: 1, totalCost: 0, selectedTicketClassId: 'default',
      paymentMethod: 'free', isGuestBooking: true, guestInfo: attendee, attendees: [attendee],
    });
    assert.match(booking.response.error, /Invalid ticket class|Tickets available from/);
    assert.equal(booking.bookings.length, 0);
    assert.ok(!booking.calls.some(call => call.provider || call.operation === 'insert' || call.operation === 'update' || call.rpc));
  });
}

test('legacy allowance is exactly default, simple-only, and does not trust serialized configured classes', () => {
  const event = { id: 'event', tenant_id: 'tenant' };
  assert.throws(() => assertSimpleTicketsReleased(event, ['forged']), /Invalid ticket class/);
  assert.throws(() => assertRequestedTicketsReleased({
    event, eventKind: 'complex', tickets: [], ticketIds: ['default'],
  }), /Invalid ticket class/);
  assert.throws(() => assertSimpleTicketsReleased({
    ...event, pricing_config: JSON.stringify({ ticket_classes: [{ id: 'future', release_at: '2099-01-01T00:00:00Z', release_timezone: 'UTC' }] }),
  }, ['default']), /Invalid ticket class/);
  for (const pricing_config of ['{broken', ' ']) {
    assert.throws(() => assertSimpleTicketsReleased({ ...event, pricing_config }, ['default']), /Unable to verify ticket availability/);
  }
});