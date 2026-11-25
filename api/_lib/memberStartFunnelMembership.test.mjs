import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStartService } from './memberStart.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = { id: id(2), tenant_id: id(3), name: 'Individual', structure_scope_type: 'member', is_active: true, billing_period: 'annual',
  start_mode: 'immediate', effective_from: '2025-01-01', currency: 'GBP', pricing_model: 'flat', flat_cost: 120 };
const benefit = { id: id(9), order_id: id(8), schedule_id: id(2), scope: 'member', benefit_snapshot: { scheduleName: 'Individual' } };

function service(pending, enabled = true) {
  const rpcs = [];
  const db = {
    async rpc(name, args) {
      rpcs.push(name);
      if (name === 'member_start_state') return { data: { member: { id: id(1), first_name: 'A', last_name: 'B', email: 'a@example.test' }, blockers: [], fingerprint: 'state' } };
      if (name === 'member_start_payment_capabilities') return { data: { version: 1, noCharge: true } };
      if (name === 'pending_event_funnel_membership') {
        assert.deepEqual(args, { p_tenant: id(3), p_scope: 'member', p_recipient: id(1), p_schedule: id(2) });
        return { data: pending };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table) {
      const q = { select: () => q, eq: () => q, order: () => q,
        range: async () => ({ data: [] }),
        maybeSingle: async () => ({ data: table === 'membership_tier_config' ? config : null }) };
      return q;
    },
  };
  return { rpcs, start: createMemberStartService({ db, now: () => new Date('2026-03-01T10:00:00Z'), queueEnabled: () => false,
    stripeCredentials: async () => null, ddCredentials: async () => null, funnelMemberships: () => enabled }) };
}
const input = mode => ({ memberId: id(1), configId: id(2), bandId: null, startDate: '2026-03-01', reason: 'Explicit start', paymentMode: mode });

test('No charge Start carries the unused event booking benefit so the history insert is accepted', async () => {
  const { start } = service(benefit);
  const result = await start.preview(id(3), input('free'));
  assert.equal(result.canCreate, true, result.blockers?.join(' '));
  assert.equal(result.quote.totalWithVat, 0);
  assert.deepEqual(result.quote.funnelMembership, { entitlementId: id(9), scheduleId: id(2), scope: 'member', orderId: id(8),
    scheduleName: 'Individual', originalBaseNetMinor: 12000, originalBaseVatMinor: 0 });
});

test('payable Start modes are refused while a complimentary benefit covers the base fee', async () => {
  const { start } = service(benefit);
  const result = await start.preview(id(3), input('invoice'));
  assert.equal(result.canCreate, false);
  assert.match(result.blockers[0], /Choose No charge/);
});

test('no benefit, or rollout disabled, leaves Start unchanged', async () => {
  const none = await service(null).start.preview(id(3), input('free'));
  assert.equal(none.quote.funnelMembership, undefined);
  const off = service(benefit, false);
  const disabled = await off.start.preview(id(3), input('free'));
  assert.equal(disabled.quote.funnelMembership, undefined);
  assert.ok(!off.rpcs.includes('pending_event_funnel_membership'));
});
