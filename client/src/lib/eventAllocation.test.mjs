import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationCartUnitPrice, allocationPlacesAvailable, allocationRegistrationUrl, normalizeAllocationContext } from './eventAllocation.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('normalizes allocation total view payloads', () => {
  const result = normalizeAllocationContext({
    allocation_id: 'a1', event_reference_kind: 'complex', event_snapshot: { slug: 'summit', title: 'Summit' },
    ticket_snapshot: { id: 't1', name: 'Delegate' }, allocated: 10, named: 3, reserved: 2, released: 1, remaining: 9,
  });
  assert.equal(result.eventName, 'Summit');
  assert.equal(result.registered, 3);
  assert.equal(allocationPlacesAvailable(result), 4);
  assert.equal(allocationRegistrationUrl(result, 'signed'), '/session-events/summit?allocation=signed');
});

test('requires both signed context and event for handoff', () => {
  assert.equal(allocationRegistrationUrl({ event_slug: 'event' }), null);
  assert.equal(allocationRegistrationUrl({ context_token: 'token' }), null);
});

test('uses id-based route when snapshots have no slug', () => {
  assert.equal(
    allocationRegistrationUrl({ eventKind: 'simple', eventId: 'event-id' }, 'signed'),
    '/EventDetails?id=event-id&allocation=signed',
  );
});

test('complex allocation mode exposes a mixed cart and zeroes only its covered ticket', async () => {
  const context = { ticketTypeId: 'allocated' };
  const cart = [
    { id: 'allocated', price: 125, count: 1 },
    { id: 'workshop', price: 40, count: 2 },
  ];
  const total = cart.reduce((sum, item) => (
    sum + allocationCartUnitPrice(item.id, item.price, context) * item.count
  ), 0);
  assert.equal(total, 80);

  const page = await readFile(fileURLToPath(new URL('../pages/ComplexEventDetail.jsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(page, /return ticketClasses\.filter\(\(ticket\) => String\(ticket\.id\) === allocationContext\.ticketTypeId\)/);
  assert.match(page, /String\(tc\.id\) === String\(allocationContext\.ticketTypeId\)\) return true/);
  assert.match(page, /allocationCartUnitPrice/);
  assert.match(page, /String\(ticketClassId\) === String\(allocationContext\.ticketTypeId\)\) return/);
});