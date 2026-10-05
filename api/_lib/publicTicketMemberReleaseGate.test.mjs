import test from 'node:test';
import assert from 'node:assert/strict';
import { gatePublicTicketMemberPolicy as gate } from './publicTicketMemberReleaseGate.js';

test('unmigrated provisioning fails closed across both event ticket stores', async () => {
  await assert.rejects(gate('Event', { pricing_config: { ticket_classes: [{ create_member_records: true }] } }), /not available yet/);
  for (const name of ['ComplexEventTicketClass', 'complex_event_ticket_class', 'complex-event-ticket-class']) {
    await assert.rejects(gate(name, { create_member_records: true }), /not available yet/);
    await assert.rejects(gate(name, [{ create_member_records: true }]), /not available yet/);
  }
});

test('ordinary saves remain compatible with an unmigrated complex-ticket table', async () => {
  const input = { name: 'Public', visibility_mode: 'public_only', create_member_records: false, new_member_role_id: null, role_ids: ['eligibility-role'] };
  assert.deepEqual(await gate('ComplexEventTicketClass', input), {
    name: 'Public', visibility_mode: 'public_only', role_ids: ['eligibility-role'],
  });
  assert.equal(input.create_member_records, false);
  assert.deepEqual(await gate('Member', input), input);
});

test('complete schema preserves enabling and explicit disabling; outages never silently drop writes', async () => {
  for (const enabled of [true, false]) {
    const body = { create_member_records: enabled, new_member_role_id: enabled ? 'role' : null };
    assert.deepEqual(await gate('ComplexEventTicketClass', body, { rpc: async () => ({ data: true }) }), body);
    await assert.rejects(gate('ComplexEventTicketClass', body, { rpc: async () => ({ error: { code: 'offline' } }) }), /Unable to verify/);
  }
});
