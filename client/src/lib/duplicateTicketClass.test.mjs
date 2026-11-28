import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTicketClass, duplicateTicketName, insertDuplicateTicket } from './duplicateTicketClass.js';

test('a simple-event copy keeps settings but gets a new identity and is never the default', () => {
  const original = { id: 'ticket-1', name: 'Monday Non-member', price: '120', is_default: true,
    role_ids: ['r1'], _releaseError: 'x' };
  const copy = duplicateTicketClass(original, { idKey: 'id', newId: 'ticket-2', existingTickets: [original] });
  assert.deepEqual(copy, { id: 'ticket-2', name: 'Monday Non-member (copy)', price: '120', is_default: false, role_ids: ['r1'] });
  copy.role_ids.push('r2');
  assert.deepEqual(original.role_ids, ['r1']);
});

test('a complex-event copy drops the saved record id so saving creates a new ticket', () => {
  const original = { _localId: 'db-1', _dbId: 'db-1', name: 'Tuesday', all_tracks: false, linked_track_ids: ['t2'] };
  const copy = duplicateTicketClass(original, { idKey: '_localId', newId: 'local-9', existingTickets: [original] });
  assert.equal(copy._dbId, undefined);
  assert.equal(copy._localId, 'local-9');
  assert.deepEqual(copy.linked_track_ids, ['t2']);
});

test('copy names stay unique and the copy sits after its original', () => {
  assert.equal(duplicateTicketName('Day', ['Day', 'Day (copy)']), 'Day (copy 2)');
  assert.equal(duplicateTicketName('', []), 'Ticket (copy)');
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(insertDuplicateTicket(list, 'a', 'id', { id: 'c' }).map(t => t.id), ['a', 'c', 'b']);
});
