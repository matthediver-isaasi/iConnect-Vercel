import test from 'node:test';
import assert from 'node:assert/strict';
import { privateTicketVisible, reconcilePrivateCart, mergeAllocationTicket } from './privateTicketAudience.js';
import { updateTicketMemberField, ticketMemberPolicy } from './publicTicketMembers.js';

test('private selection clears incompatible modes and switching away explicitly clears IDs', () => {
  const input = { role_ids: ['role'], member_group_ids: ['group'], role_match_only: true, visibility_mode: 'public_only', create_member_records: true, new_member_role_id: 'role' };
  const selected = updateTicketMemberField(input, 'audience_mode', 'selected_members');
  assert.deepEqual(selected.role_ids, []);
  assert.deepEqual(selected.member_group_ids, []);
  assert.equal(selected.visibility_mode, 'members_only');
  assert.equal(selected.create_member_records, false);
  assert.equal(selected.new_member_role_id, null);
  assert.equal(selected.role_match_only, false);
  for (const field of ['audience_mode', 'role_ids', 'member_group_ids', 'visibility_mode']) {
    const next = updateTicketMemberField({ ...selected, selected_member_ids: ['member'] }, field, field === 'audience_mode' ? 'legacy' : []);
    assert.equal(next.audience_mode, 'legacy');
    assert.deepEqual(next.selected_member_ids, []);
  }
  assert.equal(ticketMemberPolicy(selected).audience_mode, 'selected_members');
});

test('only server eligibility reveals private tickets, never a client allowlist', () => {
  const ticket = { id: 'private', audience_mode: 'selected_members', selected_member_ids: ['member'] };
  assert.equal(privateTicketVisible(ticket, { id: 'member' }), false);
  assert.equal(privateTicketVisible({ ...ticket, private_ticket_eligible: true }, null), false);
  assert.equal(privateTicketVisible({ ...ticket, private_ticket_eligible: true }, { id: 'member' }), true);
  assert.equal(privateTicketVisible({ id: 'legacy' }, null), true);
});

test('session reconciliation removes invalid private entries only; independent siblings survive', () => {
  const privateTicket = { id: 'private', audience_mode: 'selected_members', private_ticket_eligible: true };
  const sibling = { id: 'sibling' };
  const cart = { private: { ticketClass: privateTicket, attendees: [{}] }, sibling: { ticketClass: sibling, attendees: [{}] } };
  assert.equal(reconcilePrivateCart(cart, [privateTicket, sibling], { id: 'member' }), cart);
  assert.deepEqual(Object.keys(reconcilePrivateCart(cart, [privateTicket, sibling], null)), ['sibling']);
  assert.deepEqual(Object.keys(reconcilePrivateCart(cart, [sibling], { id: 'another' })), ['sibling']);
  assert.deepEqual(Object.keys(reconcilePrivateCart(cart, [], null)), ['sibling']);
});

test('allocation merge requires the exact server-marked fixed ticket', () => {
  const ticket = { id: 'private', audience_mode: 'selected_members', allocation_ticket_eligible: true };
  const context = { ticketTypeId: 'private' };
  assert.deepEqual(mergeAllocationTicket([], { ticket_class: ticket }, context), [ticket]);
  assert.deepEqual(mergeAllocationTicket([], { ticket_class: { ...ticket, allocation_ticket_eligible: false } }, context), []);
  assert.deepEqual(mergeAllocationTicket([], { ticket_class: ticket }, { ticketTypeId: 'other' }), []);
  assert.deepEqual(mergeAllocationTicket([], { ticket_class: ticket }, null), []);
  const cart = { private: { ticketClass: ticket, attendees: [{}] } };
  assert.equal(reconcilePrivateCart(cart, [ticket], null, context), cart);
  assert.deepEqual(reconcilePrivateCart(cart, [ticket], null), {});
});
