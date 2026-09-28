import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memberAiRequestHash,
  MEMBER_AI_DEFAULTS,
  reserveAdminMemberAiUsage,
  finishMemberAiUsage,
} from './memberAiUsage.js';

test('Member AI request hash normalizes whitespace/case without storing question text', () => {
  assert.equal(memberAiRequestHash('  HELLO  '), memberAiRequestHash('hello'));
  assert.match(memberAiRequestHash('private question'), /^[a-f0-9]{32}$/);
  assert.equal(MEMBER_AI_DEFAULTS.enabled, true);
});

test('admin previews reserve through a durable RPC and successful finish records token metering', async () => {
  const calls = [];
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ allowed: true, usage_id: 'usage-1' }], error: null };
    },
    from: (table) => {
      const query = {
        update: (value) => {
          calls.push({ table, value });
          return query;
        },
        eq: () => query,
      };
      return query;
    },
  };
  const reservation = await reserveAdminMemberAiUsage({
    supabase, tenantId: 'tenant-1', actorId: 'admin-1', question: 'How many members?',
  });
  assert.equal(reservation.usageKind, 'public');
  assert.equal(calls[0].name, 'claim_admin_member_ai_usage');
  assert.equal(calls[0].args.p_tenant_id, 'tenant-1');
  assert.match(calls[0].args.p_actor_hash, /^[a-f0-9]{48}$/);
  await finishMemberAiUsage({
    supabase, reservationId: 'usage-1', usageKind: reservation.usageKind,
    status: 'succeeded', inputTokens: 12, outputTokens: 8, providerRequestId: 'req_1',
  });
  assert.deepEqual(calls[1], {
    table: 'member_ai_public_usage_event',
    value: {
      status: 'succeeded',
      completed_at: calls[1].value.completed_at,
      input_tokens: 12,
      output_tokens: 8,
      provider_request_id: 'req_1',
    },
  });
});