import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  paymentIntentMatchesAllocation,
  refundBoundAllocationPayment,
  runAuthorizedCardCompensation,
} from '../../_lib/allocationPaymentBinding.js';

test('mixed complex checkout prices exactly one allocated ticket and stamps safe binding metadata', async () => {
  const source = await readFile(fileURLToPath(new URL('../complex-event-payment-intent.js', import.meta.url)), 'utf8');
  assert.match(source, /resolveAllocationInvitation/);
  assert.match(source, /allocationCovered \? 0 : ticket\.price/);
  assert.match(source, /covered\.length !== 1 \|\| covered\[0\]\.attendee_count !== 1/);
  assert.match(source, /metadata\.allocation_invitation_id = allocationContext\.invitationId/);
  assert.doesNotMatch(source, /metadata\.allocation_invitation_token/);
});

test('complex booking rejects mismatched binding without refunding it', async () => {
  const source = await readFile(fileURLToPath(new URL('../complex-event-booking.js', import.meta.url)), 'utf8');
  assert.match(source, /paymentIntentMatchesAllocation\(paymentIntent, allocationContext\)/);
  assert.doesNotMatch(source, /if \(!allocationMetadataMatches\) \{[\s\S]{0,100}refundInvalidIntent/);
  assert.match(source, /\|\| !cardPaymentAuthorizedForCompensation/);
  assert.match(source, /complex-booking-invalid:/);
});

test('refund gate never refunds arbitrary or mismatched intents', async () => {
  const context = {
    invitationId: 'invite-1', tenantId: 'tenant-1', eventId: 'event-1',
    ticketTypeId: 'ticket-1', delegateEmail: 'delegate@example.com',
  };
  let refunds = 0;
  const refund = async () => { refunds += 1; };
  assert.equal(await refundBoundAllocationPayment({ status: 'succeeded', metadata: {} }, context, refund), false);
  assert.equal(await refundBoundAllocationPayment({
    status: 'succeeded',
    metadata: {
      type: 'complex_event_booking', allocation_invitation_id: 'other',
      tenant_id: 'tenant-1', allocation_event_id: 'event-1',
      allocation_ticket_type_id: 'ticket-1', allocation_delegate_email: 'delegate@example.com',
    },
  }, context, refund), false);
  assert.equal(refunds, 0);
});

test('exact allocation binding permits post-binding compensation once', async () => {
  const context = {
    invitationId: 'invite-1', tenantId: 'tenant-1', eventId: 'event-1',
    ticketTypeId: 'ticket-1', delegateEmail: 'delegate@example.com',
  };
  const paymentIntent = { status: 'succeeded', metadata: {
    type: 'complex_event_booking', allocation_invitation_id: 'invite-1',
    tenant_id: 'tenant-1', allocation_event_id: 'event-1',
    allocation_ticket_type_id: 'ticket-1', allocation_delegate_email: 'delegate@example.com',
  } };
  let refunds = 0;
  assert.equal(paymentIntentMatchesAllocation(paymentIntent, context), true);
  assert.equal(await refundBoundAllocationPayment(paymentIntent, context, async () => { refunds += 1; }), true);
  assert.equal(refunds, 1);
});

test('ordinary card compensation runs only after authoritative verification', async () => {
  let refunds = 0;
  const refund = async () => { refunds += 1; return true; };
  assert.equal(await runAuthorizedCardCompensation(false, refund), false);
  assert.equal(refunds, 0);
  assert.equal(await runAuthorizedCardCompensation(true, refund), true);
  assert.equal(refunds, 1);

  const booking = await readFile(fileURLToPath(new URL('../complex-event-booking.js', import.meta.url)), 'utf8');
  assert.ok(booking.indexOf("if (intentCurrency !== firstCurrency.toLowerCase())")
    < booking.indexOf('cardPaymentAuthorizedForCompensation = !allocationContext'));
  assert.ok(booking.indexOf('const piEventId = paymentIntent.metadata?.event_id')
    < booking.indexOf('cardPaymentAuthorizedForCompensation = !allocationContext'));
});