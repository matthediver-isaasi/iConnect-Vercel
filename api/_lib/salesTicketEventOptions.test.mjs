import test from 'node:test';
import assert from 'node:assert/strict';
import { listSalesTicketEventOptions, assertSalesTicketEventSelectable } from './salesTicketEventOptions.js';

const eventId = '00000000-0000-4000-8000-000000000001';
test('discovery sends bounded literal search and only the authorised tenant to its service RPC', async () => {
  const calls = [];
  const result = { items: [], hasMore: false, page: 10000 };
  const db = { async rpc(name, args) { calls.push({ name, args }); return { data: result }; } };
  assert.equal(await listSalesTicketEventOptions(db, 'tenant', { search: '  A.*%_  ', page: '999999' }), result);
  assert.deepEqual(calls[0], { name: 'sales_ticket_event_options', args: {
    p_tenant: 'tenant', p_search: 'A.*%_', p_page: 10000, p_selected: null, p_kind: null,
  } });
  await listSalesTicketEventOptions(db, 'tenant', { selectedId: eventId, kind: 'complex' });
  assert.equal(calls[1].args.p_selected, eventId);
  assert.equal(calls[1].args.p_kind, 'complex');
  await assert.rejects(listSalesTicketEventOptions(db, 'tenant', { selectedId: eventId, kind: 'invalid' }), /Invalid selected event/);
  await assert.rejects(listSalesTicketEventOptions(db, 'tenant', { selectedId: 'bad', kind: 'simple' }), /Invalid selected event/);
});

test('missing migration and provider errors fail explicitly rather than showing a false empty list', async () => {
  await assert.rejects(listSalesTicketEventOptions({ rpc: async () => ({ error: { code: 'PGRST202' } }) }, 'tenant'),
    error => error.status === 503 && /database update/.test(error.message));
  const error = new Error('database unavailable');
  await assert.rejects(listSalesTicketEventOptions({ rpc: async () => ({ error }) }, 'tenant'), error);
  await assert.rejects(listSalesTicketEventOptions({ rpc: async () => ({ data: null }) }, 'tenant'), /unavailable/);
});

test('new saved references must still have an eligible event and ticket', async () => {
  const reference = { eventId, kind: 'simple', ticketTypeId: 'standard' };
  const db = items => ({ rpc: async () => ({ data: { items } }) });
  await assert.rejects(assertSalesTicketEventSelectable(db([]), 'tenant', reference), /Choose a future event/);
  await assert.rejects(assertSalesTicketEventSelectable(db([{ eligible: false, unavailableReason: 'Waiting list.' }]), 'tenant', reference), /Waiting list/);
  await assert.rejects(assertSalesTicketEventSelectable(db([{ eligible: true, ticketOptions: [] }]), 'tenant', reference), /ticket type/);
  await assertSalesTicketEventSelectable(db([{ eligible: true, ticketOptions: [{ id: 'standard' }] }]), 'tenant', reference);
});
